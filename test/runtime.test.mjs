import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

test("Vercel entry point loads when the runtime disables require(ESM)", () => {
  const result = spawnSync(process.execPath, [
    "--no-experimental-require-module",
    "--input-type=module",
    "--eval",
    `
      import assert from 'node:assert/strict';
      const { default: app } = await import('./app.mjs');
      assert.equal(typeof app, 'function');
      const { sanitizeEmailHtml } = await import('./server/content.mjs');
      const html = sanitizeEmailHtml('<p>Hello</p><script>alert(1)</script>');
      assert.ok(html.includes("<p>Hello</p>"));
      assert.doesNotMatch(html, /script|alert/);
    `,
  ], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      // Never use real credentials or connect to a database in this smoke test.
      DATABASE_URL: "postgresql://test:test@127.0.0.1:1/postgres",
      PUBLIC_URL: "https://maildesk.example",
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      WORKER_SECRET: randomBytes(32).toString("hex"),
      ALLOW_SIGNUP: "true",
      NODE_ENV: "production",
      VERCEL: "1",
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
