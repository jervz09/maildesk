import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, secret, passwordHash, passwordMatches } from "./security.mjs";
import { transaction } from "./db.mjs";
import { OAuthError } from "./oauth-providers.mjs";

const messages = {
  cancelled: "Sign-in was cancelled. You can try again or use your email and password.",
  state: "This sign-in request expired or could not be verified. Please start again.",
  provider: "The sign-in provider could not be reached or verified. Please try again.",
  email: "Your provider must have a verified email address. For GitHub, verify your primary email first.",
  disabled: "This sign-in provider is not available.",
  signup: "New workspace registration is currently disabled. Use an existing account.",
  conflict: "This account cannot be linked automatically. Please start again and sign in with your existing account.",
  password: "The password is incorrect. Enter your existing Maildesk password or use an already linked provider.",
  limit: "Too many attempts. Please try again in 15 minutes.",
};
const lifetime = 10 * 60 * 1000;
const cookieValue = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([a-zA-Z0-9_-]{43})(?:;|$)`).exec(req.headers.cookie || "")?.[1];
const identitySchema = z.object({ subject: z.string().min(1).max(255), email: z.string().trim().toLowerCase().email().max(254) });
const companySchema = z.string().trim().min(1).max(120).refine((value) => !/[\r\n<>]/.test(value));

export function mountOAuth(app, { db, crypto, providers, publicUrl, production, allowSignup, session, limit, clientAddress }) {
  const cookies = { httpOnly: true, secure: Boolean(production), sameSite: "lax", path: "/api/auth/oauth", maxAge: lifetime };
  const callback = (id) => `${publicUrl}/api/auth/oauth/${id}/callback`;
  const configured = (id) => {
    if (!Object.hasOwn(providers, id)) throw new OAuthError("disabled", 404);
    return providers[id];
  };
  const attempt = (req) => limit(`auth:${clientAddress(req)}`, 20);
  const guard = (fn, redirect = false) => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      const code = error instanceof OAuthError ? error.code : error.status === 429 ? "limit" : "provider";
      if (!(error instanceof OAuthError) && error.status !== 429)
        console.error("OAuth request failed:", error.code || error.name);
      if (redirect) return res.redirect(303, `/#oauth-error=${code}`);
      res.status(error instanceof OAuthError ? error.status : error.status === 429 ? 429 : 503).json({ error: messages[code] });
    }
  };
  app.use("/api/auth/oauth", (req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    // OAuth mutations always require same-origin JSON, even if a bearer header exists.
    if (req.method !== "GET" && req.method !== "HEAD" && (req.headers.origin !== publicUrl || !req.is("application/json")))
      return res.status(403).json({ error: "Request origin is not allowed." });
    next();
  });
  async function pending(req) {
    const token = cookieValue(req, "maildesk_oauth_pending");
    const row = token && await db.prepare("SELECT * FROM oauth_pending WHERE token_hash=? AND expires_at>?").get(hash(token), Date.now());
    if (!row) throw new OAuthError("state");
    return { ...crypto.decrypt(row.payload, "oauth-pending"), tokenHash: row.token_hash };
  }
  async function linkIdentity(identity, userId) {
    const existing = await db.prepare("SELECT user_id FROM oauth_identities WHERE provider=? AND provider_user_id=?").get(identity.provider, identity.subject);
    if (existing) throw new OAuthError("conflict", 409);
    await db.prepare("INSERT INTO oauth_identities (id,user_id,provider,provider_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), userId, identity.provider, identity.subject, new Date().toISOString(), new Date().toISOString());
  }
  async function consumePending(identity) {
    const deleted = await db.prepare("DELETE FROM oauth_pending WHERE token_hash=? AND expires_at>? RETURNING token_hash").get(identity.tokenHash, Date.now());
    if (!deleted) throw new OAuthError("state");
  }
  app.post("/api/auth/oauth/:provider/start", guard(async (req, res) => {
    await attempt(req);
    const provider = configured(req.params.provider);
    const link = req.body?.link === true ? await pending(req) : null;
    if (link && !link.userId) throw new OAuthError("conflict", 409);
    const state = secret(), browser = secret(), verifier = secret(), nonce = secret();
    await db.prepare("DELETE FROM oauth_states WHERE expires_at<=?").run(Date.now());
    await db.prepare("DELETE FROM oauth_pending WHERE expires_at<=?").run(Date.now());
    await db.prepare("INSERT INTO oauth_states (state_hash,provider,browser_hash,payload,expires_at) VALUES (?,?,?,?,?)")
      .run(hash(state), provider.id, hash(browser), crypto.encrypt({ verifier, nonce, linkHash: link?.tokenHash || null }, "oauth-state"), Date.now() + lifetime);
    res.cookie("maildesk_oauth_browser", browser, cookies);
    if (!link) res.clearCookie("maildesk_oauth_pending", cookies);
    res.json({ url: provider.authorizationUrl({ state, verifier, nonce, redirectUri: callback(provider.id) }) });
  }));
  app.get("/api/auth/oauth/:provider/callback", guard(async (req, res) => {
    const provider = configured(req.params.provider);
    const state = req.query.state, browser = cookieValue(req, "maildesk_oauth_browser");
    if (typeof state !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(state) || !browser) throw new OAuthError("state");
    // Atomic, one-use state binds the provider, browser, PKCE verifier, and nonce.
    const row = await db.prepare("DELETE FROM oauth_states WHERE state_hash=? AND provider=? AND browser_hash=? AND expires_at>? RETURNING payload")
      .get(hash(state), provider.id, hash(browser), Date.now());
    if (!row) throw new OAuthError("state");
    res.clearCookie("maildesk_oauth_browser", cookies);
    if (req.query.error) throw new OAuthError(req.query.error === "access_denied" ? "cancelled" : "provider");
    if (typeof req.query.code !== "string" || !req.query.code || req.query.code.length > 4096) throw new OAuthError("state");
    const flow = crypto.decrypt(row.payload, "oauth-state");
    const profile = identitySchema.parse(await provider.exchange({ ...flow, code: req.query.code, redirectUri: callback(provider.id) }));
    const destination = await transaction(db, async () => {
      const linked = await db.prepare("SELECT user_id FROM oauth_identities WHERE provider=? AND provider_user_id=?").get(provider.id, profile.subject);
      if (flow.linkHash) {
        const candidate = await pending(req);
        if (candidate.tokenHash !== flow.linkHash || !linked || linked.user_id !== candidate.userId) throw new OAuthError("conflict", 409);
        await consumePending(candidate);
        await linkIdentity(candidate, linked.user_id);
        await session(res, linked.user_id);
        res.clearCookie("maildesk_oauth_pending", cookies);
        return "/#overview";
      }
      if (linked) {
        await session(res, linked.user_id);
        res.clearCookie("maildesk_oauth_pending", cookies);
        return "/#overview";
      }
      const user = await db.prepare("SELECT id FROM users WHERE email=?").get(profile.email);
      if (!user && allowSignup === false) throw new OAuthError("signup", 403);
      const token = secret();
      await db.prepare("INSERT INTO oauth_pending (token_hash,payload,expires_at) VALUES (?,?,?)")
        .run(hash(token), crypto.encrypt({ ...profile, provider: provider.id, userId: user?.id || null }, "oauth-pending"), Date.now() + lifetime);
      res.cookie("maildesk_oauth_pending", token, cookies);
      return "/#oauth-complete";
    });
    res.redirect(303, destination);
  }, true));
  app.get("/api/auth/oauth/pending", guard(async (req, res) => {
    const identity = await pending(req);
    const linked = identity.userId ? await db.prepare("SELECT DISTINCT provider FROM oauth_identities WHERE user_id=?").all(identity.userId) : [];
    res.json({
      provider: configured(identity.provider).name,
      email: identity.email,
      mode: identity.userId ? "link" : "create",
      providers: linked.filter((item) => Object.hasOwn(providers, item.provider)).map((item) => ({ id: item.provider, name: providers[item.provider].name })),
    });
  }));
  app.post("/api/auth/oauth/complete", guard(async (req, res) => {
    await attempt(req);
    const identity = await pending(req);
    configured(identity.provider);
    await limit(`oauth-complete:${identity.tokenHash}`, 10);
    let userId = identity.userId;
    let company, password;
    if (userId) {
      const user = await db.prepare("SELECT password FROM users WHERE id=?").get(userId);
      if (typeof req.body?.password !== "string" || req.body.password.length > 128 || !user || !(await passwordMatches(req.body.password, user.password)))
        throw new OAuthError("password", 401);
    } else {
      if (allowSignup === false) throw new OAuthError("signup", 403);
      const parsed = companySchema.safeParse(req.body?.company);
      if (!parsed.success) return res.status(400).json({ error: "Enter a company name of 1–120 characters, without angle brackets or newlines." });
      company = parsed.data;
      // Preserve the NOT NULL password schema with an unguessable, undisclosed hash.
      // OAuth-only users authenticate through their linked providers.
      password = await passwordHash(secret());
      userId = randomUUID();
    }
    await transaction(db, async () => {
      await consumePending(identity);
      if (!identity.userId) {
        if (await db.prepare("SELECT id FROM users WHERE email=?").get(identity.email)) throw new OAuthError("conflict", 409);
        const org = randomUUID(), now = new Date().toISOString();
        await db.prepare("INSERT INTO organizations (id,name,created_at) VALUES (?,?,?)").run(org, company, now);
        await db.prepare("INSERT INTO users VALUES (?,?,?,?,?)").run(userId, org, identity.email, password, now);
      }
      await linkIdentity(identity, userId);
      await session(res, userId);
    });
    res.clearCookie("maildesk_oauth_pending", cookies);
    res.json({ ok: true });
  }));
  app.post("/api/auth/oauth/cancel", guard(async (req, res) => {
    const token = cookieValue(req, "maildesk_oauth_pending");
    if (token) await db.prepare("DELETE FROM oauth_pending WHERE token_hash=?").run(hash(token));
    res.clearCookie("maildesk_oauth_pending", cookies);
    res.clearCookie("maildesk_oauth_browser", cookies);
    res.json({ ok: true });
  }));
}
