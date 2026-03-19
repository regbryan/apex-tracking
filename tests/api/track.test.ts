import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

import { GET } from '@/app/api/track/route'
import { supabase } from '@/lib/supabase'

function makeRequest(token: string, cookie?: string): Request {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  return new Request(`http://localhost/api/track?t=${token}`, { headers })
}

describe('GET /api/track', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LINK_BASE_URL = 'https://track.example.com'
  })

  it('redirects to destination_url on valid token (no cookie = click)', async () => {
    const mockLink = {
      id: 'link-uuid',
      campaign_id: 'CAM001',
      member_id: 'MEM001',
      destination_url: 'https://destination.com/page',
    }

    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: mockLink, error: null }),
    } as any)
    mockFrom.mockReturnValueOnce({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as any)

    const response = await GET(makeRequest('valid-token') as any)

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://destination.com/page')
    expect(response.headers.get('set-cookie')).toContain('apex_track_valid-token')
  })

  it('redirects to fallback URL on unknown token', async () => {
    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
    } as any)

    const response = await GET(makeRequest('bad-token') as any)

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://track.example.com')
  })

  it('logs as pageview when cookie is already present', async () => {
    const mockLink = {
      id: 'link-uuid',
      campaign_id: 'CAM001',
      member_id: 'MEM001',
      destination_url: 'https://destination.com/page',
    }

    const mockFrom = vi.mocked(supabase.from)
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: mockLink, error: null }),
    } as any)

    const insertMock = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValueOnce({ insert: insertMock } as any)

    await GET(makeRequest('valid-token', 'apex_track_valid-token=1') as any)

    expect(insertMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'pageview' }),
      ])
    )
  })
})
