-- Additive migration; existing users, passwords, workspaces, and sessions stay intact.
-- Apply after 202609250001_maildesk.sql and before deploying OAuth support.
BEGIN;
SET LOCAL search_path = maildesk, pg_catalog;
CREATE TABLE IF NOT EXISTS oauth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS oauth_identities_user ON oauth_identities(user_id);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS oauth_pending (
  token_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_pending_expiry ON oauth_pending(expires_at);
REVOKE ALL ON oauth_identities, oauth_states, oauth_pending FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON maildesk.oauth_identities, maildesk.oauth_states, maildesk.oauth_pending FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
