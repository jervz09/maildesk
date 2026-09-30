# Google and GitHub sign-in

Social login extends Maildesk's existing users and database-backed sessions. It
does not use Supabase Auth, NextAuth, Passport, or a second session system.
The only added library is `jose`, used on the server to verify Google ID tokens.
Google uses OpenID Connect; GitHub uses its OAuth authorization-code and
authenticated user/email endpoints. Both flows use PKCE S256 and browser-bound,
one-use state.

## Enable locally

Set these in the existing private `.env`, alongside `PUBLIC_URL` and
`ENCRYPTION_KEY`. Do not put them in `public/` or commit them.

```dotenv
PUBLIC_URL=http://localhost:4320
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

Each provider button appears only when **both** of its credentials are set.
Restart `npm run dev` after changing environment variables. `PUBLIC_URL` must
match the browser's origin, including its port; `localhost` and `127.0.0.1` are
different origins. Register exact callback URLs:

| Provider | Local callback |
| --- | --- |
| Google | `http://localhost:4320/api/auth/oauth/google/callback` |
| GitHub | `http://localhost:4320/api/auth/oauth/github/callback` |

For another local port, update `PORT`, `PUBLIC_URL`, and both provider callback
settings together. HTTPS is required in production.

### Google

1. In Google Cloud / Google Auth Platform, configure the branding, audience, and
   consent screen. Add test users if the app is in testing mode.
2. Create an OAuth client with application type **Web application**.
3. Add the Google callback from the table under **Authorized redirect URIs**.
4. Set the client ID and secret in the server environment and restart.

Only `openid email` scopes are requested. The server checks the ID token's
signature using Google's keys, issuer, audience, expiration, issue time, nonce,
authorized party, and verified-email claim. User IDs are based on Google's
stable `sub`, not their email address. Access tokens are not saved.

### GitHub

1. In GitHub Settings → Developer settings → OAuth Apps, create an OAuth App.
2. Set **Homepage URL** to `PUBLIC_URL` and **Authorization callback URL** to the
   GitHub callback from the table.
3. Set its client ID and client secret in the server environment and restart.
4. Use a separate OAuth App for local development and production callback URLs.

Only `read:user user:email` scopes are requested, with no repository permissions.
The server retrieves `/user` and `/user/emails`, requiring a verified primary
email. It stores the immutable numeric GitHub ID, not the changeable username.
The access token is used only for these callback requests and discarded.

## Production and migration

Before deploying the code, apply
[`supabase/migrations/202609290001_oauth_identities.sql`](supabase/migrations/202609290001_oauth_identities.sql)
to the same Supabase database used by Maildesk. New installations apply both
migrations in filename order. The migration is additive and can be rerun:

- `oauth_identities`: links local users to unique `(provider, provider_user_id)`
  identities; one user may have multiple identities.
- `oauth_states`: encrypted PKCE/nonce state, browser-bound and valid for ten minutes.
- `oauth_pending`: encrypted, ten-minute onboarding or linking requests.

Existing users, password hashes, workspaces, and sessions are retained. SQLite
creates these tables automatically at startup. The Postgres adapter qualifies
all three tables under `maildesk`; Supabase browser roles receive no access.

Set the four credentials in the hosting provider's **server-side production
environment**, retain the current `ENCRYPTION_KEY`, and configure:

```text
{PUBLIC_URL}/api/auth/oauth/google/callback
{PUBLIC_URL}/api/auth/oauth/github/callback
```

For example, if the production origin is `https://maildesk-console.vercel.app`:

```text
https://maildesk-console.vercel.app/api/auth/oauth/google/callback
https://maildesk-console.vercel.app/api/auth/oauth/github/callback
```

Callback URLs are constructed from the configured origin, never the Host header,
request body, or arbitrary return URL. Provider setup and deploying this code do
not enable Gmail sending through OAuth: the existing Gmail app-password/SMTP
provider setup is unchanged.

## Account creation and linking

- **Already linked identity:** sign into its existing user/workspace, including
  when the provider email changes.
- **New identity, new email:** request a company name, then atomically create
  the workspace, local user, identity, and existing-style session.
- **New identity, existing email:** show an explicit linking screen. Require
  that local account's password, or a fresh sign-in with a provider already
  linked to that exact user. Matching email by itself never links accounts.
