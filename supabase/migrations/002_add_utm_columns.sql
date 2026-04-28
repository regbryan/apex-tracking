-- Migration: 002_add_utm_columns
-- Apply via Supabase SQL Editor:
--   1. Go to your Supabase project → SQL Editor
--   2. Paste this file contents
--   3. Click Run
-- Verify: tracked_links has utm_source, utm_medium, utm_campaign, utm_term, utm_content columns

ALTER TABLE tracked_links
  ADD COLUMN utm_source   TEXT,
  ADD COLUMN utm_medium   TEXT,
  ADD COLUMN utm_campaign TEXT,
  ADD COLUMN utm_term     TEXT,
  ADD COLUMN utm_content  TEXT;
