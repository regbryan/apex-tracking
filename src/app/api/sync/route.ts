import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { validateBearerToken } from '@/lib/auth'
import {
  getSalesforceToken,
  buildAccountSignalRecords,
  upsertAccountSignals,
  TrackingEventForSignal,
} from '@/lib/salesforce'
import { randomUUID } from 'crypto'

const LOCK_TIMEOUT_MINUTES = 10

// Shape of a single tracking_events row joined with its parent tracked_links for UTMs.
// Supabase returns the joined relation as a nested object (or array, depending on cardinality);
// for a many-to-one FK like this, it's a single object — but the typings allow null/array,
// so the code below handles both defensively.
interface JoinedEventRow {
  id: string
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  campaign_id: string | null
  event_type: 'click' | 'pageview' | 'download'
  created_at: string
  sequence_id: number
  tracked_links: {
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_term: string | null
    utm_content: string | null
  } | null | Array<{
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_term: string | null
    utm_content: string | null
  }>
}

function flattenUtms(linkRel: JoinedEventRow['tracked_links']) {
  const empty = {
    utm_source: null, utm_medium: null, utm_campaign: null,
    utm_term: null, utm_content: null,
  }
  if (!linkRel) return empty
  return Array.isArray(linkRel) ? (linkRel[0] ?? empty) : linkRel
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

    // --- Step 3: Fetch new events with their parent tracked_links UTMs ---
    // Filter to events with a resolved account_id — Account_Signal__c.Account__c is master-detail
    // required, so events without account_id can't become signals. They stay in Supabase but
    // are skipped from sync. The cursor still advances past them so we don't replay forever.
    const { data: newEvents, error: eventsError } = await supabase
      .from('tracking_events')
      .select(`
        id, account_id, contact_id, lead_id, campaign_id,
        event_type, created_at, sequence_id,
        tracked_links ( utm_source, utm_medium, utm_campaign, utm_term, utm_content )
      `)
      .gt('sequence_id', lastSequenceId) as { data: JoinedEventRow[] | null, error: any }

    if (eventsError) throw new Error(`Events query failed: ${eventsError.message}`)

    if (!newEvents || newEvents.length === 0) {
      await writeSyncLog(0, lastSequenceId, 'success', [])
      result = NextResponse.json({ records_processed: 0 })
      return result
    }

    const maxSequenceId = Math.max(...newEvents.map((e) => e.sequence_id))

    // Filter to events that can become signals (must have account_id)
    const syncable: TrackingEventForSignal[] = newEvents
      .filter((e) => e.account_id)
      .map((e) => {
        const utms = flattenUtms(e.tracked_links)
        return {
          event_id: e.id,
          account_id: e.account_id!,
          contact_id: e.contact_id,
          lead_id: e.lead_id,
          campaign_id: e.campaign_id,
          event_type: e.event_type,
          created_at: e.created_at,
          utm_source: utms.utm_source,
          utm_medium: utms.utm_medium,
          utm_campaign: utms.utm_campaign,
          utm_term: utms.utm_term,
          utm_content: utms.utm_content,
        }
      })

    if (syncable.length === 0) {
      // Advance the cursor past these unsyncable events so we don't reprocess them every run
      await writeSyncLog(0, maxSequenceId, 'success', [])
      result = NextResponse.json({ records_processed: 0, skipped: newEvents.length })
      return result
    }

    // --- Step 4: Upsert to Salesforce ---
    const sfToken = await getSalesforceToken({
      clientId: process.env.SF_CLIENT_ID!,
      clientSecret: process.env.SF_CLIENT_SECRET!,
      instanceUrl: process.env.SF_INSTANCE_URL!,
    })

    const records = buildAccountSignalRecords(syncable)
    const { failedExternalIds } = await upsertAccountSignals(
      records,
      sfToken,
      process.env.SF_API_VERSION ?? 'v59.0'
    )

    const status = failedExternalIds.length === 0 ? 'success' : 'partial'
    await writeSyncLog(syncable.length, maxSequenceId, status, failedExternalIds)

    result = NextResponse.json({
      records_processed: syncable.length,
      skipped: newEvents.length - syncable.length,
      failed_count: failedExternalIds.length,
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

async function writeSyncLog(
  recordsProcessed: number,
  lastSequenceId: number,
  status: 'success' | 'partial' | 'failed',
  failedExternalIds: string[],
  errorDetail?: string
) {
  const { error } = await supabase.from('sync_log').insert([
    {
      records_processed: recordsProcessed,
      last_sequence_id: lastSequenceId,
      status,
      failed_member_ids: failedExternalIds.length > 0 ? failedExternalIds : null,
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
