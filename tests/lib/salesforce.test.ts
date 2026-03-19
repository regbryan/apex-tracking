import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSalesforceToken, buildCompositeUpdateRecords, batchUpdateCampaignMembers } from '@/lib/salesforce'

describe('getSalesforceToken', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('posts to the token endpoint and returns access_token', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-token', instance_url: 'https://test.salesforce.com' }),
    } as Response)

    const result = await getSalesforceToken({
      clientId: 'id',
      clientSecret: 'secret',
      instanceUrl: 'https://test.salesforce.com',
    })

    expect(result.access_token).toBe('test-token')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.salesforce.com/services/oauth2/token',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('throws when Salesforce returns non-ok response', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => 'Unauthorized',
    } as Response)

    await expect(getSalesforceToken({
      clientId: 'id',
      clientSecret: 'secret',
      instanceUrl: 'https://test.salesforce.com',
    })).rejects.toThrow('Salesforce token error')
  })
})

describe('buildCompositeUpdateRecords', () => {
  it('maps member aggregates to Salesforce field update objects', () => {
    const aggregates = [
      {
        member_id: 'MEM001',
        total_clicks: 5,
        unique_clicks: 3,
        first_click_date: '2026-03-01T10:00:00Z',
        last_click_date: '2026-03-10T15:00:00Z',
        last_pageview_date: '2026-03-10T15:05:00Z',
        last_download_date: null,
        pages_visited: 'https://site.com/page1,https://site.com/page2',
        downloads: '',
      },
    ]

    const records = buildCompositeUpdateRecords(aggregates)

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      attributes: { type: 'CampaignMember' },
      Id: 'MEM001',
      Total_Clicks__c: 5,
      Unique_Clicks__c: 3,
      First_Click_Date__c: '2026-03-01T10:00:00Z',
      Last_Click_Date__c: '2026-03-10T15:00:00Z',
      Last_Page_View_Date__c: '2026-03-10T15:05:00Z',
    })
    // null/empty fields should not be present in output
    expect(records[0]).not.toHaveProperty('Last_Download_Date__c')
    expect(records[0]).not.toHaveProperty('Downloads__c')
  })
})

describe('batchUpdateCampaignMembers', () => {
  const mockToken = { access_token: 'tok', instance_url: 'https://test.salesforce.com' }
  const apiVersion = 'v59.0'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('returns empty failedIds on full success', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { success: true, id: 'MEM001' },
        { success: true, id: 'MEM002' },
      ],
    } as Response)

    const records = [
      { attributes: { type: 'CampaignMember' }, Id: 'MEM001', Total_Clicks__c: 1, Unique_Clicks__c: 1 },
      { attributes: { type: 'CampaignMember' }, Id: 'MEM002', Total_Clicks__c: 2, Unique_Clicks__c: 1 },
    ]

    const result = await batchUpdateCampaignMembers(records, mockToken, apiVersion)
    expect(result.failedIds).toEqual([])
  })

  it('collects individual failed member IDs from partial response failure', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { success: true, id: 'MEM001' },
        { success: false, errors: [{ message: 'Not found' }] },
      ],
    } as Response)

    const records = [
      { attributes: { type: 'CampaignMember' }, Id: 'MEM001', Total_Clicks__c: 1, Unique_Clicks__c: 1 },
      { attributes: { type: 'CampaignMember' }, Id: 'MEM002', Total_Clicks__c: 2, Unique_Clicks__c: 1 },
    ]

    const result = await batchUpdateCampaignMembers(records, mockToken, apiVersion)
    expect(result.failedIds).toEqual(['MEM002'])
  })

  it('marks entire batch as failed on HTTP error and continues to next batch', async () => {
    const mockFetch = vi.mocked(fetch)
    // First batch: HTTP failure
    mockFetch.mockResolvedValueOnce({ ok: false } as Response)
    // Second batch: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ success: true, id: 'MEM201' }],
    } as Response)

    // Create 201 records to force 2 batches (200 + 1)
    const records = Array.from({ length: 201 }, (_, i) => ({
      attributes: { type: 'CampaignMember' },
      Id: `MEM${String(i + 1).padStart(3, '0')}`,
      Total_Clicks__c: 1,
      Unique_Clicks__c: 1,
    }))

    const result = await batchUpdateCampaignMembers(records, mockToken, apiVersion)
    // First 200 failed, last 1 succeeded
    expect(result.failedIds).toHaveLength(200)
    expect(result.failedIds[0]).toBe('MEM001')
    expect(result.failedIds[199]).toBe('MEM200')
  })
})
