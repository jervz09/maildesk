# Deploy Maildesk for Gmail testing

Use **Maildesk** for the app, **maildesk** for the private Git repository and
Supabase project, and **maildesk-app** for the Vercel project (if available).
Use **production** as the production branch. A separate release branch adds
little value for this initial test; later changes can use feature branches.

This setup supports public company registration. Each owner connects their own
Gmail account. The Gmail default is 10 attempts per rolling 24 hours and can be
changed in provider settings. No shared Gmail credentials are bundled into the app.
There is no existing data to migrate.

## 1. Create the Supabase project

Create a new project at https://supabase.com/dashboard with a strong database
password. Choose a nearby region, such as Singapore if available. Store the
database password privately.

In the SQL editor, run `supabase/migrations/202609250001_maildesk.sql`.
It creates the private `maildesk` schema. Do not add this schema to the Data API's
exposed schemas. Browser code talks only to the Maildesk API; database credentials
stay on the server. This version retains Maildesk's own login and sessions, so
Supabase Auth configuration and publishable/service-role API keys are not needed.

Click **Connect → Transaction pooler** and copy the URI, including the exact host,
username and port 6543. Substitute your database password, URL-encoding reserved
characters. Save this URI directly as `DATABASE_URL` in Vercel. Do not send it in chat.
The adapter uses unnamed parameterized queries, transaction-scoped locks, and a
single client per warm instance; it does not depend on session state in the pooler.
TLS certificate verification is enabled. If your endpoint requires a custom CA,
set `DATABASE_CA_CERT` to the trusted PEM certificate; do not disable verification.

## 2. Generate and retain deployment secrets

With Node 24 active, run:

```sh
npm run setup:deployment
```

This creates the ignored, private `.env.deployment-secrets` file without displaying
secrets in the terminal. It refuses to overwrite an existing file. Copy its values
into Vercel and back up the file securely. Keep `ENCRYPTION_KEY` stable across
redeployments: it encrypts provider passwords and signs unsubscribe links.

## 3. Create the Git repository

Create an empty **private** GitHub repository named `maildesk`, without a README,
license or gitignore. The local checkout already has Git initialized; it initially
has no commits. Use your new repository URL for `origin`.

From the `email-service` directory, when ready to publish the code:

```sh
git add .gitignore .nvmrc .env.example .env.production.example README.md DEPLOYMENT.md package.json package-lock.json app.mjs vercel.json public server scripts supabase test
git commit -m "feat: prepare Maildesk for Vercel and Supabase"
git remote add origin https://github.com/YOUR_USERNAME/maildesk.git
git push -u origin production
```

The real `.env`, `.env.deployment-secrets`, local data and Vercel metadata are
ignored. The explicit file list above includes only source and templates.

## 4. Import into Vercel

Import the Git repository at https://vercel.com/new. Use:

| Setting | Value |
| --- | --- |
| Project name | `maildesk-app`, or an available variant |
| Root directory | Repository root |
| Framework preset | Express |
| Node.js version | 24.x |
| Install command | `npm ci` |
| Build/output overrides | Leave unset; use the Express preset |
| Production branch | `production` |

Set these variables for the **Production** environment before deployment:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase transaction pooler URI |
| `PUBLIC_URL` | The assigned stable HTTPS domain, e.g. `https://maildesk-app.vercel.app` |
| `ENCRYPTION_KEY` | Value from `.env.deployment-secrets` |
| `WORKER_SECRET` | Value from `.env.deployment-secrets` |
| `ALLOW_SIGNUP` | `true` |
| `NODE_ENV` | `production` |

The domain above is an example, not a reservation. If Vercel assigns a different
domain, update `PUBLIC_URL` and redeploy before using signup or sending email.
Use the stable production domain to access the app; mutation requests from other
origins are deliberately rejected. Keep production database/secrets out of Preview
environments. Preview deployments need their own database, public URL and secrets.

