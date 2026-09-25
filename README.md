# Maildesk

A standalone email service with a web UI. Each company has its own owner login,
encrypted AWS SES / SMTP settings, contacts, campaigns, suppressions, and API keys.
It is independent of PawnHero; a CMS can integrate through its HTTP API.

## Vercel + Supabase deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the initial public-signup Gmail test setup.
Vercel runs the Express API and static UI, Supabase Postgres stores application
state, and Supabase Cron invokes a bounded, authenticated campaign worker.
The local SQLite workflow below remains available for development.

## Local setup

Requires Node.js 24 or later. Uses persistent SQLite; no separate database service.

```sh
npm ci
npm run setup
npm start
```

Open **http://localhost:4320** and create your company workspace. No default password,
sample recipients, or provider credentials are installed. `npm run setup` creates a
private `.env` encryption key and leaves an existing `.env` untouched.

For this machine, activate Node first if needed:

```sh
export PATH=/home/ph-admin/.nvm/versions/node/v24.21.0/bin:$PATH
```

## Connect a provider

In **Email providers**, choose AWS SES, Gmail, or custom SMTP, save the settings,
then **Check connection**. Credentials are encrypted using AES-256-GCM with the
company ID as authenticated data. Secrets are never returned by the API. Empty
secret fields preserve saved values; changing provider type requires new secrets.

### AWS SES

- Create an AWS account outside this app. Maildesk connects existing accounts;
  it does not register AWS accounts or provision IAM resources.
- Verify your sender/domain in your selected region, publish DKIM DNS records,
  and request SES production access. This version requires production access for
  both tests and campaigns. AWS controls approval and quotas.
- Enter a dedicated IAM access key and secret; temporary session tokens are also
  supported but must be replaced when they expire. No root credentials.
- Grant `ses:SendEmail`, `ses:GetAccount`, and `ses:GetEmailIdentity`, scoped to the
  resources supported by each action. Optional configuration set must already exist.
- Enable SES bounce/complaint suppression. Configure provider feedback monitoring;
  this version does not ingest SES SNS events automatically.
- Set a daily limit within your account's SES quota. AWS may impose a lower rate.

