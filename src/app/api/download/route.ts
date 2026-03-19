import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const token = url.searchParams.get('t')

  if (!token) {
    return new NextResponse('Not found', { status: 404 })
  }

  const { data: link, error } = await supabase
    .from('tracked_links')
    .select('id, campaign_id, member_id, file_url')
    .eq('token', token)
    .single()

  if (error || !link || !link.file_url) {
    return new NextResponse('Not found', { status: 404 })
  }

  // Extract file name from URL — file_url is stored server-side at generation time,
  // never accepted as a query param (prevents open redirect attacks)
  const fileName = new URL(link.file_url).pathname.split('/').pop() ?? 'unknown'

  // IMPORTANT: Must await — Vercel freezes execution context immediately after response is sent.
  const { error: insertError } = await supabase.from('tracking_events').insert([
    {
      tracked_link_id: link.id,
      campaign_id: link.campaign_id,
      member_id: link.member_id,
      event_type: 'download',
      file_name: fileName,
      ip_address:
        (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
        request.headers.get('x-real-ip'),
      user_agent: request.headers.get('user-agent'),
    },
  ])

  if (insertError) {
    console.error('[download] Failed to log event:', insertError.message)
    return new NextResponse('Not found', { status: 404 })
  }

  return NextResponse.redirect(link.file_url, { status: 302 })
}
