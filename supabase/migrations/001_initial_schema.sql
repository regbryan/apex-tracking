-- Migration: 001_initial_schema
-- Apply via Supabase SQL Editor:
--   1. Go to your Supabase project → SQL Editor
--   2. Paste this file contents
--   3. Click Run
-- Verify: All 4 tables appear in Table Editor: tracked_links, tracking_events, sync_log, sync_locks

-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enum for event types
CREATE TYPE event_type AS ENUM ('click', 'pageview', 'download');

-- tracked_links: maps opaque tokens to Salesforce Campaign Members
-- IMPORTANT: destination_or_file constraint enforces exactly one of the two URL columns is set
CREATE TABLE tracked_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  destination_url TEXT,
  file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT destination_or_file CHECK (
    (destination_url IS NOT NULL AND file_url IS NULL) OR
    (file_url IS NOT NULL AND destination_url IS NULL)
  )
);

CREATE INDEX idx_tracked_links_token ON tracked_links (token);

-- tracking_events: one row per click/pageview/download event
CREATE SEQUENCE tracking_events_sequence_id_seq;

CREATE TABLE tracking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_link_id UUID NOT NULL REFERENCES tracked_links(id),
  campaign_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  event_type event_type NOT NULL,
  page_url TEXT,
  file_name TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sequence_id BIGINT NOT NULL DEFAULT nextval('tracking_events_sequence_id_seq')
);

CREATE INDEX idx_tracking_events_campaign ON tracking_events (campaign_id);
CREATE INDEX idx_tracking_events_member ON tracking_events (member_id);
CREATE INDEX idx_tracking_events_sequence ON tracking_events (sequence_id);

-- sync_log: audit trail of each cron sync run
CREATE TABLE sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sequence_id BIGINT NOT NULL DEFAULT 0,
  records_processed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  failed_member_ids JSONB,
  error_detail TEXT
);

-- sync_locks: singleton row preventing concurrent sync runs
CREATE TABLE sync_locks (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at TIMESTAMPTZ,
  locked_by TEXT
);

-- Insert the singleton lock row (unlocked by default)
INSERT INTO sync_locks (id, locked_at, locked_by) VALUES (1, NULL, NULL);
