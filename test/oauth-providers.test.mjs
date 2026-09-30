import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { createOAuthProviders } from "../server/oauth-providers.mjs";

const google = { clientId: "google-client", clientSecret: "google-secret" };
const github = { clientId: "github-client", clientSecret: "github-secret" };
const flow = { code: "one-use-code", nonce: "expected-nonce", verifier: "expected-pkce-verifier", redirectUri: "https://maildesk.example/api/auth/oauth/google/callback" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const keys = await generateKeyPair("RS256");
async function token(overrides = {}, privateKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "https://accounts.google.com", aud: google.clientId, sub: "google-stable-id",
    email: "owner@example.com", email_verified: true, nonce: flow.nonce,
    iat: now, exp: now + 300, ...overrides,
  }).setProtectedHeader({ alg: "RS256" }).sign(privateKey);
}
test("Google exchanges the code server-side with PKCE and validates a signed ID token", async () => {
  const jwt = await token();
  const adapters = createOAuthProviders({ google }, {
    googleKeySet: keys.publicKey,
    fetcher: async (url, options) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.equal(options.redirect, "error");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("code_verifier"), flow.verifier);
      assert.equal(body.get("client_secret"), google.clientSecret);
      assert.equal(body.get("redirect_uri"), flow.redirectUri);
      assert.equal(body.get("grant_type"), "authorization_code");
      return json({ id_token: jwt, access_token: "discard-me" });
    },
  });
  assert.deepEqual(await adapters.google.exchange(flow), { subject: "google-stable-id", email: "owner@example.com" });
});
test("Google rejects wrong issuer/audience/nonce/authorized party, expired or unsigned identities and unverified emails", async () => {
  const badKey = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1000);
  const invalid = [
    await token({ iss: "https://evil.test" }), await token({ aud: "other-client" }),
    await token({ nonce: "wrong" }), await token({ azp: "other-client" }),
    await token({ exp: now - 60 }), await token({ iat: now + 60 }),
    await token({ email_verified: false }), await token({ email_verified: "true" }),
    await token({}, badKey.privateKey), "not-a-jwt",
  ];
  for (const jwt of invalid) {
    const { google: adapter } = createOAuthProviders({ google }, {
      googleKeySet: keys.publicKey, fetcher: async () => json({ id_token: jwt }),
    });
    await assert.rejects(adapter.exchange(flow));
  }
});
test("GitHub uses the authenticated stable user ID and only a verified primary email", async () => {
  const calls = [];
  const adapters = createOAuthProviders({ github }, {
    fetcher: async (url, options) => {
      calls.push(url);
      if (url.includes("/access_token")) {
        assert.equal(new URLSearchParams(options.body).get("code_verifier"), flow.verifier);
        return json({ access_token: "ephemeral-token", token_type: "bearer" });
      }
      assert.equal(options.headers.Authorization, "Bearer ephemeral-token");
      if (url.includes("/emails")) return json([
        { email: "unverified@example.com", primary: false, verified: false },
        { email: "private@example.com", primary: true, verified: true },
      ]);
      return json({ id: 98765, login: "renameable", email: "not-trusted@example.com" });
    },
  });
  assert.deepEqual(await adapters.github.exchange(flow), { subject: "98765", email: "private@example.com" });
  assert.equal(calls.length, 3);
});
test("GitHub refuses missing/unverified primary email, malformed identity, and failed provider requests", async () => {
  for (const mode of ["unverified", "missing", "identity", "unavailable", "denied"]) {
    const { github: adapter } = createOAuthProviders({ github }, {
      fetcher: async (url) => {
        if (mode === "unavailable") return json({}, 503);
        if (mode === "denied") return json({ error: "incorrect_client_credentials", error_description: "do not expose this" });
        if (url.includes("/access_token")) return json({ access_token: "token", token_type: "bearer" });
        if (url.includes("/emails")) return json(mode === "missing" ? [] : [{ email: "test@example.com", primary: true, verified: mode !== "unverified" }]);
        return json({ id: mode === "identity" ? "untrusted-id" : 123 });
      },
    });
    await assert.rejects(adapter.exchange(flow));
  }
});