- **OAuth-only account:** the existing non-null password field receives a hash
  of a cryptographically random, undisclosed value. There is no usable password;
  the user signs in with a linked provider. This avoids changing existing users
  or the existing password-verification path.
- **`ALLOW_SIGNUP=false`:** blocks new social accounts but allows existing
  identities and explicit linking to existing accounts.

OAuth state and pending cookies are short-lived, HttpOnly, SameSite=Lax, and
Secure in production so browser redirects can complete. Existing seven-day
session cookies remain HttpOnly, SameSite=Strict, and Secure in production.
Mutations require same-origin JSON, including requests with an Authorization
header. Callback state is consumed atomically before token exchange; completion
is transactional and single-use. Tokens, raw provider errors, and credentials are
never returned to the UI or logged. Expired temporary rows are pruned on OAuth
start. A new flow in the same browser replaces the previous flow's cookie; if
using several tabs, finish the most recently started flow.

This application has no password-reset or email-verification flow for password
accounts. OAuth does not add one or change that limitation. Losing access to all
linked providers requires a separately designed account-recovery process.

## Test Google and GitHub

After configuring the provider, repeat this checklist for **each** provider:

1. Open Login or Register and select **Continue with Google/GitHub**.
2. Authorize with a verified email that is new to Maildesk. Enter a company name
   and confirm that the correct workspace opens. Reload to test persistence.
3. Sign out, then sign in with that provider again. Verify the original
   workspace is used and no duplicate account is created.
4. Cancel at the provider's consent screen. Verify the readable cancellation
   message and that password login still works.
5. Open `/api/auth/oauth/google/callback?state=invalid` (or the GitHub equivalent).
   Verify a friendly failure with no session or new user.
6. Use a provider email matching an existing password account. Verify linking
   requires that account's password, rejects an incorrect password, and keeps
   password login working after a successful link.
7. For an OAuth-only account, try its second provider with the same email, then
   choose **Verify with** its already linked provider. A different account at
   that provider must fail; the correct account must link to the same workspace.
8. Test an unverified GitHub primary email, and a temporarily unavailable
   provider. No account/session should be created and no raw error should leak.
9. Verify ordinary email/password registration, login, logout, and persistence.
   Password reset is not applicable because none exists in this application.

Automated regression/security tests:

```sh
npm run check
npm test
# Optional: disposable/local Postgres instance; creates and removes isolated schemas.
TEST_DATABASE_URL=postgresql://... npm test
```

Tests simulate provider endpoints, verify locally signed Google JWTs, and use
isolated databases. They cover expiry, replay, state/browser/provider mismatch,
cross-origin mutations, PKCE, identity/email verification, conflicting links,
concurrent completion, signup restrictions, sessions, and existing password auth.
They do not log into real Google/GitHub accounts or send messages. Live-provider
and production-Postgres checks still require configured credentials/environment.

## Adding a provider

1. Add its credential configuration and an adapter in `server/oauth-providers.mjs`.
   The adapter exposes `id`, `name`, `authorizationUrl`, and `exchange`.
2. `exchange` must validate the provider response and return only a stable
   `subject` and verified `email`. OIDC adapters must verify signature/issuer/
   audience/expiry/nonce. Never accept an identity supplied by the browser.
3. Add the official icon at `public/oauth/{id}.svg`, env examples, and adapter
   security tests. The common routes, session helper, linking, and UI are reused.
4. Providers with POST callbacks (for example some Apple flows) require a
   deliberate SameSite/CSRF callback design; do not relax the existing checks.

## Files and references

Server: `server/oauth-providers.mjs`, `server/oauth.mjs`, plus the existing app,
config, startup, SQLite and Postgres adapters. UI: `public/app.js`,
`public/style.css`, `public/oauth/*.svg`. Setup: env templates, package files,
the additive migration, and this guide. Tests: `test/oauth*.test.mjs` and the
Postgres migration loader.

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [GitHub OAuth authorization and PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub verified email API](https://docs.github.com/en/rest/users/emails)
- [jose token verification](https://github.com/panva/jose)
- [Google branding](https://developers.google.com/identity/branding-guidelines)
- [GitHub branding](https://brand.github.com/foundations/logo)
