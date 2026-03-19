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
})
