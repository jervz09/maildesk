import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { createOAuthProviders, OAuthError, oauthConfig } from "../server/oauth-providers.mjs";
import { hash } from "../server/security.mjs";
import { postgresSql } from "../server/postgres.mjs";
import { testDatabase } from "./support/postgres.mjs";

const origin = "http://localhost:4320";
const owner = { company: "Existing company", email: "owner@example.com", password: "existing strong password" };
let service, agent, adapters, identities, failure, exchanges;
beforeEach(async () => {
  exchanges = [];
  identities = {
    google: { subject: "google-123", email: "social@example.com" },
    github: { subject: "123456", email: "social@example.com" },
  };
  failure = null;
  adapters = createOAuthProviders({
    google: { clientId: "test-google-client", clientSecret: "test-google-secret" },
    github: { clientId: "test-github-client", clientSecret: "test-github-secret" },
  });
  for (const id of Object.keys(adapters)) adapters[id].exchange = async (flow) => {
    exchanges.push(flow);
    if (failure) throw failure;
    return identities[id];
  };
  service = createApp({
    databasePath: ":memory:", db: await testDatabase(), key: randomBytes(32).toString("hex"),
    publicUrl: origin, allowSignup: true, oauthProviders: adapters,
  });
  agent = request.agent(service.app);
});
afterEach(async () => service.db.close());
const post = (path, body = {}, client = agent) => client.post(`/api${path}`).set("Origin", origin).send(body);
async function start(provider, body = {}, client = agent) {
  const response = await post(`/auth/oauth/${provider}/start`, body, client).expect(200);
  const url = new URL(response.body.url);
  return { response, url, path: `/api/auth/oauth/${provider}/callback?code=valid-code&state=${url.searchParams.get("state")}` };
}
async function begin(provider, client = agent) {
  const flow = await start(provider, {}, client);
  const response = await client.get(flow.path).expect(303);
  return { ...flow, response };
}
async function complete(provider, client = agent) {
  await begin(provider, client);
  return post("/auth/oauth/complete", { company: "Social workspace" }, client).expect(200);
}
const count = async (table) => (await service.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).total;

for (const provider of ["google", "github"]) {
  test(`${provider}: new account, existing identity, stable subject, logout and session persistence`, async () => {
    const flow = await begin(provider);
    assert.equal(flow.response.headers.location, "/#oauth-complete");
    await agent.get("/api/me").expect(401);
    const pending = (await agent.get("/api/auth/oauth/pending").expect(200)).body;
    assert.equal(pending.mode, "create");
    assert.equal(pending.email, "social@example.com");
    await post("/auth/oauth/complete", {}).expect(400);
    await post("/auth/oauth/complete", { company: "Social workspace" }).expect(200);
    const first = (await agent.get("/api/me").expect(200)).body;
    assert.equal(first.organization.name, "Social workspace");
    assert.equal((await agent.get("/api/me").expect(200)).body.organization.id, first.organization.id);
    await post("/auth/logout").expect(200);
    await agent.get("/api/me").expect(401);
    identities[provider].email = "changed-at-provider@example.com";
    assert.equal((await begin(provider)).response.headers.location, "/#overview");
    assert.equal((await agent.get("/api/me").expect(200)).body.organization.id, first.organization.id);
    assert.equal(await count("users"), 1);
    assert.equal(await count("oauth_identities"), 1);
  });
  test(`${provider}: email collision requires password proof and preserves password login`, async () => {
    await post("/auth/register", owner).expect(201);
    const original = (await agent.get("/api/me")).body.organization.id;
    await post("/auth/logout").expect(200);
    identities[provider].email = owner.email.toUpperCase();
    await begin(provider);
    assert.equal((await agent.get("/api/auth/oauth/pending")).body.mode, "link");
    await post("/auth/oauth/complete", { company: "Duplicate" }).expect(401);
    await post("/auth/oauth/complete", { password: "incorrect password" }).expect(401);
    assert.equal(await count("oauth_identities"), 0);
    await post("/auth/oauth/complete", { password: owner.password }).expect(200);
    assert.equal((await agent.get("/api/me")).body.organization.id, original);
    assert.equal(await count("users"), 1);
    await post("/auth/logout").expect(200);
    await post("/auth/login", owner).expect(200);
    await post("/auth/logout").expect(200);
    assert.equal((await begin(provider)).response.headers.location, "/#overview");
  });
  test(`${provider}: cancellation, wrong state/browser/provider, replay, missing code, expired state`, async () => {
    let flow = await start(provider);
    await request(service.app).get(flow.path).expect(303).expect("Location", "/#oauth-error=state");
    const wrongProvider = provider === "google" ? "github" : "google";
    await agent.get(flow.path.replace(`/${provider}/`, `/${wrongProvider}/`)).expect(303).expect("Location", "/#oauth-error=state");
    await agent.get(flow.path.replace(/state=.*/, "state=invalid")).expect(303).expect("Location", "/#oauth-error=state");
    await agent.get(flow.path.replace("code=valid-code", "error=access_denied")).expect(303).expect("Location", "/#oauth-error=cancelled");
    await agent.get(flow.path).expect(303).expect("Location", "/#oauth-error=state");
    flow = await start(provider);
    await agent.get(flow.path.replace("code=valid-code&", "")).expect(303).expect("Location", "/#oauth-error=state");
    flow = await start(provider);
    await service.db.prepare("UPDATE oauth_states SET expires_at=?").run(0);
    await agent.get(flow.path).expect(303).expect("Location", "/#oauth-error=state");
    assert.equal(exchanges.length, 0);
    assert.equal(await count("sessions"), 0);
  });
  test(`${provider}: provider failures and unverified email do not expose raw errors`, async () => {
    failure = new OAuthError("email");
    assert.equal((await begin(provider)).response.headers.location, "/#oauth-error=email");
    failure = new Error("sensitive provider response access_token=NEVER_EXPOSE");
    const response = (await begin(provider)).response;
    assert.equal(response.headers.location, "/#oauth-error=provider");
    assert.doesNotMatch(response.text, /NEVER_EXPOSE/);
    assert.equal(await count("users"), 0);
  });
}

