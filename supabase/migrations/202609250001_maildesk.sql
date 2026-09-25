-- Run once in the new Supabase project's SQL editor, before deployment.
BEGIN;
CREATE SCHEMA IF NOT EXISTS maildesk;
REVOKE ALL ON SCHEMA maildesk FROM PUBLIC;
SET LOCAL search_path = maildesk, pg_catalog;
CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id), kind TEXT NOT NULL, config TEXT NOT NULL,
      verified_at TEXT, info TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', consent TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(org_id,email));
    CREATE TABLE IF NOT EXISTS suppressions (
      org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL, reason TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(org_id,email));
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'text', status TEXT NOT NULL DEFAULT 'draft',
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recipients (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), org_id TEXT NOT NULL REFERENCES organizations(id),
      email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, message_id TEXT,
      attempted_at TEXT, UNIQUE(campaign_id,email));
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), campaign_id TEXT,
      email TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_org_time ON attempts(org_id,created_at);
    CREATE INDEX IF NOT EXISTS recipients_queue ON recipients(campaign_id,status);
    CREATE INDEX IF NOT EXISTS campaigns_org ON campaigns(org_id,created_at);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (
      org_id TEXT NOT NULL REFERENCES organizations(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id), PRIMARY KEY(org_id,request_key));
    CREATE TABLE IF NOT EXISTS gates (org_id TEXT PRIMARY KEY REFERENCES organizations(id), next_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count BIGINT NOT NULL, until_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS draft_previews (token TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), preview TEXT NOT NULL, expires_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS previews_expiry ON draft_previews(expires_at);
    CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(until_at);
  
-- These tables are used by the server only, never by the browser Data API.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA maildesk FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA maildesk FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
