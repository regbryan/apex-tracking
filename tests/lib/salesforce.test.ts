import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getSalesforceToken,
  buildAccountSignalRecords,
  upsertAccountSignals,
  TrackingEventForSignal,
} from '@/lib/salesforce'

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

describe('buildAccountSignalRecords', () => {
  const baseEvent: TrackingEventForSignal = {
    event_id: 'evt-uuid-1',
    account_id: '001xx0000000001',
    contact_id: '003xx0000000001',
    lead_id: null,
    campaign_id: 'CAM001',
    event_type: 'click',
    created_at: '2026-04-01T10:00:00Z',
    utm_source: 'outbound',
    utm_medium: 'email',
    utm_campaign: 'q2-acme',
    utm_term: null,
    utm_content: null,
  }

  it('maps a click event to an outreach_click signal with all populated fields', () => {
    const records = buildAccountSignalRecords([baseEvent])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      attributes: { type: 'Account_Signal__c' },
      External_Id__c: 'evt-uuid-1',
      Account__c: '001xx0000000001',
      Signal_Type__c: 'outreach_click',
      Source_System__c: 'ApexTracking',
      Captured_At__c: '2026-04-01T10:00:00Z',
      Related_Contact__c: '003xx0000000001',
      Related_Campaign__c: 'CAM001',
      UTM_Source__c: 'outbound',
      UTM_Medium__c: 'email',
      UTM_Campaign__c: 'q2-acme',
    })
    // Optional fields with null source values must be absent (not present-as-null)
    expect(records[0]).not.toHaveProperty('Related_Lead__c')
    expect(records[0]).not.toHaveProperty('UTM_Term__c')
    expect(records[0]).not.toHaveProperty('UTM_Content__c')
  })

  it('maps event_type to signal_type correctly', () => {
    const events: TrackingEventForSignal[] = [
      { ...baseEvent, event_id: 'e1', event_type: 'click' },
      { ...baseEvent, event_id: 'e2', event_type: 'pageview' },
      { ...baseEvent, event_id: 'e3', event_type: 'download' },
    ]
    const records = buildAccountSignalRecords(events)
    expect(records[0].Signal_Type__c).toBe('outreach_click')
    expect(records[1].Signal_Type__c).toBe('web_visit')
    expect(records[2].Signal_Type__c).toBe('content_download')
  })

  it('uses lead_id for Related_Lead__c when contact_id is null', () => {
    const records = buildAccountSignalRecords([
      { ...baseEvent, contact_id: null, lead_id: '00Qxx0000000001' },
    ])
    expect(records[0]).toMatchObject({ Related_Lead__c: '00Qxx0000000001' })
    expect(records[0]).not.toHaveProperty('Related_Contact__c')
  })
})

describe('upsertAccountSignals', () => {
  const mockToken = { access_token: 'tok', instance_url: 'https://test.salesforce.com' }
  const apiVersion = 'v59.0'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  function makeRecord(externalId: string) {
    return {
      attributes: { type: 'Account_Signal__c' as const },
      External_Id__c: externalId,
      Account__c: '001xx0000000001',
      Signal_Type__c: 'outreach_click' as const,
      Source_System__c: 'ApexTracking' as const,
      Captured_At__c: '2026-04-01T10:00:00Z',
    }
  }

  it('PATCHes the composite upsert endpoint with External_Id__c key', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ success: true, id: 'a0Sxx0001' }],
    } as Response)

    await upsertAccountSignals([makeRecord('evt-1')], mockToken, apiVersion)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.salesforce.com/services/data/v59.0/composite/sobjects/Account_Signal__c/External_Id__c',
      expect.objectContaining({ method: 'PATCH' })
    )
  })

  it('returns empty failedExternalIds on full success', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { success: true, id: 'a0Sxx0001' },
        { success: true, id: 'a0Sxx0002' },
      ],
    } as Response)

    const result = await upsertAccountSignals(
      [makeRecord('evt-1'), makeRecord('evt-2')],
      mockToken, apiVersion,
    )
    expect(result.failedExternalIds).toEqual([])
  })

  it('collects per-record failures by External_Id__c', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { success: true, id: 'a0Sxx0001' },
        { success: false, errors: [{ message: 'Account not found' }] },
      ],
    } as Response)

    const result = await upsertAccountSignals(
      [makeRecord('evt-1'), makeRecord('evt-2')],
      mockToken, apiVersion,
    )
    expect(result.failedExternalIds).toEqual(['evt-2'])
  })

  it('marks entire batch as failed on HTTP error and continues to next batch', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce({ ok: false } as Response)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ success: true, id: 'a0Sxx201' }],
    } as Response)

    // 201 records → 2 batches (200 + 1)
    const records = Array.from({ length: 201 }, (_, i) => makeRecord(`evt-${i + 1}`))

    const result = await upsertAccountSignals(records, mockToken, apiVersion)
    expect(result.failedExternalIds).toHaveLength(200)
    expect(result.failedExternalIds[0]).toBe('evt-1')
    expect(result.failedExternalIds[199]).toBe('evt-200')
  })
})
