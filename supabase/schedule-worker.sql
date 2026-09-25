-- Run AFTER the migration, deployment, and Vault setup in DEPLOYMENT.md.
-- Never put the worker secret directly into a stored cron command.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'maildesk_public_url')
    OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'maildesk_worker_secret') THEN
    RAISE EXCEPTION 'Create maildesk_public_url and maildesk_worker_secret in Supabase Vault first.';
  END IF;
END $$;

-- The named schedule is updated, rather than duplicated, when rerun.
-- One recipient per minute is sufficient for this initial 5-10 email test.
SELECT cron.schedule(
  'maildesk-worker',
  '* * * * *',
  $job$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'maildesk_public_url') || '/internal/worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'maildesk_worker_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
    WHERE EXISTS (SELECT 1 FROM maildesk.campaigns WHERE status = 'queued')
       OR EXISTS (SELECT 1 FROM maildesk.attempts WHERE status = 'sending');
  $job$
);

-- To stop scheduling later:
-- SELECT cron.unschedule('maildesk-worker');
