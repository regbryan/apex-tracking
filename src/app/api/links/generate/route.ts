import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateToken } from '@/lib/token'
import { validateBearerToken } from '@/lib/auth'

interface UtmFields {
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null
}

interface Recipient {
  contact_id?: string
  lead_id?: string
  account_id?: string
  campaign_member_id?: string
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const

function extractUtmsFromUrl(url: string | null | undefined): UtmFields {
  const empty: UtmFields = {
    utm_source: null, utm_medium: null, utm_campaign: null,
    utm_term: null, utm_content: null,
  }
  if (!url) return empty
  try {
    const params = new URL(url).searchParams
    return {
      utm_source: params.get('utm_source'),
      utm_medium: params.get('utm_medium'),
      utm_campaign: params.get('utm_campaign'),
      utm_term: params.get('utm_term'),
      utm_content: params.get('utm_content'),
    }
  } catch {
    return empty
  }
}

function mergeUtms(fromBody: Partial<Record<typeof UTM_KEYS[number], unknown>> | undefined, fromUrl: UtmFields): UtmFields {
  const result: UtmFields = { ...fromUrl }
  if (!fromBody || typeof fromBody !== 'object') return result
  for (const key of UTM_KEYS) {
    const v = fromBody[key]
    if (typeof v === 'string' && v !== '') {
      result[`utm_${key}` as keyof UtmFields] = v
    }
  }
  return result
}

// Normalize an unknown payload entry into a clean Recipient. Returns null if invalid.
// A recipient must carry at least one identifier; otherwise the click can't be attributed.
function normalizeRecipient(raw: unknown): Recipient | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pick = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() !== '') ? (r[k] as string).trim() : undefined
  const recipient: Recipient = {
    contact_id: pick('contact_id'),
    lead_id: pick('lead_id'),
    account_id: pick('account_id'),
    campaign_member_id: pick('campaign_member_id'),
  }
  const hasAnyId =
    recipient.contact_id || recipient.lead_id || recipient.account_id || recipient.campaign_member_id
  return hasAnyId ? recipient : null
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!validateBearerToken(authHeader, process.env.API_LINKS_SECRET!)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { campaign_id, destination_url, file_url, member_ids, recipients, utm } = body as {
    campaign_id?: string
    destination_url?: string | null
    file_url?: string | null
    member_ids?: unknown
    recipients?: unknown
    utm?: Partial<Record<typeof UTM_KEYS[number], unknown>>
  }

  // Exactly one of destination_url or file_url must be set
  const hasDestination = destination_url != null && destination_url !== ''
  const hasFile = file_url != null && file_url !== ''
  if ((hasDestination && hasFile) || (!hasDestination && !hasFile)) {
    return new NextResponse('Provide exactly one of destination_url or file_url', { status: 400 })
  }

  // Two accepted shapes: legacy `member_ids` (CampaignMember-only) or new `recipients` (flexible identity).
  // Both can't be provided together — pick one.
  const usingMembers = Array.isArray(member_ids) && member_ids.length > 0
  const usingRecipients = Array.isArray(recipients) && recipients.length > 0
  if (usingMembers && usingRecipients) {
    return new NextResponse('Provide either member_ids or recipients, not both', { status: 400 })
  }
  if (!usingMembers && !usingRecipients) {
    return new NextResponse('Missing required field: member_ids or recipients', { status: 400 })
  }

  // Legacy path requires campaign_id (matches prior behavior). New `recipients` path makes campaign_id optional —
  // tracked links can exist outside any campaign context (e.g., post-conversion outreach).
  if (usingMembers && !campaign_id) {
    return new NextResponse('Missing required field: campaign_id', { status: 400 })
  }

  // Build the normalized recipient list
  let resolved: Recipient[]
  if (usingMembers) {
    if ((member_ids as unknown[]).some((id) => typeof id !== 'string' || (id as string).trim() === '')) {
      return NextResponse.json({ error: 'All member_ids must be non-empty strings' }, { status: 400 })
    }
    resolved = (member_ids as string[]).map((id) => ({ campaign_member_id: id }))
  } else {
    const normalized = (recipients as unknown[]).map(normalizeRecipient)
    if (normalized.some((r) => r === null)) {
      return NextResponse.json(
        { error: 'Each recipient must have at least one of contact_id, lead_id, account_id, campaign_member_id' },
        { status: 400 }
      )
    }
    resolved = normalized as Recipient[]
  }

  const baseUrl = process.env.LINK_BASE_URL!
  const endpoint = hasFile ? 'download' : 'track'

  const sourceUrl = hasDestination ? destination_url! : file_url!
  const utms = mergeUtms(utm, extractUtmsFromUrl(sourceUrl))

  // One row per recipient. member_id column kept populated from campaign_member_id for backward compat
  // until that column is dropped in a future migration.
  const rows = resolved.map((r) => ({
    token: generateToken(),
    campaign_id: campaign_id ?? null,
    member_id: r.campaign_member_id ?? null,
    contact_id: r.contact_id ?? null,
    lead_id: r.lead_id ?? null,
    account_id: r.account_id ?? null,
    destination_url: hasDestination ? destination_url : null,
    file_url: hasFile ? file_url : null,
    ...utms,
  }))

  const { error } = await supabase.from('tracked_links').insert(rows)

  if (error) {
    console.error('[generate] Failed to insert tracked links:', error.message)
    return new NextResponse('Internal server error', { status: 500 })
  }

  // Result shape: legacy callers (member_ids) get the same `member_id` field they always did.
  // New callers (recipients) get the recipient identifiers echoed back so they can correlate.
  const result = rows.map((row) => {
    const tracked_url = `${baseUrl}/api/${endpoint}?t=${row.token}`
    if (usingMembers) {
      return { member_id: row.member_id, tracked_url }
    }
    return {
      contact_id: row.contact_id,
      lead_id: row.lead_id,
      account_id: row.account_id,
      campaign_member_id: row.member_id,
      tracked_url,
    }
  })

  return NextResponse.json(result)
}
