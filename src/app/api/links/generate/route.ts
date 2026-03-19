import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateToken } from '@/lib/token'
import { validateBearerToken } from '@/lib/auth'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!validateBearerToken(authHeader, process.env.API_LINKS_SECRET!)) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const body = await request.json()
  const { campaign_id, member_ids, destination_url, file_url } = body

  // Validate required fields
  if (!campaign_id || !Array.isArray(member_ids)) {
    return new NextResponse('Missing required fields: campaign_id and member_ids', { status: 400 })
  }

  // Exactly one of destination_url or file_url must be set
  const hasDestination = destination_url != null && destination_url !== ''
  const hasFile = file_url != null && file_url !== ''
  if ((hasDestination && hasFile) || (!hasDestination && !hasFile)) {
    return new NextResponse('Provide exactly one of destination_url or file_url', { status: 400 })
  }

  const baseUrl = process.env.LINK_BASE_URL!
  const endpoint = hasFile ? 'download' : 'track'

  // Generate one token per member
  const rows = member_ids.map((member_id: string) => ({
    token: generateToken(),
    campaign_id,
    member_id,
    destination_url: hasDestination ? destination_url : null,
    file_url: hasFile ? file_url : null,
  }))

  const { error } = await supabase.from('tracked_links').insert(rows)

  if (error) {
    console.error('[generate] Failed to insert tracked links:', error.message)
    return new NextResponse('Internal server error', { status: 500 })
  }

  const result = rows.map((row) => ({
    member_id: row.member_id,
    tracked_url: `${baseUrl}/api/${endpoint}?t=${row.token}`,
  }))

  return NextResponse.json(result)
}
