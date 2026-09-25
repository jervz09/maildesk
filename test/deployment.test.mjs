import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { deploymentConfig } from "../server/config.mjs";
import { testDatabase } from "./support/postgres.mjs";

test("deployment refuses missing secrets, HTTP URLs, and path-based public URLs", () => {
  const env = {
    DATABASE_URL: "postgresql://example.invalid/postgres",
    ENCRYPTION_KEY: "ab".repeat(32),
    WORKER_SECRET: "cd".repeat(32),
    PUBLIC_URL: "https://maildesk.example",
    ALLOW_SIGNUP: "true",
    VERCEL: "1",
  };
  assert.equal(deploymentConfig(env).allowSignup, true);
  assert.equal(
    deploymentConfig({ ...env, ALLOW_SIGNUP: "false" }).allowSignup,
    false,
  );
  for (const change of [
    { DATABASE_URL: "" },
    { ENCRYPTION_KEY: "" },
    { WORKER_SECRET: "short" },
    { PUBLIC_URL: "http://maildesk.example" },
    { PUBLIC_URL: "https://maildesk.example/path" },
  ])
    assert.throws(() => deploymentConfig({ ...env, ...change }));
});

describe(
  "Postgres deployment across independent app instances",
  { skip: !process.env.TEST_DATABASE_URL },
  () => {
    let first, second, db, peer, cookie, org, sends, onSend;
    const origin = "http://localhost:4320";
    const workerSecret = "ab".repeat(32);
    const owner = {
      company: "Acme",
      email: "owner@example.com",
      password: "a secure password 123",
    };
    const call = (service, method, path, body) =>
      request(service.app)
        [method](path)
        .set("Origin", origin)
        .set("Cookie", cookie || "")
        .send(body);
    beforeEach(async () => {
      db = await testDatabase();
      peer = db.connectPeer();
      sends = [];
      onSend = undefined;
      const options = {
        key: randomBytes(32).toString("hex"),
        publicUrl: origin,
        testing: true,
        workerSecret,
        maxCampaignsPerTick: 1,
        allowSignup: true,
        providers: {
          verify: async () => ({ ready: true, summary: "Mock verified" }),
          send: async (_, __, message) => {
            sends.push(message);
            if (onSend) await onSend();
            return "mock-message";
          },
        },
      };
      first = createApp({ ...options, db });
      second = createApp({ ...options, db: peer });
      const registered = await call(
        first,
        "post",
        "/api/auth/register",
        owner,
      ).expect(201);
      cookie = registered.headers["set-cookie"][0].split(";")[0];
      org = (await call(first, "get", "/api/me")).body.organization.id;
    });
    afterEach(async () => {
      await peer?.close();
      await db?.close();
    });
    async function ready(dailyLimit = 10) {
      await call(first, "put", "/api/organization", {
        name: "Acme",
        address: "123 Main Street, Manila",
      }).expect(200);
      await call(first, "put", "/api/provider", {
        kind: "gmail",
        username: "example@gmail.com",
        password: "abcd efgh ijkl mnop",
        fromName: "Acme",
        dailyLimit,
      }).expect(200);
      await call(first, "post", "/api/provider/verify", {}).expect(200);
    }
    async function queued(count = 1) {
      await ready();
      await call(first, "post", "/api/v1/contacts", {
        contacts: Array.from({ length: count }, (_, i) => ({
          email: `reader${i}@example.com`,
        })),
        consent: "Test opt-in",
      }).expect(201);
      const item = (
        await call(first, "post", "/api/v1/campaigns", {
          name: "News",
          subject: "Hello",
          body: "Test message",
        }).expect(201)
      ).body;
      await call(first, "post", `/api/v1/campaigns/${item.id}/start`, {
        confirmConsent: true,
      }).expect(200);
      return item;
    }

    test("sessions and unsaved previews survive switching instances", async () => {
      assert.equal(
        (await call(second, "get", "/api/me").expect(200)).body.organization.id,
        org,
      );
      const preview = (
        await call(first, "post", "/api/campaigns/preview", {
          body: "<p>Shared preview</p>",
          contentType: "html",
        }).expect(200)
      ).body;
      assert.match(
        (await call(second, "get", preview.url).expect(200)).text,
        /Shared preview/,
      );
      await db.prepare("UPDATE draft_previews SET expires_at=0").run();
      await call(second, "get", preview.url).expect(404);
    });

    test("concurrent signup has one owner and no orphan company", async () => {
      const input = { ...owner, email: "new@example.com" };
      const results = await Promise.all(
        [first, second].map((s) =>
          call(s, "post", "/api/auth/register", input),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      assert.equal(
        (await db.prepare("SELECT count(*) n FROM organizations").get()).n,
        2,
      );
    });

    test("authentication rate limits persist across instances", async () => {
      for (let i = 0; i < 19; i++)
        await call(
          i % 2 ? first : second,
          "post",
          "/api/auth/login",
          {},
        ).expect(400);
      await call(second, "post", "/api/auth/login", {}).expect(429);
      await db.prepare("UPDATE rate_limits SET until_at=0").run();
      await call(second, "post", "/api/auth/login", owner).expect(200);
    });

    test("overlapping workers never duplicate sends or complete a live send", async () => {
      const item = await queued(2);
      const started = Promise.withResolvers(),
        release = Promise.withResolvers();
      onSend = async () => {
        started.resolve();
        await release.promise;
      };
      const running = first.tick();
      await started.promise;
      try {
        await peer.prepare("UPDATE gates SET next_at=0").run();
        await second.tick();
        await second.recover(10 * 60 * 1000);
        assert.equal(sends.length, 1);
        assert.equal(
          (
            await peer
              .prepare("SELECT status FROM campaigns WHERE id=?")
              .get(item.id)
          ).status,
          "queued",
        );
        assert.equal(
          (
            await peer
              .prepare("SELECT count(*) n FROM attempts WHERE status='sending'")
              .get()
          ).n,
          1,
        );
      } finally {
        release.resolve();
        await running;
      }
      onSend = undefined;
      await second.tick();
      await second.tick();
      assert.equal(sends.length, 2);
      assert.equal(new Set(sends.map((m) => m.to)).size, 2);
      assert.equal(
        (
          await peer
            .prepare("SELECT status FROM campaigns WHERE id=?")
            .get(item.id)
        ).status,
        "completed",
      );
    });

    test("concurrent test sends reserve the daily quota atomically", async () => {
      await ready(1);
      const results = await Promise.all(
        [first, second].map((s) =>
          call(s, "post", "/api/provider/test", { to: "reader@example.com" }),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
      assert.equal(sends.length, 1);
      assert.equal(
        (await db.prepare("SELECT count(*) n FROM attempts").get()).n,
        1,
      );
    });

    test("worker endpoint requires a secret and processes at most one recipient", async () => {
      await queued(2);
      await request(first.app).post("/internal/worker").send({}).expect(401);
      await request(first.app)
        .post("/internal/worker")
        .auth("wrong", { type: "bearer" })
        .send({})
        .expect(401);
      assert.equal(sends.length, 0);
      await request(second.app)
        .post("/internal/worker")
        .auth(workerSecret, { type: "bearer" })
        .send({})
        .expect(200);
      assert.equal(sends.length, 1);
    });

    test("stale sends become uncertain and are never automatically retried", async () => {
      const item = await queued();
      const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      await db
        .prepare(
          "UPDATE recipients SET status='sending',attempted_at=? WHERE campaign_id=?",
        )
        .run(old, item.id);
      await db
        .prepare("INSERT INTO attempts VALUES (?,?,?,?,?,?)")
        .run("stale", org, item.id, "reader0@example.com", "sending", old);
      await second.recover(10 * 60 * 1000);
      await second.tick();
      assert.equal(sends.length, 0);
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM campaigns WHERE id=?")
            .get(item.id)
        ).status,
        "paused",
      );
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM recipients WHERE campaign_id=?")
            .get(item.id)
        ).status,
        "uncertain",
      );
      assert.equal(
        (
          await db
            .prepare("SELECT status FROM attempts WHERE id=?")
            .get("stale")
        ).status,
        "uncertain",
      );
    });
  },
);
