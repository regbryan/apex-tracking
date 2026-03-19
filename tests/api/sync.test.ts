import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}))
vi.mock('@/lib/salesforce', () => ({
  getSalesforceToken: vi.fn(),
  buildCompositeUpdateRecords: vi.fn(),
  batchUpdateCampaignMembers: vi.fn(),
}))

import { POST } from '@/app/api/sync/route'
import { supabase } from '@/lib/supabase'
import { getSalesforceToken, batchUpdateCampaignMembers, buildCompositeUpdateRecords } from '@/lib/salesforce'

function makeRequest(auth?: string): Request {
  const headers = new Headers()
  if (auth) headers.set('Authorization', auth)
  return new Request('http://localhost/api/sync', { method: 'POST', headers })
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
    // Lock acquisition returns 0 rows updated
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

    // Lock acquired
    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 1 }], error: null }),
    } as any)

    // Get last sync_log
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { last_sequence_id: 100 }, error: null }),
    } as any)

    // No new events
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      gt: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as any)

    // Write sync_log
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    // Release lock
    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.records_processed).toBe(0)
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(5)
  })

  it('returns 200 with records_processed and failed_count when events exist and Salesforce sync succeeds', async () => {
    const mockFrom = vi.mocked(supabase.from)

    const clickEvents = [
      {
        member_id: 'M1',
        campaign_id: 'C1',
        event_type: 'click',
        page_url: 'https://example.com/page1',
        file_name: null,
        created_at: '2026-01-01T10:00:00Z',
        sequence_id: 51,
      },
      {
        member_id: 'M1',
        campaign_id: 'C1',
        event_type: 'click',
        page_url: 'https://example.com/page2',
        file_name: null,
        created_at: '2026-01-02T10:00:00Z',
        sequence_id: 52,
      },
    ]

    // Lock acquired
    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 1 }], error: null }),
    } as any)

    // Get last sync_log (last_sequence_id: 50)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { last_sequence_id: 50 }, error: null }),
    } as any)

    // New events query — returns 2 click events for member M1
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      gt: vi.fn().mockResolvedValue({ data: clickEvents, error: null }),
    } as any)

    // Historical click events query (for unique_clicks) — returns same 2 events
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: clickEvents.map(e => ({ member_id: e.member_id, created_at: e.created_at })), error: null }),
    } as any)

    // Mock Salesforce calls
    vi.mocked(getSalesforceToken).mockResolvedValue({ access_token: 'tok', instance_url: 'https://sf.test' })
    vi.mocked(buildCompositeUpdateRecords).mockReturnValue([{ attributes: { type: 'CampaignMember' }, Id: 'M1', Total_Clicks__c: 2, Unique_Clicks__c: 1 }])
    vi.mocked(batchUpdateCampaignMembers).mockResolvedValue({ failedIds: [] })

    // Write sync_log
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    // Release lock
    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.records_processed).toBe(1)
    expect(body.failed_count).toBe(0)
    expect(body.status).toBe('success')
  })

  it('returns 500 when events query returns a DB error', async () => {
    const mockFrom = vi.mocked(supabase.from)

    // Lock acquired
    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 1 }], error: null }),
    } as any)

    // Get last sync_log
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { last_sequence_id: 50 }, error: null }),
    } as any)

    // New events query — returns DB error
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      gt: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB connection failed' } }),
    } as any)

    // Write sync_log (for the failed log entry)
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    // Release lock
    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    const response = await POST(makeRequest('Bearer cron-secret'))
    expect(response.status).toBe(500)
  })
})
