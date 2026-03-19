import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

import { GET } from '@/app/api/download/route'
import { supabase } from '@/lib/supabase'

function makeRequest(token?: string): Request {
  const url = token
    ? `http://localhost/api/download?t=${token}`
    : 'http://localhost/api/download'
  return new Request(url)
}

describe('GET /api/download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs download event and redirects to file_url on valid token', async () => {
    const mockLink = {
      id: 'link-uuid',
      campaign_id: 'CAM001',
      member_id: 'MEM001',
      file_url: 'https://cdn.example.com/brochure.pdf',
    }

    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: mockLink, error: null }),
    } as any)

    const insertMock = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValueOnce({ insert: insertMock } as any)

    const response = await GET(makeRequest('valid-token') as any)

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://cdn.example.com/brochure.pdf')
    expect(insertMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'download', file_name: 'brochure.pdf' }),
      ])
    )
  })

  it('returns 404 on unknown token', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
    } as any)

    const response = await GET(makeRequest('bad-token') as any)

    expect(response.status).toBe(404)
  })

  it('returns 404 when token exists but file_url is null', async () => {
    const mockLink = {
      id: 'link-uuid',
      campaign_id: 'CAM001',
      member_id: 'MEM001',
      file_url: null,
    }

    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: mockLink, error: null }),
    } as any)

    const response = await GET(makeRequest('click-token') as any)

    expect(response.status).toBe(404)
  })

  it('returns 404 when no token in query string', async () => {
    const response = await GET(makeRequest() as any)
    expect(response.status).toBe(404)
  })

  it('returns 404 when insert fails', async () => {
    const mockLink = {
      id: 'link-uuid',
      campaign_id: 'CAM001',
      member_id: 'MEM001',
      file_url: 'https://cdn.example.com/brochure.pdf',
    }

    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: mockLink, error: null }),
    } as any)
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: { message: 'db connection error' } }),
    } as any)

    const response = await GET(makeRequest('valid-token') as any)

    expect(response.status).toBe(404)
  })
})