test("OAuth config advertises only fully configured providers; credentials never reach setup", async () => {
  assert.deepEqual(oauthConfig({ GOOGLE_CLIENT_ID: "id" }), {});
  assert.deepEqual(oauthConfig({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }), { google: { clientId: "id", clientSecret: "secret" } });
  const setup = (await agent.get("/api/setup")).body;
  assert.deepEqual(setup.oauthProviders, [{ id: "google", name: "Google" }, { id: "github", name: "GitHub" }]);
  assert.doesNotMatch(JSON.stringify(setup), /client|secret/);
  await post("/auth/oauth/microsoft/start").expect(404);
  await post("/auth/oauth/__proto__/start").expect(404);
});
test("state and PKCE are browser bound; ephemeral identity payloads are encrypted", async () => {
  const flow = await start("google");
  const row = await service.db.prepare("SELECT * FROM oauth_states").get();
  assert.equal(row.state_hash, hash(flow.url.searchParams.get("state")));
  assert.doesNotMatch(row.payload, /verifier|nonce|client/);
  assert.match(flow.response.headers["set-cookie"].join(";"), /HttpOnly; SameSite=Lax/);
  const response = await agent.get(flow.path).expect(303);
  const expected = createHash("sha256").update(exchanges[0].verifier).digest("base64url");
  assert.equal(flow.url.searchParams.get("code_challenge"), expected);
  assert.equal(flow.url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(flow.url.searchParams.get("nonce"), exchanges[0].nonce);
  assert.equal(exchanges[0].redirectUri, `${origin}/api/auth/oauth/google/callback`);
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(await count("oauth_states"), 0);
  assert.doesNotMatch((await service.db.prepare("SELECT payload FROM oauth_pending").get()).payload, /social@example|google-123/);
});
test("OAuth start and completion reject cross-origin, non-JSON, and bearer-header bypasses", async () => {
  for (const path of ["google/start", "complete", "cancel"]) {
    await agent.post(`/api/auth/oauth/${path}`).send({}).expect(403);
    await agent.post(`/api/auth/oauth/${path}`).set("Origin", "https://evil.test").set("Authorization", "Bearer bogus").send({}).expect(403);
    await agent.post(`/api/auth/oauth/${path}`).set("Origin", origin).type("form").send({}).expect(415);
  }
  const flow = await start("github", { redirectUri: "https://evil.test/callback", returnTo: "https://evil.test" });
  assert.equal(flow.url.searchParams.get("redirect_uri"), `${origin}/api/auth/oauth/github/callback`);
});
test("pending completion is browser bound, one use, cancellable and expiring", async () => {
  await begin("google");
  await request(service.app).get("/api/auth/oauth/pending").expect(400);
  await post("/auth/oauth/complete", { company: "Spoof" }, request.agent(service.app)).expect(400);
  await post("/auth/oauth/complete", { company: "Original" }).expect(200);
  await post("/auth/oauth/complete", { company: "Duplicate" }).expect(400);
  identities.github.email = "another@example.com";
  await begin("github");
  await post("/auth/oauth/cancel").expect(200);
  await agent.get("/api/auth/oauth/pending").expect(400);
  await begin("github");
  await service.db.prepare("UPDATE oauth_pending SET expires_at=?").run(0);
  await post("/auth/oauth/complete", { company: "Expired" }).expect(400);
  assert.equal(await count("users"), 1);
});
test("OAuth-only users can explicitly link a second provider after proving their existing provider", async () => {
  await complete("google");
  const original = (await agent.get("/api/me")).body.organization.id;
  await post("/auth/logout");
  await begin("github");
  const pending = (await agent.get("/api/auth/oauth/pending")).body;
  assert.equal(pending.mode, "link");
  assert.deepEqual(pending.providers, [{ id: "google", name: "Google" }]);
  const proof = await start("google", { link: true });
  await agent.get(proof.path).expect(303).expect("Location", "/#overview");
  assert.equal((await agent.get("/api/me")).body.organization.id, original);
  assert.equal(await count("users"), 1);
  assert.equal(await count("oauth_identities"), 2);
  await post("/auth/logout");
  assert.equal((await begin("github")).response.headers.location, "/#overview");
});
test("linking rejects proof from another account and retries retain the legitimate pending identity", async () => {
  await complete("google");
  await post("/auth/logout");
  identities.google = { subject: "other-google-user", email: "other@example.com" };
  await complete("google");
  await post("/auth/logout");
  await begin("github");
  const proof = await start("google", { link: true });
  await agent.get(proof.path).expect(303).expect("Location", "/#oauth-error=conflict");
  assert.equal(await count("oauth_identities"), 2);
  await agent.get("/api/me").expect(401);
});
test("concurrent creation/completion cannot create duplicate users or attach an identity twice", async () => {
  const other = request.agent(service.app);
  await begin("google");
  await begin("google", other);
  const responses = await Promise.all([
    post("/auth/oauth/complete", { company: "First" }),
    post("/auth/oauth/complete", { company: "Second" }, other),
  ]);
  assert.deepEqual(responses.map((item) => item.status).sort(), [200, 409]);
  assert.equal(await count("users"), 1);
  assert.equal(await count("organizations"), 1);
  assert.equal(await count("oauth_identities"), 1);
});
test("public signup disablement blocks new social users but permits existing identities and safe linking", async () => {
  await complete("google");
  const disabled = createApp({ db: service.db, key: "ab".repeat(32), publicUrl: origin, allowSignup: false, oauthProviders: adapters });
  const client = request.agent(disabled.app);
  assert.equal((await begin("google", client)).response.headers.location, "/#overview");
  await post("/auth/logout", {}, client);
  identities.github.email = "new@example.com";
  assert.equal((await begin("github", client)).response.headers.location, "/#oauth-error=signup");
  identities.github.email = "social@example.com";
  assert.equal((await begin("github", client)).response.headers.location, "/#oauth-complete");
  assert.equal((await client.get("/api/auth/oauth/pending")).body.mode, "link");
});
test("new OAuth tables are schema-qualified for pooled Postgres connections", () => {
  assert.equal(postgresSql("DELETE FROM oauth_states WHERE state_hash=? RETURNING payload"), "DELETE FROM maildesk.oauth_states WHERE state_hash=$1 RETURNING payload");
  assert.match(postgresSql("SELECT user_id FROM oauth_identities WHERE provider=?"), /FROM maildesk.oauth_identities/);
  assert.match(postgresSql("INSERT INTO oauth_pending VALUES (?,?,?)"), /INTO maildesk.oauth_pending/);
});