Official guides: [identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html),
[production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

### Gmail app password

- Enable Google 2-Step Verification and generate an app password where available.
- Choose Gmail, enter the address and app password, and save. The preset uses
  `smtp.gmail.com:465` with TLS and uses that Gmail address as the sender.
- The default application daily limit is 10; the preset permits at most 500
  attempts in a rolling 24 hours. This is an application safeguard, not a promise
  of available Google quota. Google's account limits still apply.
- Some managed accounts and security policies do not offer app passwords.
  Google OAuth is not implemented in this version.

[Google app password help](https://support.google.com/accounts/answer/185833),
[Nodemailer Gmail guide](https://nodemailer.com/guides/using-gmail).

### Custom SMTP

Use a public SMTP hostname, username/password, and authorized sender. Port 465
uses TLS; port 587 requires STARTTLS. Certificate verification cannot be disabled.
Private, loopback, link-local, and reserved IP destinations are blocked; the
validated DNS address is pinned during the connection to prevent rebinding.

The connection check verifies credentials and connectivity. Send a test to check
sender authorization. The app never sends email merely by saving or checking settings.

## Campaign workflow

1. Add the company name and postal address in **Settings**.
2. Import CSV with `email,name` headers (3 MB UI limit, 100,000 contacts/company)
   or add opted-in contacts manually/API. Specify the consent source.
3. Create a campaign in HTML or plain-text format. The draft snapshots subscribed contacts.
4. Review the subject, message, and audience, then explicitly confirm consent.
5. The durable queue sends individual messages, at most one attempt per company
   every 1.1 seconds. Limits are 100,000 attempts per UTC month and the configured
   rolling 24-hour provider limit. Tests and unsuccessful attempts count.

Campaigns require a **public HTTPS `PUBLIC_URL`** so unsubscribe links are reachable.
Local setup, imports, drafts, connection checks, and individual test emails work on
localhost. Set up HTTPS before queuing real campaigns. Footer unsubscribe links
use signed company-scoped tokens. GET shows confirmation; POST suppresses the address.
One-click List-Unsubscribe headers use the same POST endpoint. Imports never clear
suppression. Add known bounces/complaints through Audience → Suppress.

`accepted` means the provider accepted the message, not confirmed delivery. A send
error pauses remaining work. Uncertain responses and interrupted sends are never
retried automatically. Pausing cannot recall an in-flight send. Resuming only sends
pending recipients. Final status can be completed with failed/uncertain recipients;
inspect the recipient counts. Provider/company configuration is locked during
queued or in-flight sends.

## HTML email campaigns

In the campaign editor, choose **HTML email**, then paste your HTML or import a
`.html`/`.htm` file (maximum 50,000 characters). Click **Preview message** to render
it without saving or sending. Save the draft to review the rendered email and its
plain-text fallback before queuing.

Use inline CSS for layout, color, and typography. Tables, headings, links, and
HTTPS images are supported. The original source is retained for editing; active
content, event handlers, scripts, forms, style blocks, and CSS URL requests are
removed from previews and outgoing messages. The app automatically creates the
plain-text alternative and adds the company footer/unsubscribe link to both formats.

Rendered previews run in an isolated iframe with external images blocked and links
disabled. Actual emails keep supported HTTPS image URLs and normal links. Preview
rendering may differ from individual email clients. This is an HTML source editor,
not a drag-and-drop template designer.

API callers can pass `contentType:"html"` with the HTML in `body`; the API default
remains `"text"` for compatibility. Responses expose `content_type`. Updating an
existing draft without specifying contentType preserves its format. An additive
startup migration marks all older campaigns as text without changing their content.

## Integrate a CMS or another application

Create a company key under **Integrations** and store it on the calling server.
The full key appears once; only a hash is stored. Keys cannot read/change provider
credentials or company settings. All IDs and data are scoped to the authenticated
company. Use `Authorization: Bearer md_...` with JSON bodies.

| Method | Endpoint                      | Purpose                                                        |
| ------ | ----------------------------- | -------------------------------------------------------------- |
| GET    | `/api/v1/contacts?offset=0`   | List contacts, 500 per page                                    |
| POST   | `/api/v1/contacts`            | Import `{contacts:[{email,name}],consent}`                     |
| GET    | `/api/v1/campaigns`           | Latest 100 campaigns                                           |
| POST   | `/api/v1/campaigns`           | Create `{name,subject,body,contentType:"html",audience:"all"}` |
| GET    | `/api/v1/campaigns/:id`       | Status, counts, first 100 recipient outcomes                   |
| PUT    | `/api/v1/campaigns/:id`       | Edit draft name, subject, body, and contentType                |
| POST   | `/api/v1/campaigns/:id/start` | Queue with `{confirmConsent:true}`                             |
| POST   | `/api/v1/campaigns/:id/pause` | Pause remaining sends                                          |

For a selected audience, send `audience:"selected",contactIds:[...]` when creating
a campaign. Supply `Idempotency-Key` (8–128 letters/numbers/underscores/hyphens) on
campaign creation to safely repeat the same request. A different payload with the
same key returns 409. Repeated starts on a queued campaign do not enqueue duplicates.

## Self-hosted SQLite deployment

The following applies only to the local SQLite entry point (`server/index.mjs`).
For Vercel, follow [DEPLOYMENT.md](DEPLOYMENT.md).

Run one Node process against one database file. Startup takes a process lock and
recovers interrupted sends as uncertain. SQLite WAL keeps state between restarts.
Use a persistent local disk and back up the database together with the encryption
key. Losing the key makes provider credentials unreadable and invalidates unsubscribe
links. Do not use multiple containers/replicas or a network filesystem for this version.

1. Configure a DNS name and HTTPS reverse proxy to port 4320.
2. Set `PUBLIC_URL=https://mail.your-domain.example`, `NODE_ENV=production`,
   and `HOST=127.0.0.1` when the reverse proxy runs on the same host.
3. Keep `.env` private; set `ALLOW_SIGNUP=false` after onboarding your companies if
   you do not want public workspace registration. Restart after environment changes.
4. Run with your process manager and persistent storage. Health: `/api/health`.
5. Monitor provider bounces, complaints, quotas, and campaign pauses.

Session cookies are HttpOnly, SameSite=Strict, and Secure in production. State-changing
browser requests require the configured Origin and JSON. No wildcard CORS is enabled;
external applications should call the API from their backend. Do not trust arbitrary
forwarded proxy headers. Built-in auth throttling uses the direct connection IP when self-hosted;
configure proxy-level rate limiting for public deployments.

Scope of this first version: one owner per company; HTML and plain-text campaigns; manually
managed suppression plus public unsubscribe; no billing, invitation roles, password
reset, email verification, OAuth, attachment/template editor, automatic bounce-event
ingestion, or inbox-delivery/open/click analytics. SQLite remains single-process;
the Postgres deployment supports concurrent worker invocations. Public SaaS
launch needs those operational/account-lifecycle features according to your needs.

## Verification

```sh
npm test
npm run check
```

Tests use isolated in-memory databases and fake provider adapters, covering company
isolation, authentication, origin checks, encrypted/redacted credentials, CSV atomicity,
suppression, queue/consent behavior, quotas, ambiguous results, API key revocation,
idempotency, and crash recovery. They do not contact AWS/Google or send real messages.
