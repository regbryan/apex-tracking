import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSalesforceToken, buildCompositeUpdateRecords } from '@/lib/salesforce'

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