After deployment, confirm `/api/health` returns `{"ok":true}`. This checks database
connectivity as well as the handler. Confirm the home page, CSS and JavaScript load.
The entry point is `app.mjs`; it starts no timer and writes no local database.

Public signup, unsubscribe links and the Supabase worker require a publicly
reachable production domain. If Vercel Deployment Protection restricts production,
configure public access for this deployment. Do not expose a preview database.

## 5. Schedule campaign processing

In Supabase **Vault**, create these secrets:

| Name | Value |
| --- | --- |
| `maildesk_public_url` | Same HTTPS origin as `PUBLIC_URL`, without a trailing slash |
| `maildesk_worker_secret` | Same value as Vercel's `WORKER_SECRET` |

Then run `supabase/schedule-worker.sql` in the SQL editor. It enables Cron and
pg_net and registers one named job. Every minute, the job calls the authenticated
Vercel worker only when queued campaigns or unfinished sends exist. Each invocation
processes at most one recipient. A 5–10 recipient campaign normally needs about
5–10 minutes, plus a final tick to mark completion. No Vercel Cron plan is required.

Overlapping invocations use database transactions to claim work. A company cannot
have two active sends. Attempts older than ten minutes become uncertain and pause
the campaign; they are never automatically resent. API test emails send immediately.

Monitor **Cron → job runs** and Vercel function logs. A successful cron SQL execution
only means an HTTP request was queued. Check the HTTP result as well:

```sql
SELECT id, status_code, timed_out, error_msg, created
FROM net._http_response
ORDER BY created DESC
LIMIT 10;
```

Expect HTTP 200. A 401 can indicate a worker-secret mismatch or deployment
protection. HTTP 500 requires checking database/runtime configuration and logs.
When changing the public domain or worker secret, update both Vercel and Vault.

## 6. Connect Gmail and test

1. Create a workspace in Maildesk using public signup.
2. Add your company name and postal address in Settings.
3. Enable Google 2-Step Verification and create an **app password** at
   https://myaccount.google.com/apppasswords. Some managed accounts do not permit
   app passwords; use an eligible test Gmail account in that case.
4. In **Email providers → Gmail**, enter your Gmail address and app password.
   Keep the daily limit at **10** initially. Save, then check the connection.
5. Explicitly send one test email to an address you own and check its inbox/spam.
   No email is sent by saving settings or checking the connection.
6. Add opted-in test contacts, create a campaign, review it, and confirm sending.
   The test send counts toward the daily limit, so one test plus nine campaign
   recipients uses the initial allowance.
7. Verify recipient status, pause/resume, and the unsubscribe confirmation link.

Only enter the app password in Maildesk's provider form. It is encrypted in the
database and never returned to the browser. No Gmail environment variables are
needed. Google may block cloud-origin sign-ins or impose account-specific limits;
the live connection check and received test message are required deployment checks.

## Validation and scope

Local verification:

```sh
npm test
npm run check
# Optional: an isolated PostgreSQL instance, with permission to create test schemas.
TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/postgres npm test
```

Postgres tests create and remove randomly named `maildesk_test_*` schemas; they
never clear the application's `maildesk` schema. Provider adapters are mocked, so
automated tests do not send real emails. Supabase TLS, Vault/Cron extensions,
Vercel routing and Gmail delivery still need the live checks above.

CSV uploads are limited to 3 MB, with a 4 MB serialized request limit to stay below
Vercel's payload ceiling. Contacts and recipient snapshots use batched inserts.
Large campaigns need throughput/load validation before increasing this test setup.

This is a public-signup testing deployment. The existing limitations remain:
one owner per company; no email verification, password reset, team invitations,
Google OAuth or automatic bounce ingestion. The low Gmail default is per workspace,
not a global site-wide cap. No paid services or plans are purchased by these files.

References:
- https://vercel.com/docs/frameworks/backend/express
- https://vercel.com/docs/functions/limitations
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/cron/quickstart
- https://supabase.com/docs/guides/database/vault
- https://support.google.com/accounts/answer/185833
