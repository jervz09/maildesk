import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { testDatabase } from "./support/postgres.mjs";
import { createApp } from "../server/app.mjs";
import { publicSmtpAddress, failedDelivery } from "../server/providers.mjs";
const origin = "http://localhost:4320";
let service, alice, bob, orgA, orgB, sent, behavior;
const provider = {
  kind: "smtp",
  host: "smtp.example.com",
  port: 587,
  username: "mailer",
  password: "super-secret-smtp-password",
  from: "sender@example.com",
  fromName: "Acme",
  replyTo: "",
  dailyLimit: 100,
};
const call = (agent, method, path, body) =>
  agent[method](`/api${path}`).set("Origin", origin).send(body);
beforeEach(async () => {
  sent = [];
  behavior = null;
  service = createApp({
    databasePath: ":memory:",
    db: await testDatabase(),
    key: randomBytes(32).toString("hex"),
    publicUrl: origin,
    testing: true,
    providers: {
      verify: async () => ({
        ready: true,
        summary: "Mock connection verified",
      }),
      send: async (kind, config, message) => {
        sent.push({ kind, config, message });
        if (behavior) throw behavior;
        return "fake-message-id";
      },
    },
  });
  alice = request.agent(service.app);
  bob = request.agent(service.app);
  await call(alice, "post", "/auth/register", {
    company: "Acme",
    email: "owner@acme.test",
    password: "a secure password 123",
  }).expect(201);
  await call(bob, "post", "/auth/register", {
    company: "Beta",
    email: "owner@beta.test",
    password: "another secure password 123",
  }).expect(201);
  orgA = (await alice.get("/api/me")).body.organization.id;
  orgB = (await bob.get("/api/me")).body.organization.id;
});
afterEach(async () => await service.db.close());
async function ready(agent = alice) {
  await call(agent, "put", "/organization", {
    name: "Acme",
    address: "123 Main Street, Manila, Philippines",
  }).expect(200);
  await call(agent, "put", "/provider", provider).expect(200);
  await call(agent, "post", "/provider/verify", {}).expect(200);
}
async function draft(agent = alice) {
  await call(agent, "post", "/v1/contacts", {
    contacts: [{ email: "reader@example.com", name: "Reader" }],
    consent: "Newsletter signup",
  }).expect(201);
  return (
    await call(agent, "post", "/v1/campaigns", {
      name: "News",
      subject: "Hello",
      body: "From our company",
    }).expect(201)
  ).body;
}
test("authentication and company data are isolated", async () => {
  await request(service.app).get("/api/v1/contacts").expect(401);
  const item = await draft();
  assert.equal((await bob.get("/api/v1/contacts")).body.total, 0);
  await bob.get(`/api/v1/campaigns/${item.id}`).expect(404);
  await call(bob, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(404);
  await call(bob, "put", `/v1/campaigns/${item.id}`, {
    name: "Attack",
    subject: "Test",
    body: "No",
  }).expect(404);
  await call(alice, "post", "/auth/logout", {}).expect(200);
  await alice.get("/api/me").expect(401);
  await call(alice, "post", "/auth/login", {
    email: "owner@acme.test",
    password: "a secure password 123",
  }).expect(200);
});
test("cross-origin mutations are blocked", async () => {
  await alice
    .post("/api/organization")
    .set("Origin", "https://evil.test")
    .send({})
    .expect(403);
  await alice
    .put("/api/organization")
    .send({ name: "changed", address: "somewhere" })
    .expect(403);
  assert.equal((await alice.get("/api/me")).body.organization.name, "Acme");
});
test("provider secrets are encrypted, redacted, retained on blank, and tenant-bound", async () => {
  const response = await call(alice, "put", "/provider", provider).expect(200);
  assert.equal(response.body.password, undefined);
  const row = await service.db
    .prepare("SELECT * FROM providers WHERE org_id=?")
    .get(orgA);
  assert.ok(!row.config.includes(provider.password));
  assert.throws(() => service.crypto.decrypt(row.config, orgB));
  await call(alice, "post", "/provider/verify", {}).expect(200);
  await call(alice, "put", "/provider", { ...provider, password: "" }).expect(
    200,
  );
  assert.equal((await alice.get("/api/provider")).body.verifiedAt, null);
  assert.equal((await bob.get("/api/provider")).body, null);
  const saved = await service.db
    .prepare("SELECT config FROM providers WHERE org_id=?")
    .get(orgA);
  assert.equal(
    service.crypto.decrypt(saved.config, orgA).password,
    provider.password,
  );
});
test("Gmail preset forces TLS, sender, and conservative maximum", async () => {
  await call(alice, "put", "/provider", {
    ...provider,
    kind: "gmail",
    username: "example@gmail.com",
    dailyLimit: 501,
  }).expect(400);
  const result = await call(alice, "put", "/provider", {
    ...provider,
    kind: "gmail",
    username: "example@gmail.com",
    password: "abcd efgh ijkl mnop",
    dailyLimit: 100,
  }).expect(200);
  assert.equal(result.body.host, "smtp.gmail.com");
  assert.equal(result.body.port, 465);
  assert.equal(result.body.from, "example@gmail.com");
});
test("CSV import validates atomically, normalizes, deduplicates and preserves suppression", async () => {
  await call(alice, "post", "/contacts/import", {
    csv: "email,name\nALICE@example.com,Alice\nbroken,Bob",
    consent: "Opt in",
  }).expect(400);
  assert.equal((await alice.get("/api/v1/contacts")).body.total, 0);
  const result = await call(alice, "post", "/contacts/import", {
    csv: 'email,name\nALICE@example.com,"Alice, A"\nalice@example.com,Alice',
    consent: "Opt in",
  }).expect(200);
  assert.equal(result.body.added, 1);
  assert.equal(result.body.duplicates, 1);
  await call(alice, "post", "/contacts/suppress", {
    email: "alice@example.com",
    reason: "complaint",
  }).expect(200);
  await call(alice, "post", "/contacts/import", {
    csv: "email,name\nalice@example.com,Alice",
    consent: "New import",
  }).expect(200);
  assert.equal(
    (await alice.get("/api/v1/contacts")).body.contacts[0].suppression,
    "complaint",
  );
});
test("contact imports and recipient snapshots span multiple database batches", async () => {
  const contacts = Array.from({ length: 501 }, (_, index) => ({
    email: `batch${index}@example.com`,
    name: `Reader ${index}`,
  }));
  const response = await call(alice, "post", "/v1/contacts", {
    contacts,
    consent: "Test signup",
  }).expect(201);
  assert.equal(response.body.added, 501);
  const repeated = await call(alice, "post", "/v1/contacts", {
    contacts,
    consent: "Test signup",
  }).expect(201);
  assert.equal(repeated.body.added, 0);
  assert.equal(repeated.body.duplicates, 501);
  const item = (
    await call(alice, "post", "/v1/campaigns", {
      name: "Batch test",
      subject: "Hello",
      body: "A draft only",
    }).expect(201)
  ).body;
  assert.deepEqual(item.counts, [{ status: "pending", count: 501 }]);
  assert.equal(sent.length, 0);
});
test("drafts do not send; queue requires consent and ready provider; worker records acceptance", async () => {
  const item = await draft();
  assert.equal(sent.length, 0);
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {}).expect(400);
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(400);
  await ready();
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(200);
  await call(alice, "put", "/provider", provider).expect(409);
  await service.tick();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.text.includes("Unsubscribe:"));
  assert.ok(sent[0].message.text.includes("123 Main Street"));
  await service.tick();
  const result = (await alice.get(`/api/v1/campaigns/${item.id}`)).body;
  assert.equal(result.status, "completed");
  assert.equal(result.recipients[0].status, "accepted");
});
test("suppression is checked again at send time and unsubscribe GET does not mutate", async () => {
  await ready();
  const item = await draft();
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(200);
  const token = service.crypto.token(orgA, "reader@example.com");
  await request(service.app).get(`/unsubscribe/${token}`).expect(200);
  assert.equal(
    (await service.db.prepare("SELECT count(*) n FROM suppressions").get()).n,
    0,
  );
  await request(service.app)
    .post(`/unsubscribe/${token}`)
    .type("form")
    .send({ "List-Unsubscribe": "One-Click" })
    .expect(200);
  await service.tick();
  assert.equal(sent.length, 0);
  assert.equal(
    (await alice.get(`/api/v1/campaigns/${item.id}`)).body.recipients[0].status,
    "suppressed",
  );
  assert.equal(
    (
      await service.db
        .prepare("SELECT count(*) n FROM suppressions WHERE org_id=?")
        .get(orgB)
    ).n,
    0,
  );
  await request(service.app)
    .post(`/unsubscribe/${token.slice(0, -4)}xxxx`)
    .expect(400);
});
test("unknown outcomes pause campaigns and cannot be resent by resume", async () => {
  await ready();
  const item = await draft();
  behavior = new Error("Timeout");
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(200);
  await service.tick();
  let result = (await alice.get(`/api/v1/campaigns/${item.id}`)).body;
  assert.equal(result.status, "paused");
  assert.equal(result.recipients[0].status, "uncertain");
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(200);
  await service.tick();
  assert.equal(sent.length, 1);
  assert.equal((await alice.get("/api/dashboard")).body.usage.monthly, 1);
});
test("daily cap includes test sends and pauses queued campaigns", async () => {
  await ready();
  await call(alice, "put", "/provider", { ...provider, dailyLimit: 1 }).expect(
    200,
  );
  await call(alice, "post", "/provider/verify", {}).expect(200);
  await call(alice, "post", "/provider/test", { to: "owner@acme.test" }).expect(
    200,
  );
  const item = await draft();
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(200);
  await service.tick();
  assert.equal(sent.length, 1);
  assert.equal(
    (await alice.get(`/api/v1/campaigns/${item.id}`)).body.status,
    "paused",
  );
});
test("API keys are company scoped, cannot read provider settings, and can be revoked", async () => {
  const key = (await call(alice, "post", "/keys", { name: "CMS" }).expect(201))
    .body;
  const client = request(service.app);
  await client
    .get("/api/provider")
    .auth(key.token, { type: "bearer" })
    .expect(403);
  await client
    .post("/api/v1/contacts")
    .auth(key.token, { type: "bearer" })
    .send({ contacts: [{ email: "api@example.com" }], consent: "API opt-in" })
    .expect(201);
  assert.equal((await bob.get("/api/v1/contacts")).body.total, 0);
  const payload = { name: "Idempotent", subject: "News", body: "Hello" };
  const first = await client
    .post("/api/v1/campaigns")
    .auth(key.token, { type: "bearer" })
    .set("Idempotency-Key", "unique-request-123")
    .send(payload)
    .expect(201);
  const again = await client
    .post("/api/v1/campaigns")
    .auth(key.token, { type: "bearer" })
    .set("Idempotency-Key", "unique-request-123")
    .send(payload)
    .expect(201);
  assert.equal(first.body.id, again.body.id);
  await client
    .post("/api/v1/campaigns")
    .auth(key.token, { type: "bearer" })
    .set("Idempotency-Key", "unique-request-123")
    .send({ ...payload, body: "Changed" })
    .expect(409);
  await call(alice, "delete", `/keys/${key.id}`, {}).expect(200);
  await client
    .get("/api/v1/contacts")
    .auth(key.token, { type: "bearer" })
    .expect(401);
});
test("crash recovery does not retry in-flight attempts", async () => {
  const item = await draft();
  await service.db
    .prepare("UPDATE recipients SET status='sending' WHERE campaign_id=?")
    .run(item.id);
  service.recover();
  const detail = (await alice.get(`/api/v1/campaigns/${item.id}`)).body;
  assert.equal(detail.status, "paused");
  assert.equal(detail.recipients[0].status, "uncertain");
  await service.tick();
  assert.equal(sent.length, 0);
});
test("private SMTP addresses and mixed public/private DNS answers are blocked", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
  ]) {
    await assert.rejects(
      publicSmtpAddress("smtp.test", async () => [{ address: ip }]),
    );
  }
  await assert.rejects(
    publicSmtpAddress("smtp.test", async () => [
      { address: "8.8.8.8" },
      { address: "192.168.1.2" },
    ]),
  );
  assert.equal(
    await publicSmtpAddress("smtp.test", async () => [{ address: "8.8.8.8" }]),
    "8.8.8.8",
  );
  assert.equal(failedDelivery({ responseCode: 550 }).status, "failed");
  assert.equal(failedDelivery(new Error("timeout")).status, "uncertain");
});

