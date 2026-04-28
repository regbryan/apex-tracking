import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

import { POST } from '@/app/api/links/generate/route'
import { supabase } from '@/lib/supabase'

function makeRequest(body: object, auth?: string): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (auth) headers.set('Authorization', auth)
  return new Request('http://localhost/api/links/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/links/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.API_LINKS_SECRET = 'test-secret'
    process.env.LINK_BASE_URL = 'https://track.example.com'
  })

  it('returns 401 when Authorization header is missing', async () => {
    const response = await POST(makeRequest({ campaign_id: 'C1', member_ids: [], destination_url: 'https://x.com' }) as any)
    expect(response.status).toBe(401)
  })

  it('returns 401 when Authorization token is wrong', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: [], destination_url: 'https://x.com' },
      'Bearer wrong'
    ) as any)
    expect(response.status).toBe(401)
  })

  it('generates unique tracked links for each member_id', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    const response = await POST(makeRequest(
      {
        campaign_id: 'CAM001',
        destination_url: 'https://site.com/page',
        file_url: null,
        member_ids: ['MEM001', 'MEM002'],
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveLength(2)
    expect(body[0]).toHaveProperty('member_id', 'MEM001')
    expect(body[0].tracked_url).toMatch(/^https:\/\/track\.example\.com\/api\/track\?t=[a-f0-9]{32}$/)
    expect(body[1].tracked_url).not.toBe(body[0].tracked_url)
  })

  it('uses /api/download URL for download links', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    const response = await POST(makeRequest(
      {
        campaign_id: 'CAM001',
        destination_url: null,
        file_url: 'https://cdn.example.com/file.pdf',
        member_ids: ['MEM001'],
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body[0].tracked_url).toMatch(/\/api\/download\?t=/)
  })

  it('returns 400 when neither destination_url nor file_url is provided', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: ['M1'] },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when both destination_url and file_url are provided', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: ['M1'], destination_url: 'https://x.com', file_url: 'https://y.com/f.pdf' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when campaign_id is missing', async () => {
    const response = await POST(makeRequest(
      { member_ids: ['M1'], destination_url: 'https://x.com' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when member_ids is an empty array', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: [], destination_url: 'https://x.com' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when member_ids is not an array', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: 'not-an-array', destination_url: 'https://x.com' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when body is not valid JSON', async () => {
    const validSecret = 'test-secret'
    const request = new Request('http://localhost/api/links/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${validSecret}`,
        'Content-Type': 'application/json',
      },
      body: '{invalid json',
    })
    const response = await POST(request as any)
    expect(response.status).toBe(400)
    const data = await response.json()
    expect(data.error).toBe('Invalid JSON body')
  })

  it('returns 400 when member_ids contains an empty string element', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: ['M1', ''], destination_url: 'https://x.com' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when member_ids contains a non-string element', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: ['M1', 42], destination_url: 'https://x.com' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 500 when database insert fails', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: { message: 'DB error' } }),
    } as any)

    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: ['M1'], destination_url: 'https://x.com' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(500)
  })

  it('auto-extracts UTM params from destination_url', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValueOnce({ insert: insertSpy } as any)

    const response = await POST(makeRequest(
      {
        campaign_id: 'C1',
        member_ids: ['M1'],
        destination_url: 'https://site.com/page?utm_source=outbound&utm_medium=email&utm_campaign=q2-acme',
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted[0]).toMatchObject({
      utm_source: 'outbound',
      utm_medium: 'email',
      utm_campaign: 'q2-acme',
      utm_term: null,
      utm_content: null,
    })
  })

  it('explicit utm body fields override URL-extracted values', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValueOnce({ insert: insertSpy } as any)

    const response = await POST(makeRequest(
      {
        campaign_id: 'C1',
        member_ids: ['M1'],
        destination_url: 'https://site.com/page?utm_source=fromurl&utm_campaign=fromurl',
        utm: { source: 'override', term: 'kw' },
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted[0]).toMatchObject({
      utm_source: 'override',       // body override wins
      utm_campaign: 'fromurl',      // not overridden, URL value persists
      utm_term: 'kw',               // body-only
      utm_medium: null,
      utm_content: null,
    })
  })

  it('persists nulls for all UTM fields when none provided and URL has none', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValueOnce({ insert: insertSpy } as any)

    const response = await POST(makeRequest(
      { campaign_id: 'C1', member_ids: ['M1'], destination_url: 'https://site.com/page' },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted[0]).toMatchObject({
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_term: null,
      utm_content: null,
    })
  })

  it('handles malformed destination_url gracefully (no UTMs extracted)', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValueOnce({ insert: insertSpy } as any)

    // not a valid URL — extract returns all nulls, body-supplied utm still applied
    const response = await POST(makeRequest(
      {
        campaign_id: 'C1',
        member_ids: ['M1'],
        destination_url: 'not-a-url',
        utm: { source: 'x' },
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted[0]).toMatchObject({ utm_source: 'x', utm_medium: null })
  })

  it('ignores empty-string and non-string utm body values', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValueOnce({ insert: insertSpy } as any)

    const response = await POST(makeRequest(
      {
        campaign_id: 'C1',
        member_ids: ['M1'],
        destination_url: 'https://site.com?utm_source=fallback',
        utm: { source: '', medium: 42, campaign: 'real' },
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted[0]).toMatchObject({
      utm_source: 'fallback',  // empty-string body value ignored, URL fallback wins
      utm_medium: null,        // non-string body value ignored
      utm_campaign: 'real',
    })
  })

  it('accepts recipients shape with contact_id + account_id (no campaign_id required)', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValueOnce({ insert: insertSpy } as any)

    const response = await POST(makeRequest(
      {
        destination_url: 'https://site.com/page',
        recipients: [{ contact_id: '003xx0000000001', account_id: '001xx0000000001' }],
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted[0]).toMatchObject({
      contact_id: '003xx0000000001',
      account_id: '001xx0000000001',
      lead_id: null,
      member_id: null,
      campaign_id: null,
    })
    const body = await response.json()
    expect(body[0]).toMatchObject({
      contact_id: '003xx0000000001',
      account_id: '001xx0000000001',
    })
  })

  it('accepts recipients with lead_id only (lead has no AccountId until conversion)', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValueOnce({ insert: insertSpy } as any)

    const response = await POST(makeRequest(
      {
        destination_url: 'https://site.com/page',
        recipients: [{ lead_id: '00Qxx0000000001' }],
      },
      'Bearer test-secret'
    ) as any)

    expect(response.status).toBe(200)
    const inserted = insertSpy.mock.calls[0][0]
    expect(inserted[0]).toMatchObject({
      lead_id: '00Qxx0000000001',
      contact_id: null,
      account_id: null,
    })
  })

  it('returns 400 when recipient has no identifiers', async () => {
    const response = await POST(makeRequest(
      {
        destination_url: 'https://site.com/page',
        recipients: [{ contact_id: '003xx0000000001' }, {}],
      },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when both member_ids and recipients are provided', async () => {
    const response = await POST(makeRequest(
      {
        campaign_id: 'C1',
        destination_url: 'https://site.com/page',
        member_ids: ['M1'],
        recipients: [{ contact_id: '003xx0000000001' }],
      },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('returns 400 when neither member_ids nor recipients are provided', async () => {
    const response = await POST(makeRequest(
      { campaign_id: 'C1', destination_url: 'https://site.com/page' },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('legacy member_ids path still requires campaign_id', async () => {
    const response = await POST(makeRequest(
      { destination_url: 'https://site.com/page', member_ids: ['M1'] },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })

  it('trims whitespace and treats empty recipient strings as missing', async () => {
    const response = await POST(makeRequest(
      {
        destination_url: 'https://site.com/page',
        recipients: [{ contact_id: '   ', lead_id: '' }],
      },
      'Bearer test-secret'
    ) as any)
    expect(response.status).toBe(400)
  })
})
