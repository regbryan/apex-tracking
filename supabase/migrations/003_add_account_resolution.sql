-- Migration: 003_add_account_resolution
-- Apply via Supabase SQL Editor:
--   1. Go to your Supabase project → SQL Editor
--   2. Paste this file contents
--   3. Click Run
-- Verify:
--   tracked_links has contact_id, lead_id, account_id columns
--   tracking_events has contact_id, lead_id, account_id columns

-- tracked_links: resolved-at-mint-time identity
-- member_id (CampaignMember Id) is retained for backward compat — to be dropped in a later migration
-- once all callers have moved to the contact_id/lead_id/account_id shape.
ALTER TABLE tracked_links
  ADD COLUMN contact_id TEXT,
  ADD COLUMN lead_id    TEXT,
  ADD COLUMN account_id TEXT;

CREATE INDEX idx_tracked_links_contact_id ON tracked_links (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_tracked_links_lead_id    ON tracked_links (lead_id)    WHERE lead_id    IS NOT NULL;
CREATE INDEX idx_tracked_links_account_id ON tracked_links (account_id) WHERE account_id IS NOT NULL;

-- tracking_events: denormalized from tracked_links at insert time so sync can aggregate
-- per-Account without joining. Same back-compat note for member_id applies here.
ALTER TABLE tracking_events
  ADD COLUMN contact_id TEXT,
  ADD COLUMN lead_id    TEXT,
  ADD COLUMN account_id TEXT;

CREATE INDEX idx_tracking_events_account_id ON tracking_events (account_id) WHERE account_id IS NOT NULL;
