import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}))
vi.mock('@/lib/salesforce', () => ({
  getSalesforceToken: vi.fn(),
  buildAccountSignalRecords: vi.fn(),
  upsertAccountSignals: vi.fn(),
}))

import { POST } from '@/app/api/sync/route'
import { supabase } from '@/lib/supabase'
import { getSalesforceToken, buildAccountSignalRecords, upsertAccountSignals } from '@/lib/salesforce'

function makeRequest(auth?: string): Request {
  const headers = new Headers()
  if (auth) headers.set('Authorization', auth)
  return new Request('http://localhost/api/sync', { method: 'POST', headers })
}

// Test helpers — model the supabase chain returns to keep test bodies short
function mockLockAcquired(mockFrom: ReturnType<typeof vi.mocked<typeof supabase.from>>) {
  mockFrom.mockReturnValueOnce({
    update: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({ data: [{ id: 1 }], error: null }),
  } as any)
}
function mockLastLog(mockFrom: ReturnType<typeof vi.mocked<typeof supabase.from>>, lastSequenceId: number) {
  mockFrom.mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { last_sequence_id: lastSequenceId }, error: null }),
  } as any)
}
function mockEventsQuery(mockFrom: ReturnType<typeof vi.mocked<typeof supabase.from>>, data: unknown, error: unknown = null) {
  mockFrom.mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    gt: vi.fn().mockResolvedValue({ data, error }),
  } as any)
}
function mockSyncLogInsert(mockFrom: ReturnType<typeof vi.mocked<typeof supabase.from>>) {
  mockFrom.mockReturnValueOnce({ insert: vi.fn().mockResolvedValue({ error: null }) } as any)
}
function mockReleaseLock(mockFrom: ReturnType<typeof vi.mocked<typeof supabase.from>>) {
  mockFrom.mockReturnValueOnce({
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ error: null }),
  } as any)
}

