export interface SFTokenConfig {
  clientId: string
  clientSecret: string
  instanceUrl: string
}

export interface SFToken {
  access_token: string
  instance_url: string
}

export interface MemberAggregate {
  member_id: string
  total_clicks: number
  unique_clicks: number
  first_click_date: string | null
  last_click_date: string | null
  last_pageview_date: string | null
  last_download_date: string | null
  pages_visited: string
  downloads: string
}

export async function getSalesforceToken(config: SFTokenConfig): Promise<SFToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  const response = await fetch(`${config.instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Salesforce token error: ${text}`)
  }

  return response.json()
}

export function buildCompositeUpdateRecords(aggregates: MemberAggregate[]) {
  return aggregates.map((a) => ({
    attributes: { type: 'CampaignMember' },
    Id: a.member_id,
    Total_Clicks__c: a.total_clicks,
    Unique_Clicks__c: a.unique_clicks,
    ...(a.first_click_date && { First_Click_Date__c: a.first_click_date }),
    ...(a.last_click_date && { Last_Click_Date__c: a.last_click_date }),
    ...(a.last_pageview_date && { Last_Page_View_Date__c: a.last_pageview_date }),
    ...(a.last_download_date && { Last_Download_Date__c: a.last_download_date }),
    ...(a.pages_visited && { Pages_Visited__c: a.pages_visited }),
    ...(a.downloads && { Downloads__c: a.downloads }),
  }))
}

export async function batchUpdateCampaignMembers(
  records: ReturnType<typeof buildCompositeUpdateRecords>,
  token: SFToken,
  apiVersion: string
): Promise<{ failedIds: string[] }> {
  const failedIds: string[] = []
  const BATCH_SIZE = 200

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)

    const response = await fetch(
      `${token.instance_url}/services/data/${apiVersion}/composite/sobjects`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ allOrNone: false, records: batch }),
      }
    )

    if (!response.ok) {
      // Entire batch failed — mark all member IDs in this batch as failed
      batch.forEach((r) => failedIds.push(r.Id))
      continue
    }

    const results: Array<{ success: boolean; id?: string; errors?: unknown[] }> =
      await response.json()

    results.forEach((result, index) => {
      if (!result.success) {
        failedIds.push(batch[index].Id)
      }
    })
  }

  return { failedIds }
}