test("HTML campaigns persist source and format, render safely, and send alternatives", async () => {
  await ready();
  await draft();
  const html =
    '<h1 style="color:#6654da">Welcome</h1><p>Special <strong>offer</strong></p><script>alert(1)</script>';
  const item = (
    await call(alice, "post", "/v1/campaigns", {
      name: "HTML news",
      subject: "Welcome",
      body: html,
      contentType: "html",
    }).expect(201)
  ).body;
  assert.equal(item.content_type, "html");
  assert.equal(item.body, html);
  assert.match(item.preview.html, /<strong>offer<\/strong>/);
  assert.doesNotMatch(item.preview.html, /<script|alert\(/);
  await bob.get(item.preview.url).expect(404);
  const preview = await alice.get(item.preview.url).expect(200);
  assert.match(preview.headers["content-security-policy"], /sandbox/);
  assert.match(
    preview.headers["content-security-policy"],
    /default-src 'none'/,
  );
  assert.match(preview.headers["content-security-policy"], /img-src data:/);
  assert.doesNotMatch(preview.text, /<script/);
  // Old API callers that omit format must not silently turn HTML into literal text.
  const updated = (
    await call(alice, "put", `/v1/campaigns/${item.id}`, {
      name: "Updated",
      subject: "Welcome",
      body: html,
    }).expect(200)
  ).body;
  assert.equal(updated.content_type, "html");
  await call(alice, "post", `/v1/campaigns/${item.id}/start`, {
    confirmConsent: true,
  }).expect(200);
  await service.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.html, /<h1/);
  assert.match(sent[0].message.text, /Special offer/);
  assert.doesNotMatch(sent[0].message.text, /<strong|alert\(/);
});

test("unsaved HTML previews are company-scoped and do not save or send", async () => {
  await call(alice, "post", "/campaigns/preview", {
    body: "<script>bad()</script>",
    contentType: "html",
  }).expect(400);
  const response = (
    await call(alice, "post", "/campaigns/preview", {
      body: "<p>Preview only</p>",
      contentType: "html",
    }).expect(200)
  ).body;
  await bob.get(response.url).expect(404);
  await alice.get(response.url).expect(200);
  assert.equal((await alice.get("/api/v1/campaigns")).body.length, 0);
  assert.equal(sent.length, 0);
  const plain = (
    await call(alice, "post", "/campaigns/preview", {
      body: "<b>Literal</b>",
      contentType: "text",
    }).expect(200)
  ).body;
  assert.equal(plain.html, undefined);
  assert.match(plain.text, /<b>Literal<\/b>/);
});