describe('POST /api/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    process.env.SF_CLIENT_ID = 'sf-id'
    process.env.SF_CLIENT_SECRET = 'sf-secret'
    process.env.SF_INSTANCE_URL = 'https://test.salesforce.com'
    process.env.SF_API_VERSION = 'v59.0'
  })

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const response = await POST(makeRequest())
    expect(response.status).toBe(401)
  })

  it('returns 200 and skips when lock is already held', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as any)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.message).toContain('locked')
  })

  it('returns 200 with records_processed=0 when no new events', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockLockAcquired(mockFrom)
    mockLastLog(mockFrom, 100)
    mockEventsQuery(mockFrom, [])
    mockSyncLogInsert(mockFrom)
    mockReleaseLock(mockFrom)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.records_processed).toBe(0)
  })

  it('upserts Account_Signal__c records when syncable events exist', async () => {
    const mockFrom = vi.mocked(supabase.from)

    const events = [
      {
        id: 'evt-1',
        account_id: '001xx0000000001',
        contact_id: '003xx0000000001',
        lead_id: null,
        campaign_id: 'CAM001',
        event_type: 'click',
        created_at: '2026-04-01T10:00:00Z',
        sequence_id: 51,
        tracked_links: { utm_source: 'outbound', utm_medium: 'email', utm_campaign: 'q2', utm_term: null, utm_content: null },
      },
      {
        id: 'evt-2',
        account_id: '001xx0000000002',
        contact_id: '003xx0000000002',
        lead_id: null,
        campaign_id: 'CAM001',
        event_type: 'pageview',
        created_at: '2026-04-01T11:00:00Z',
        sequence_id: 52,
        tracked_links: { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null },
      },
    ]

    mockLockAcquired(mockFrom)
    mockLastLog(mockFrom, 50)
    mockEventsQuery(mockFrom, events)

    vi.mocked(getSalesforceToken).mockResolvedValue({ access_token: 'tok', instance_url: 'https://sf.test' })
    vi.mocked(buildAccountSignalRecords).mockReturnValue([
      { attributes: { type: 'Account_Signal__c' }, External_Id__c: 'evt-1', Account__c: '001xx0000000001', Signal_Type__c: 'outreach_click', Source_System__c: 'ApexTracking', Captured_At__c: '2026-04-01T10:00:00Z' },
      { attributes: { type: 'Account_Signal__c' }, External_Id__c: 'evt-2', Account__c: '001xx0000000002', Signal_Type__c: 'web_visit', Source_System__c: 'ApexTracking', Captured_At__c: '2026-04-01T11:00:00Z' },
    ])
    vi.mocked(upsertAccountSignals).mockResolvedValue({ failedExternalIds: [] })

    mockSyncLogInsert(mockFrom)
    mockReleaseLock(mockFrom)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.records_processed).toBe(2)
    expect(body.failed_count).toBe(0)
    expect(body.status).toBe('success')

    // Verify the syncable shape passed to buildAccountSignalRecords
    const builderArg = vi.mocked(buildAccountSignalRecords).mock.calls[0][0]
    expect(builderArg).toHaveLength(2)
    expect(builderArg[0]).toMatchObject({
      event_id: 'evt-1',
      account_id: '001xx0000000001',
      contact_id: '003xx0000000001',
      utm_source: 'outbound',
      event_type: 'click',
    })
  })

  it('skips events with null account_id and advances cursor past them', async () => {
    const mockFrom = vi.mocked(supabase.from)

    const events = [
      // Has account_id — syncable
      {
        id: 'evt-1', account_id: '001xx0000000001', contact_id: '003xx1', lead_id: null,
        campaign_id: 'C1', event_type: 'click', created_at: '2026-04-01T10:00:00Z', sequence_id: 51,
        tracked_links: { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null },
      },
      // Missing account_id (e.g., Lead pre-conversion) — skipped
      {
        id: 'evt-2', account_id: null, contact_id: null, lead_id: '00Qxx1',
        campaign_id: 'C1', event_type: 'click', created_at: '2026-04-01T11:00:00Z', sequence_id: 52,
        tracked_links: { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null },
      },
    ]

    mockLockAcquired(mockFrom)
    mockLastLog(mockFrom, 50)
    mockEventsQuery(mockFrom, events)

    vi.mocked(getSalesforceToken).mockResolvedValue({ access_token: 'tok', instance_url: 'https://sf.test' })
    vi.mocked(buildAccountSignalRecords).mockReturnValue([
      { attributes: { type: 'Account_Signal__c' }, External_Id__c: 'evt-1', Account__c: '001xx0000000001', Signal_Type__c: 'outreach_click', Source_System__c: 'ApexTracking', Captured_At__c: '2026-04-01T10:00:00Z' },
    ])
    vi.mocked(upsertAccountSignals).mockResolvedValue({ failedExternalIds: [] })

    mockSyncLogInsert(mockFrom)
    mockReleaseLock(mockFrom)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.records_processed).toBe(1)
    expect(body.skipped).toBe(1)

    // Only the syncable event was passed to the builder
    const builderArg = vi.mocked(buildAccountSignalRecords).mock.calls[0][0]
    expect(builderArg).toHaveLength(1)
    expect(builderArg[0].event_id).toBe('evt-1')
  })

  it('advances cursor and skips Salesforce when all events lack account_id', async () => {
    const mockFrom = vi.mocked(supabase.from)

    const events = [
      {
        id: 'evt-1', account_id: null, contact_id: null, lead_id: '00Qxx1',
        campaign_id: 'C1', event_type: 'click', created_at: '2026-04-01T10:00:00Z', sequence_id: 51,
        tracked_links: { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null },
      },
    ]

    mockLockAcquired(mockFrom)
    mockLastLog(mockFrom, 50)
    mockEventsQuery(mockFrom, events)
    mockSyncLogInsert(mockFrom)
    mockReleaseLock(mockFrom)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.records_processed).toBe(0)
    expect(body.skipped).toBe(1)

    expect(vi.mocked(getSalesforceToken)).not.toHaveBeenCalled()
    expect(vi.mocked(upsertAccountSignals)).not.toHaveBeenCalled()
  })

  it('returns 500 when events query returns a DB error', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockLockAcquired(mockFrom)
    mockLastLog(mockFrom, 50)
    mockEventsQuery(mockFrom, null, { message: 'DB connection failed' })
    mockSyncLogInsert(mockFrom)
    mockReleaseLock(mockFrom)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(500)
  })
})
