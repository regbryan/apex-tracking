import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { validateBearerToken } from '@/lib/auth'
import {
  getSalesforceToken,
  buildCompositeUpdateRecords,
  batchUpdateCampaignMembers,
  MemberAggregate,
} from '@/lib/salesforce'
import { randomUUID } from 'crypto'

const LOCK_TIMEOUT_MINUTES = 10

interface TrackingEventRow {
  member_id: string
  campaign_id: string
  event_type: 'click' | 'pageview' | 'download'
  page_url: string | null
  file_name: string | null
  created_at: string
  sequence_id: number
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!validateBearerToken(authHeader, process.env.CRON_SECRET!)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const runId = randomUUID()

  // --- Step 1: Acquire lock (self-healing: expire locks older than 10 minutes) ---
  const lockCutoff = new Date(Date.now() - LOCK_TIMEOUT_MINUTES * 60 * 1000).toISOString()
  const { data: lockAcquired } = await supabase
    .from('sync_locks')
    .update({ locked_at: new Date().toISOString(), locked_by: runId })
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .select()

  if (!lockAcquired || lockAcquired.length === 0) {
    return NextResponse.json({ message: 'Sync already locked — skipping' }, { status: 200 })
  }

  let lastSequenceId = 0
  let result: ReturnType<typeof NextResponse.json> | null = null

  try {
    // --- Step 2: Get last sync cursor ---
    const { data: lastLog } = await supabase
      .from('sync_log')
      .select('last_sequence_id')
      .order('synced_at', { ascending: false })
      .limit(1)
      .single()

    lastSequenceId = lastLog?.last_sequence_id ?? 0

    // --- Step 3: Fetch new events ---
    const { data: newEvents, error: eventsError } = await supabase
      .from('tracking_events')
      .select('member_id, campaign_id, event_type, page_url, file_name, created_at, sequence_id')
      .gt('sequence_id', lastSequenceId) as { data: TrackingEventRow[] | null, error: any }

    if (eventsError) throw new Error(`Events query failed: ${eventsError.message}`)

    if (!newEvents || newEvents.length === 0) {
      await writeSyncLog(0, lastSequenceId, 'success', [])
      result = NextResponse.json({ records_processed: 0 })
      return result
    }

    const maxSequenceId = Math.max(...newEvents.map((e) => e.sequence_id))

    // --- Step 4: Aggregate per member ---
    const affectedMemberIds = [...new Set(newEvents.map((e) => e.member_id))]
    const aggregates = await buildAggregates(affectedMemberIds, newEvents)

    // --- Step 5: Sync to Salesforce ---
    const sfToken = await getSalesforceToken({
      clientId: process.env.SF_CLIENT_ID!,
      clientSecret: process.env.SF_CLIENT_SECRET!,
      instanceUrl: process.env.SF_INSTANCE_URL!,
    })

    const records = buildCompositeUpdateRecords(aggregates)
    const { failedIds } = await batchUpdateCampaignMembers(
      records,
      sfToken,
      process.env.SF_API_VERSION ?? 'v59.0'
    )

    const status = failedIds.length === 0 ? 'success' : 'partial'
    await writeSyncLog(aggregates.length, maxSequenceId, status, failedIds)

    result = NextResponse.json({
      records_processed: aggregates.length,
      failed_count: failedIds.length,
      status,
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeSyncLog(0, lastSequenceId, 'failed', [], message)
    result = NextResponse.json({ error: message }, { status: 500 })
    return result
  } finally {
    // IMPORTANT: releaseLock() is in finally — it runs on success, error, AND any unhandled throw.
    // Do NOT move this into try or catch only — either path could skip it if an exception occurs.
    await releaseLock(runId)
  }
}

async function buildAggregates(
  memberIds: string[],
  newEvents: TrackingEventRow[]
): Promise<MemberAggregate[]> {
  // Unique Clicks requires ALL historical click events (not just new batch) to compute
  // accurate distinct-day counts across sync windows. Fetch all click events for affected members.
  const { data: allClickEvents } = await supabase
    .from('tracking_events')
    .select('member_id, created_at')
    .in('member_id', memberIds)
    .eq('event_type', 'click')

  const allClicksByMember: Record<string, { member_id: string; created_at: string }[]> = {}
  for (const e of allClickEvents ?? []) {
    if (!allClicksByMember[e.member_id]) allClicksByMember[e.member_id] = []
    allClicksByMember[e.member_id].push(e)
  }

  return memberIds.map((memberId) => {
    const memberEvents = newEvents.filter((e) => e.member_id === memberId)
    const clickEvents = memberEvents.filter((e) => e.event_type === 'click')
    const pageviewEvents = memberEvents.filter((e) => e.event_type === 'pageview')
    const downloadEvents = memberEvents.filter((e) => e.event_type === 'download')

    // Unique clicks = distinct UTC calendar days across ALL historical clicks (not just new batch)
    // This correctly handles clicks that span multiple sync windows on the same calendar day.
    const allMemberClicks = allClicksByMember[memberId] ?? []
    const uniqueDays = new Set(
      allMemberClicks.map((e) =>
        new Date(e.created_at).toISOString().split('T')[0]
      )
    )

    const sortedClicks = clickEvents.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )

    const pageUrls = [
      ...new Set(
        [...clickEvents, ...pageviewEvents]
          .map((e) => e.page_url)
          .filter(Boolean)
      ),
    ].slice(0, 100)

    const fileNames = [
      ...new Set(downloadEvents.map((e) => e.file_name).filter(Boolean)),
    ].slice(0, 100)

    const lastPageview = pageviewEvents.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]

    const lastDownload = downloadEvents.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]

    return {
      member_id: memberId,
      total_clicks: clickEvents.length,
      unique_clicks: uniqueDays.size,
      first_click_date: sortedClicks[0]?.created_at ?? null,
      last_click_date: sortedClicks[sortedClicks.length - 1]?.created_at ?? null,
      last_pageview_date: lastPageview?.created_at ?? null,
      last_download_date: lastDownload?.created_at ?? null,
      pages_visited: pageUrls.join(','),
      downloads: fileNames.join(','),
    }
  })
}

async function writeSyncLog(
  recordsProcessed: number,
  lastSequenceId: number,
  status: 'success' | 'partial' | 'failed',
  failedMemberIds: string[],
  errorDetail?: string
) {
  const { error } = await supabase.from('sync_log').insert([
    {
      records_processed: recordsProcessed,
      last_sequence_id: lastSequenceId,
      status,
      failed_member_ids: failedMemberIds.length > 0 ? failedMemberIds : null,
      error_detail: errorDetail ?? null,
    },
  ])
  if (error) {
    console.error('[sync] Failed to write sync_log:', error.message)
  }
}

async function releaseLock(runId: string) {
  const result = await supabase
    .from('sync_locks')
    .update({ locked_at: null, locked_by: null })
    .eq('locked_by', runId)
  if (result.error) {
    console.error('[sync] Failed to release lock:', result.error.message)
  }
}
