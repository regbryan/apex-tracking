import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const token = url.searchParams.get('t')
  const fallbackUrl = process.env.LINK_BASE_URL!

  if (!token) {
    return new Response(null, { status: 302, headers: { Location: fallbackUrl } })
  }

  // Look up the token
  const { data: link, error } = await supabase
    .from('tracked_links')
    .select('id, campaign_id, member_id, contact_id, lead_id, account_id, destination_url')
    .eq('token', token)
    .single()

  if (error || !link || !link.destination_url) {
    return new Response(null, { status: 302, headers: { Location: fallbackUrl } })
  }

  // Determine event type based on cookie
  const cookieName = `apex_track_${token}`
  const cookieHeader = request.headers.get('cookie') ?? ''
  const hasCookie = cookieHeader.split(';').some((c) => c.trim().startsWith(`${cookieName}=`))
  const eventType = hasCookie ? 'pageview' : 'click'

  // IMPORTANT: Must await — Vercel freezes execution context immediately after response is sent,
  // so unawaited promises are silently dropped and the event would never be logged.
  const { error: insertError } = await supabase.from('tracking_events').insert([
    {
      tracked_link_id: link.id,
      campaign_id: link.campaign_id,
      member_id: link.member_id,
      contact_id: link.contact_id,
      lead_id: link.lead_id,
      account_id: link.account_id,
      event_type: eventType,
      page_url: link.destination_url,
      ip_address: (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
                 || request.headers.get('x-real-ip'),
      user_agent: request.headers.get('user-agent'),
    },
  ])

  if (insertError) {
    console.error('[track] Failed to log event:', insertError.message)
    // Still redirect — don't break the user's link, but don't set cookie either
    // (next visit will retry as a click, preserving data integrity)
    return NextResponse.redirect(link.destination_url, { status: 302 })
  }

  // Build redirect response
  const response = NextResponse.redirect(link.destination_url, { status: 302 })

  // Set cookie only on first click
  if (!hasCookie) {
    response.cookies.set(cookieName, '1', {
      maxAge: 60 * 60 * 24 * 30, // 30 days
      sameSite: 'lax',
      secure: true,
      httpOnly: true,
    })
  }

  return response
}
