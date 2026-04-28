export interface SFTokenConfig {
  clientId: string
  clientSecret: string
  instanceUrl: string
}

export interface SFToken {
  access_token: string
  instance_url: string
}

// One row per tracking_events record, joined with its parent tracked_links UTMs.
// Only events with a resolved account_id can be turned into signals — Account__c is
// master-detail required on the Salesforce side.
export interface TrackingEventForSignal {
  event_id: string
  account_id: string
  contact_id: string | null
  lead_id: string | null
  campaign_id: string | null
  event_type: 'click' | 'pageview' | 'download'
  created_at: string
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null
}

export interface AccountSignalRecord {
  attributes: { type: 'Account_Signal__c' }
  External_Id__c: string
  Account__c: string
  Signal_Type__c: 'outreach_click' | 'web_visit' | 'content_download'
  Source_System__c: 'ApexTracking'
  Captured_At__c: string
  Related_Contact__c?: string
  Related_Lead__c?: string
  Related_Campaign__c?: string
  UTM_Source__c?: string
  UTM_Medium__c?: string
  UTM_Campaign__c?: string
  UTM_Term__c?: string
  UTM_Content__c?: string
}

const EVENT_TO_SIGNAL: Record<TrackingEventForSignal['event_type'], AccountSignalRecord['Signal_Type__c']> = {
  click: 'outreach_click',
  pageview: 'web_visit',
  download: 'content_download',
}

export async function getSalesforceToken(config: SFTokenConfig): Promise<SFToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  const response = await fetch(`${config.instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Salesforce token error: ${text}`)
  }

  return response.json()
}

export function buildAccountSignalRecords(events: TrackingEventForSignal[]): AccountSignalRecord[] {
  return events.map((e) => {
    const record: AccountSignalRecord = {
      attributes: { type: 'Account_Signal__c' },
      External_Id__c: e.event_id,
      Account__c: e.account_id,
      Signal_Type__c: EVENT_TO_SIGNAL[e.event_type],
      Source_System__c: 'ApexTracking',
      Captured_At__c: e.created_at,
    }
    // Optional lookups: only emit when populated. Salesforce treats explicit nulls as
    // intentional clears, which is fine on insert but noisy on upsert — omit instead.
    if (e.contact_id) record.Related_Contact__c = e.contact_id
    if (e.lead_id) record.Related_Lead__c = e.lead_id
    if (e.campaign_id) record.Related_Campaign__c = e.campaign_id
    if (e.utm_source) record.UTM_Source__c = e.utm_source
    if (e.utm_medium) record.UTM_Medium__c = e.utm_medium
    if (e.utm_campaign) record.UTM_Campaign__c = e.utm_campaign
    if (e.utm_term) record.UTM_Term__c = e.utm_term
    if (e.utm_content) record.UTM_Content__c = e.utm_content
    return record
  })
}

// Upsert Account_Signal__c records by External_Id__c (the Supabase tracking_events.id UUID).
// Idempotency comes from the External_Id__c unique constraint — re-running a sync window is safe.
// The composite/sobjects upsert endpoint accepts up to 200 records per call.
export async function upsertAccountSignals(
  records: AccountSignalRecord[],
  token: SFToken,
  apiVersion: string
): Promise<{ failedExternalIds: string[] }> {
  const failedExternalIds: string[] = []
  const BATCH_SIZE = 200

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)

    const response = await fetch(
      `${token.instance_url}/services/data/${apiVersion}/composite/sobjects/Account_Signal__c/External_Id__c`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ allOrNone: false, records: batch }),
      }
    )

    if (!response.ok) {
      // Entire batch failed at the HTTP layer — mark all External_Id__c values as failed
      batch.forEach((r) => failedExternalIds.push(r.External_Id__c))
      continue
    }

    const results: Array<{ success: boolean; id?: string; errors?: unknown[] }> =
      await response.json()

    results.forEach((result, index) => {
      if (!result.success) {
        failedExternalIds.push(batch[index].External_Id__c)
      }
    })
  }

  return { failedExternalIds }
}
