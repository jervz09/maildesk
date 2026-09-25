import express from "express";
import helmet from "helmet";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import { asyncDatabase, transaction, insertRows } from "./db.mjs";
import {
  vault,
  secret,
  hash,
  passwordHash,
  passwordMatches,
} from "./security.mjs";
import { providers as realProviders, failedDelivery } from "./providers.mjs";

import { renderCampaignBody, sanitizeEmailHtml } from "./content.mjs";

const now = () => new Date().toISOString();
const email = z.string().trim().toLowerCase().email().max(254);
const line = (max) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (s) => !/[\r\n<>]/.test(s),
      "Use a single line without angle brackets",
    );
const credentials = z.object({ email, password: z.string().min(12).max(128) });
const campaignInput = z.object({
  name: line(120),
  subject: line(200),
  body: z.string().trim().min(1).max(50000),
  contentType: z.enum(["text", "html"]).default("text"),
  audience: z.enum(["all", "selected"]).default("all"),
  contactIds: z.array(z.string().uuid()).max(100000).default([]),
});
const baseProvider = {
  from: email,
  fromName: line(100),
  replyTo: z.union([email, z.literal("")]).default(""),
  dailyLimit: z.number().int().min(1).max(100000),
};
const smtpFields = {
  ...baseProvider,
  host: z
    .string()
    .trim()
    .min(3)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/),
  port: z.union([z.literal(465), z.literal(587)]),
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
};
const providerInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ses"),
    ...baseProvider,
    region: z.string().regex(/^(us|eu|ap|sa|ca|me|af|il|mx)-(gov-)?[a-z]+-\d$/),
    accessKeyId: z.string().min(16).max(128),
    secretAccessKey: z.string().min(16).max(256),
    sessionToken: z.string().max(5000).default(""),
    configurationSet: z
      .string()
      .max(64)
      .regex(/^[a-zA-Z0-9_-]*$/)
      .default(""),
  }),
  z.object({ kind: z.literal("smtp"), ...smtpFields }),
  z.object({
    kind: z.literal("gmail"),
    ...smtpFields,
    dailyLimit: z.number().int().min(1).max(500),
  }),
]);
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function demand(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}

export function createApp(options) {
  const db = options.db || asyncDatabase(options.databasePath);
  const crypto = vault(options.key);
  const transport = options.providers || realProviders;
  const publicUrl = new URL(options.publicUrl).origin;
  const app = options.app || express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "upgrade-insecure-requests": options.production ? [] : null,
        },
      },
      strictTransportSecurity: options.production ? undefined : false,
    }),
  );
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "2kb" }));
  const clientAddress = (req) =>
    options.vercel
      ? String(req.headers["x-vercel-forwarded-for"] || req.ip)
          .split(",")[0]
          .trim()
      : req.ip;
  const limit = async (key, max) => {
    const time = Date.now();
    await db.prepare("DELETE FROM rate_limits WHERE until_at < ?").run(time);
    const entry = await db
      .prepare(
        `INSERT INTO rate_limits VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count`,
      )
      .get(hash(key), time + 15 * 60 * 1000);
    demand(
      entry.count <= max,
      "Too many attempts. Please try again in 15 minutes.",
      429,
    );
  };
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method) && !req.headers.authorization) {
      if (req.headers.origin !== publicUrl)
        return res
          .status(403)
          .json({ error: "Request origin is not allowed." });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "Send application/json." });
    }
    next();
  });
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: options.production,
    path: "/",
    maxAge: 7 * 24 * 3600000,
  };
  async function session(res, userId) {
    const token = secret();
    await db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(Date.now());
    await db
      .prepare("INSERT INTO sessions VALUES (?,?,?)")
      .run(hash(token), userId, Date.now() + cookieOptions.maxAge);
    res.cookie("maildesk_session", token, cookieOptions);
  }
  app.get("/api/health", async (_, res) => {
    await db.prepare("SELECT 1 FROM organizations LIMIT 1").get();
    res.json({ ok: true });
  });
  if (options.workerSecret)
    app.post("/internal/worker", async (req, res) => {
      res.set("Cache-Control", "no-store");
      const authorized = timingSafeEqual(
        Buffer.from(hash(req.headers.authorization || "")),
        Buffer.from(hash(`Bearer ${options.workerSecret}`)),
      );
      demand(authorized, "Unauthorized worker request.", 401);
      await recover(10 * 60 * 1000);
      await tick();
      res.json({ ok: true });
    });
  app.get("/api/setup", (_, res) =>
    res.json({ signupEnabled: options.allowSignup !== false }),
  );
  app.post("/api/auth/register", async (req, res) => {
    demand(options.allowSignup !== false, "Registration is disabled.", 403);
    await limit(`auth:${clientAddress(req)}`, 20);
    const input = credentials.extend({ company: line(120) }).parse(req.body);
    const password = await passwordHash(input.password);
    const org = randomUUID(),
      user = randomUUID();
    await transaction(db, async () => {
      demand(
        !(await db
          .prepare("SELECT id FROM users WHERE email=?")
          .get(input.email)),
        "This email cannot be registered. Try signing in.",
        409,
      );
      await db
        .prepare("INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)")
        .run(org, input.company, now());
      await db
        .prepare("INSERT INTO users VALUES (?,?,?,?,?)")
        .run(user, org, input.email, password, now());
    });
    await session(res, user);
    res.status(201).json({ ok: true });
  });
  const dummyPassword = passwordHash(secret());
  app.post("/api/auth/login", async (req, res) => {
    await limit(`auth:${clientAddress(req)}`, 20);
    const input = credentials.parse(req.body);
    const user = await db
      .prepare("SELECT * FROM users WHERE email=?")
      .get(input.email);
    const matches = await passwordMatches(
      input.password,
      user?.password || (await dummyPassword),
    );
    demand(user && matches, "Email or password is incorrect.", 401);
    await session(res, user.id);
    res.json({ ok: true });
  });
  async function authenticate(req, res, next) {
    if (req.headers.authorization) {
      const token = /^Bearer (md_[a-zA-Z0-9_-]+)$/.exec(
        req.headers.authorization,
      )?.[1];
      const key =
        token &&
        (await db
          .prepare("SELECT org_id FROM api_keys WHERE token_hash=?")
          .get(hash(token)));
      if (!key) return res.status(401).json({ error: "Invalid API key." });
      req.org = key.org_id;
      req.apiKey = true;
    } else {
      const token = /(?:^|;\s*)maildesk_session=([^;]+)/.exec(
        req.headers.cookie || "",
      )?.[1];
      const user =
        token &&
        (await db
          .prepare(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
          )
          .get(hash(token), Date.now()));
      if (!user) return res.status(401).json({ error: "Please sign in." });
      req.org = user.org_id;
      req.user = user;
      req.sessionHash = hash(token);
    }
    next();
  }
  app.use("/api", authenticate);
  app.use("/api", async (req, res, next) => {
    if (req.apiKey && !req.path.startsWith("/v1/"))
      return res
        .status(403)
        .json({ error: "API keys can only access /api/v1 integrations." });
    try {
      await limit(`api:${req.org}`, 3000);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/auth/logout", async (req, res) => {
    await db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(req.sessionHash);
    res.clearCookie("maildesk_session", cookieOptions);
    res.json({ ok: true });
  });
  app.get("/api/me", async (req, res) =>
    res.json({
      email: req.user.email,
      organization: await db
        .prepare("SELECT * FROM organizations WHERE id=?")
        .get(req.org),
    }),
  );
  app.put("/api/organization", async (req, res) => {
    const input = z
      .object({ name: line(120), address: z.string().trim().min(5).max(500) })
      .parse(req.body);
    await transaction(db, async () => {
      demand(
        !(await active(req.org)),
        "Pause campaigns and wait for the current send before editing company settings.",
        409,
      );
      await db
        .prepare("UPDATE organizations SET name=?,address=? WHERE id=?")
        .run(input.name, input.address, req.org);
    });
    res.json({ ok: true });
  });
  async function active(org) {
    return (
      (await db
        .prepare(
          "SELECT id FROM campaigns WHERE org_id=? AND status='queued' LIMIT 1",
        )
        .get(org)) ||
      (await db
        .prepare(
          "SELECT id FROM attempts WHERE org_id=? AND status='sending' LIMIT 1",
        )
        .get(org))
    );
  }
  async function readProvider(org) {
    const row = await db
      .prepare("SELECT * FROM providers WHERE org_id=?")
      .get(org);
    demand(row, "Connect an email provider first.");
    return { ...row, settings: crypto.decrypt(row.config, org) };
  }
  async function publicProvider(org) {
    const row = await db
      .prepare("SELECT * FROM providers WHERE org_id=?")
      .get(org);
    if (!row) return null;
    const {
      password,
      secretAccessKey,
      accessKeyId,
      sessionToken,
      ...settings
    } = crypto.decrypt(row.config, org);
    return {
      ...settings,
      kind: row.kind,
      hasCredentials: true,
      verifiedAt: row.verified_at,
      info: row.info ? JSON.parse(row.info) : null,
    };
  }
  app.get("/api/provider", async (req, res) =>
    res.json(await publicProvider(req.org)),
  );
  app.put("/api/provider", async (req, res) => {
    await transaction(db, async () => {
      demand(
        !(await active(req.org)),
        "Pause campaigns and wait for the current send before changing providers.",
        409,
      );
      const previous = await db
        .prepare("SELECT * FROM providers WHERE org_id=?")
        .get(req.org);
      const input = { ...req.body };
      if (previous?.kind === input.kind) {
        const saved = crypto.decrypt(previous.config, req.org);
        for (const key of [
          "password",
          "accessKeyId",
          "secretAccessKey",
          "sessionToken",
        ])
          if (!input[key]) input[key] = saved[key];
      }
      if (input.kind === "gmail") {
        input.host = "smtp.gmail.com";
        input.port = 465;
        input.password = input.password?.replace(/\s/g, "");
        input.from = input.username;
      }
      const config = providerInput.parse(input);
      await db
        .prepare(
          `INSERT INTO providers VALUES (?,?,?,NULL,NULL,?) ON CONFLICT(org_id) DO UPDATE SET
      kind=excluded.kind,config=excluded.config,verified_at=NULL,info=NULL,updated_at=excluded.updated_at`,
        )
        .run(req.org, config.kind, crypto.encrypt(config, req.org), now());
    });
    res.json(await publicProvider(req.org));
  });
  async function verify(org) {
    const provider = await readProvider(org);
    const info = await transport.verify(provider.kind, provider.settings);
    const updated = await db
      .prepare(
        "UPDATE providers SET verified_at=?,info=? WHERE org_id=? AND config=?",
      )
      .run(
        info.ready ? now() : null,
        JSON.stringify(info),
        org,
        provider.config,
      );
    demand(
      updated.changes,
      "Settings changed while checking. Please check again.",
      409,
    );
    return info;
  }
  app.post("/api/provider/verify", async (req, res) => {
    await limit(`verify:${req.org}`, 15);
    try {
      res.json(await verify(req.org));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(
        400,
        "Connection failed. Check credentials, sender identity, region, and network access.",
      );
    }
  });
  async function usage(org) {
    const month = new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z";
    const day = new Date(Date.now() - 24 * 3600000).toISOString();
    return {
      monthly: (
        await db
          .prepare(
            "SELECT count(*) n FROM attempts WHERE org_id=? AND created_at>=?",
          )
          .get(org, month)
      ).n,
      daily: (
        await db
          .prepare(
            "SELECT count(*) n FROM attempts WHERE org_id=? AND created_at>=?",
          )
          .get(org, day)
      ).n,
      monthlyLimit: 100000,
    };
  }
  async function reserve(org, address, campaign = null) {
    demand(
      !(await db
        .prepare(
          "SELECT id FROM attempts WHERE org_id=? AND status='sending' LIMIT 1",
        )
        .get(org)),
      "Please wait for the current send to finish.",
      429,
    );
    const provider = await readProvider(org);
    demand(
      provider.verified_at,
      "Check your provider connection before sending.",
    );
    const count = await usage(org);
    demand(
      count.monthly < 100000 && count.daily < provider.settings.dailyLimit,
      "Your daily or monthly send limit has been reached.",
      429,
    );
    const gate = await db
      .prepare("SELECT next_at FROM gates WHERE org_id=?")
      .get(org);
    demand(
      !gate || gate.next_at <= Date.now(),
      "Please wait before the next send.",
      429,
    );
    await db
      .prepare(
        "INSERT INTO gates VALUES (?,?) ON CONFLICT(org_id) DO UPDATE SET next_at=excluded.next_at",
      )
      .run(org, Date.now() + 1100);
    const id = randomUUID();
    await db
      .prepare("INSERT INTO attempts VALUES (?,?,?,?,?,?)")
      .run(id, org, campaign, address, "sending", now());
    return { id, provider };
  }
  async function suppressed(org, address) {
    return await db
      .prepare("SELECT 1 FROM suppressions WHERE org_id=? AND email=?")
      .get(org, address);
  }
  async function message(org, address, subject, body, contentType = "text") {
    const company = await db
      .prepare("SELECT * FROM organizations WHERE id=?")
      .get(org);
    const unsubscribe = `${publicUrl}/unsubscribe/${crypto.token(org, address)}`;
    return {
      to: address,
      subject,
      ...renderCampaignBody({ body, contentType, company, unsubscribe }),
      unsubscribe,
    };
  }
  app.post("/api/provider/test", async (req, res) => {
    const input = z.object({ to: email }).parse(req.body);
    demand(
      !(await suppressed(req.org, input.to)),
      "This address is unsubscribed.",
    );
    const attempt = await transaction(
      db,
      async () => await reserve(req.org, input.to),
    );
    try {
      const messageId = await transport.send(
        attempt.provider.kind,
        attempt.provider.settings,
        await message(
          req.org,
          input.to,
          "Your Maildesk connection is ready",
          "This is the test email you requested from Maildesk.",
        ),
      );
      await db
        .prepare("UPDATE attempts SET status='accepted' WHERE id=?")
        .run(attempt.id);
      res.json({ messageId, status: "accepted" });
    } catch (error) {
      const result = failedDelivery(error);
      await db
        .prepare("UPDATE attempts SET status=? WHERE id=?")
        .run(result.status, attempt.id);
      throw new HttpError(502, result.message);
    }
  });
  app.get("/api/dashboard", async (req, res) => {
    res.json({
      usage: await usage(req.org),
      provider: await publicProvider(req.org),
      contacts: (
        await db
          .prepare("SELECT count(*) n FROM contacts WHERE org_id=?")
          .get(req.org)
      ).n,
      suppressed: (
        await db
          .prepare("SELECT count(*) n FROM suppressions WHERE org_id=?")
          .get(req.org)
      ).n,
      outcomes: await db
        .prepare(
          "SELECT status,count(*) count FROM attempts WHERE org_id=? GROUP BY status",
        )
        .all(req.org),
    });
  });
  app.get("/api/v1/contacts", async (req, res) => {
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(req.query.offset);
    res.json({
      contacts: await db
        .prepare(
          `SELECT c.*,s.reason AS suppression FROM contacts c LEFT JOIN suppressions s ON c.org_id=s.org_id AND c.email=s.email WHERE c.org_id=? ORDER BY c.created_at DESC,c.id LIMIT 500 OFFSET ?`,
        )
        .all(req.org, offset),
      total: (
        await db
          .prepare("SELECT count(*) n FROM contacts WHERE org_id=?")
          .get(req.org)
      ).n,
    });
  });
  async function importContacts(org, rows, consent) {
    demand(
      rows.length > 0 && rows.length <= 100000,
      "Import between 1 and 100,000 rows.",
    );
    const clean = rows.map((row, i) => {
      const result = z
        .object({ email, name: z.string().trim().max(120).default("") })
        .safeParse(row);
      demand(
        result.success,
        `Invalid contact at row ${i + 1}. Nothing was imported.`,
      );
      return result.data;
    });
    let added = 0;
    await transaction(db, async () => {
      const existing = (
        await db
          .prepare("SELECT count(*) n FROM contacts WHERE org_id=?")
          .get(org)
      ).n;
      const unique = new Map(clean.map((c) => [c.email, c]));
      added = await insertRows(
        db,
        "contacts",
        ["id", "org_id", "email", "name", "consent", "created_at"],
        [...unique.values()].map((row) => [
          randomUUID(),
          org,
          row.email,
          row.name,
          consent,
          now(),
        ]),
        true,
      );
      demand(
        existing + added <= 100000,
        "This workspace supports up to 100,000 contacts.",
      );
    });
    return { added, duplicates: rows.length - added };
  }
  app.post("/api/v1/contacts", async (req, res) => {
    const input = z
      .object({
        contacts: z
          .array(z.object({ email, name: z.string().max(120).default("") }))
          .min(1)
          .max(100000),
        consent: line(300),
      })
      .parse(req.body);
    res
      .status(201)
      .json(await importContacts(req.org, input.contacts, input.consent));
  });
  app.post("/api/contacts/import", async (req, res) => {
    const input = z
      .object({ csv: z.string().max(3 * 1024 * 1024), consent: line(300) })
      .parse(req.body);
    let rows;
    try {
      rows = parse(input.csv, {
        columns: (headers) => headers.map((s) => s.trim().toLowerCase()),
        bom: true,
        skip_empty_lines: true,
        trim: true,
        max_record_size: 4096,
      });
    } catch {
      throw new HttpError(
        400,
        "Invalid CSV. Use email,name headers and properly quoted values.",
      );
    }
    res.json(await importContacts(req.org, rows, input.consent));
  });
  app.post("/api/contacts/suppress", async (req, res) => {
    const input = z
      .object({
        email,
        reason: z
          .enum(["unsubscribe", "bounce", "complaint"])
          .default("unsubscribe"),
      })
      .parse(req.body);
    await db
      .prepare("INSERT OR IGNORE INTO suppressions VALUES (?,?,?,?)")
      .run(req.org, input.email, input.reason, now());
    res.json({ ok: true });
  });
  async function campaign(org, id) {
    const row = await db
      .prepare("SELECT * FROM campaigns WHERE id=? AND org_id=?")
      .get(id, org);
    demand(row, "Campaign not found.", 404);
    return row;
  }
  async function campaignPreview(org, body, contentType) {
    const company = await db
      .prepare("SELECT * FROM organizations WHERE id=?")
      .get(org);
    return renderCampaignBody({
      body,
      contentType,
      company,
      unsubscribe: "#unsubscribe-preview",
    });
  }
  function validateContent(input) {
    if (input.contentType === "html")
      demand(
        sanitizeEmailHtml(input.body).length > 0,
        "Add email content. This HTML contains no supported content.",
      );
    return input;
  }
  function sendPreview(res, preview) {
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox",
    );
    // Preview links never navigate to destinations from pasted HTML.
    res
      .type("html")
      .send(preview.html.replace(/href="[^"]*"/g, 'href="#maildesk-preview"'));
  }
  app.post("/api/campaigns/preview", async (req, res) => {
    const input = validateContent(
      campaignInput.pick({ body: true, contentType: true }).parse(req.body),
    );
    const preview = await campaignPreview(
      req.org,
      input.body,
      input.contentType,
    );
    if (preview.html) {
      const token = randomUUID();
      await transaction(db, async () => {
        await db
          .prepare("DELETE FROM draft_previews WHERE org_id=? OR expires_at<?")
          .run(req.org, Date.now());
        await db
          .prepare("INSERT INTO draft_previews VALUES (?,?,?,?)")
          .run(
            token,
            req.org,
            JSON.stringify(preview),
            Date.now() + 5 * 60 * 1000,
          );
      });
      preview.url = `/api/campaign-previews/${token}`;
    }
    res.json(preview);
  });
  app.get("/api/campaign-previews/:token", async (req, res) => {
    const entry = await db
      .prepare(
        "SELECT * FROM draft_previews WHERE token=? AND org_id=? AND expires_at>?",
      )
      .get(req.params.token, req.org, Date.now());
    demand(entry, "Preview expired. Click Preview again.", 404);
    sendPreview(res, JSON.parse(entry.preview));
  });
  app.get("/api/campaigns/:id/preview", async (req, res) => {
    const item = await campaign(req.org, req.params.id);
    demand(item.content_type === "html", "This campaign is plain text.", 400);
    sendPreview(
      res,
      await campaignPreview(req.org, item.body, item.content_type),
    );
  });
  async function campaignDetail(org, id) {
    const item = await campaign(org, id);
    return {
      ...item,
      preview: {
        ...(await campaignPreview(org, item.body, item.content_type)),
        ...(item.content_type === "html"
          ? { url: `/api/campaigns/${id}/preview` }
          : {}),
      },
      counts: await db
        .prepare(
          "SELECT status,count(*) count FROM recipients WHERE campaign_id=? AND org_id=? GROUP BY status",
        )
        .all(id, org),
      recipients: await db
        .prepare(
          "SELECT email,status,error,attempted_at FROM recipients WHERE campaign_id=? AND org_id=? ORDER BY email LIMIT 100",
        )
        .all(id, org),
    };
  }
  app.get("/api/v1/campaigns", async (req, res) =>
    res.json(
      await db
        .prepare(
          `SELECT c.*,(SELECT count(*) FROM recipients r WHERE r.campaign_id=c.id) recipient_count FROM campaigns c WHERE org_id=? ORDER BY created_at DESC LIMIT 100`,
        )
        .all(req.org),
    ),
  );
  app.get("/api/v1/campaigns/:id", async (req, res) =>
    res.json(await campaignDetail(req.org, req.params.id)),
  );
  app.post("/api/v1/campaigns", async (req, res) => {
    const input = validateContent(campaignInput.parse(req.body));
    const key = req.get("Idempotency-Key");
    if (key)
      demand(
        /^[\w-]{8,128}$/.test(key),
        "Idempotency-Key must be 8–128 letters, numbers, underscores, or hyphens.",
      );
    // Preserve existing plain-text idempotency keys from before HTML support.
    const { contentType, ...legacyInput } = input;
    const fingerprint = hash(
      JSON.stringify(contentType === "text" ? legacyInput : input),
    );
    const result = await transaction(db, async () => {
      const previous =
        key &&
        (await db
          .prepare("SELECT * FROM requests WHERE org_id=? AND request_key=?")
          .get(req.org, key));
      if (previous) {
        demand(
          previous.fingerprint === fingerprint,
          "This idempotency key was already used for different content.",
          409,
        );
        return previous.campaign_id;
      }
      const all = await db
        .prepare(
          "SELECT id,email FROM contacts WHERE org_id=? AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.org_id=contacts.org_id AND s.email=contacts.email)",
        )
        .all(req.org);
      const selected = new Set(input.contactIds);
      const audience =
        input.audience === "all" ? all : all.filter((c) => selected.has(c.id));
      demand(
        audience.length,
        "Add subscribed contacts before creating this campaign.",
      );
      const id = randomUUID();
      await db
        .prepare(
          "INSERT INTO campaigns(id,org_id,name,subject,body,content_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          req.org,
          input.name,
          input.subject,
          input.body,
          input.contentType,
          now(),
          now(),
        );
      await insertRows(
        db,
        "recipients",
        ["id", "campaign_id", "org_id", "email"],
        audience.map((contact) => [randomUUID(), id, req.org, contact.email]),
      );
      if (key)
        await db
          .prepare("INSERT INTO requests VALUES (?,?,?,?)")
          .run(req.org, key, fingerprint, id);
      return id;
    });
    res.status(201).json(await campaignDetail(req.org, result));
  });
  app.put("/api/v1/campaigns/:id", async (req, res) => {
    await transaction(db, async () => {
      const item = await campaign(req.org, req.params.id);
      demand(item.status === "draft", "Only draft content can be edited.", 409);
      const input = validateContent(
        campaignInput
          .pick({ name: true, subject: true, body: true, contentType: true })
          .parse({
            ...req.body,
            contentType: req.body.contentType ?? item.content_type,
          }),
      );
      await db
        .prepare(
          "UPDATE campaigns SET name=?,subject=?,body=?,content_type=?,updated_at=? WHERE id=? AND org_id=?",
        )
        .run(
          input.name,
          input.subject,
          input.body,
          input.contentType,
          now(),
          item.id,
          req.org,
        );
    });
    res.json(await campaignDetail(req.org, req.params.id));
  });
  app.post("/api/v1/campaigns/:id/start", async (req, res) => {
    demand(
      req.body.confirmConsent === true,
      "Confirm that all recipients consented to these emails.",
    );
    const item = await campaign(req.org, req.params.id);
    if (item.status === "queued")
      return res.json(await campaignDetail(req.org, item.id));
    demand(
      ["draft", "paused"].includes(item.status),
      "This campaign cannot be started.",
      409,
    );
    demand(
      new URL(publicUrl).protocol === "https:" || options.testing,
      "Set PUBLIC_URL to your public HTTPS address so unsubscribe links work before sending campaigns.",
    );
    const company = await db
      .prepare("SELECT * FROM organizations WHERE id=?")
      .get(req.org);
    demand(
      company.address,
      "Add your company postal address in Settings before sending.",
    );
    await limit(`verify:${req.org}`, 15);
    let info;
    try {
      info = await verify(req.org);
    } catch {
      throw new HttpError(
        400,
        "Provider check failed. Reconnect your email provider.",
      );
    }
    demand(info.ready, info.summary);
    await transaction(db, async () => {
      const currentProvider = await readProvider(req.org);
      demand(
        currentProvider.verified_at,
        "Provider settings changed. Check the connection again.",
        409,
      );
      const company = await db
        .prepare("SELECT * FROM organizations WHERE id=?")
        .get(req.org);
      demand(
        company.address,
        "Add your company postal address in Settings before sending.",
      );
      const updated = await db
        .prepare(
          "UPDATE campaigns SET status='queued',error=NULL,updated_at=? WHERE id=? AND org_id=? AND status IN ('draft','paused')",
        )
        .run(now(), item.id, req.org);
      demand(
        updated.changes,
        "Campaign state changed. Refresh and try again.",
        409,
      );
    });
    res.json(await campaignDetail(req.org, item.id));
  });
  app.post("/api/v1/campaigns/:id/pause", async (req, res) => {
    await transaction(db, async () => {
      const item = await campaign(req.org, req.params.id);
      demand(
        item.status === "queued",
        "Only queued campaigns can be paused.",
        409,
      );
      await db
        .prepare(
          "UPDATE campaigns SET status='paused',updated_at=? WHERE id=? AND org_id=?",
        )
        .run(now(), item.id, req.org);
    });
    res.json(await campaignDetail(req.org, req.params.id));
  });
  app.get("/api/keys", async (req, res) =>
    res.json(
      await db
        .prepare(
          "SELECT id,name,prefix,created_at FROM api_keys WHERE org_id=?",
        )
        .all(req.org),
    ),
  );
  app.post("/api/keys", async (req, res) => {
    const input = z.object({ name: line(100) }).parse(req.body);
    const token = `md_${secret()}`,
      id = randomUUID();
    await transaction(db, async () => {
      demand(
        (
          await db
            .prepare("SELECT count(*) n FROM api_keys WHERE org_id=?")
            .get(req.org)
        ).n < 10,
        "Maximum 10 API keys per company.",
      );
      await db
        .prepare("INSERT INTO api_keys VALUES (?,?,?,?,?,?)")
        .run(id, req.org, input.name, hash(token), token.slice(0, 10), now());
    });
    res.status(201).json({ id, token });
  });
  app.delete("/api/keys/:id", async (req, res) => {
    await db
      .prepare("DELETE FROM api_keys WHERE id=? AND org_id=?")
      .run(req.params.id, req.org);
    res.json({ ok: true });
  });
  async function unsubscribe(req, res) {
    let data;
    try {
      data = crypto.readToken(req.params.token);
    } catch {
      return res
        .status(400)
        .type("text")
        .send("This unsubscribe link is invalid.");
    }
    if (
      !(await db
        .prepare("SELECT id FROM organizations WHERE id=?")
        .get(data.org))
    )
      return res.sendStatus(404);
    if (req.method === "POST") {
      await db
        .prepare("INSERT OR IGNORE INTO suppressions VALUES (?,?,?,?)")
        .run(data.org, data.email, "unsubscribe", now());
      return res
        .type("html")
        .send(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><link rel="stylesheet" href="/style.css"><main class="unsubscribe"><h1>You’re unsubscribed.</h1><p>You won’t receive future campaigns from this company.</p></main></html>',
        );
    }
    res
      .type("html")
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><link rel="stylesheet" href="/style.css"><main class="unsubscribe"><h1>Leave this mailing list?</h1><p>Confirm below to stop future campaigns from this company.</p><form method="post"><button>Unsubscribe</button></form></main></html>',
      );
  }
  app.get("/unsubscribe/:token", unsubscribe);
  app.post("/unsubscribe/:token", unsubscribe);
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    if (error instanceof HttpError)
      return res.status(error.status).json({ error: error.message });
    if (error.type === "entity.too.large")
      return res
        .status(413)
        .json({ error: "File is too large. Maximum request size is 4 MB." });
    if (error instanceof SyntaxError && error.status === 400)
      return res.status(400).json({ error: "Invalid JSON." });
    console.error("Request failed:", error.code || error.name);
    res
      .status(500)
      .json({ error: "The request could not be completed. Please try again." });
  });
  let working = false;
  async function tick() {
    if (working) return;
    working = true;
    try {
      const campaigns = await db
        .prepare(
          "SELECT * FROM campaigns WHERE status='queued' ORDER BY updated_at,id LIMIT ?",
        )
        .all(options.maxCampaignsPerTick || 100);
      for (const item of campaigns) {
        let claim;
        try {
          claim = await transaction(db, async () => {
            if ((await campaign(item.org_id, item.id)).status !== "queued")
              return null;
            // Rotate busy campaigns so one slow provider cannot starve others.
            await db
              .prepare("UPDATE campaigns SET updated_at=? WHERE id=?")
              .run(now(), item.id);
            if (
              await db
                .prepare(
                  "SELECT id FROM attempts WHERE org_id=? AND status='sending' LIMIT 1",
                )
                .get(item.org_id)
            )
              return null;
            await db
              .prepare(
                "UPDATE recipients SET status='suppressed' WHERE campaign_id=? AND status='pending' AND EXISTS (SELECT 1 FROM suppressions s WHERE s.org_id=recipients.org_id AND s.email=recipients.email)",
              )
              .run(item.id);
            const recipient = await db
              .prepare(
                "SELECT * FROM recipients WHERE campaign_id=? AND status='pending' ORDER BY id LIMIT 1",
              )
              .get(item.id);
            if (!recipient) {
              await db
                .prepare(
                  "UPDATE campaigns SET status='completed',updated_at=? WHERE id=?",
                )
                .run(now(), item.id);
              return null;
            }
            const attempt = await reserve(
              item.org_id,
              recipient.email,
              item.id,
            );
            await db
              .prepare(
                "UPDATE recipients SET status='sending',attempted_at=? WHERE id=?",
              )
              .run(now(), recipient.id);
            return { recipient, attempt };
          });
        } catch (e) {
          if (e.status === 429 && e.message.startsWith("Please wait")) continue;
          await db
            .prepare(
              "UPDATE campaigns SET status='paused',error=?,updated_at=? WHERE id=?",
            )
            .run(
              e instanceof HttpError ? e.message : "Queue processing failed.",
              now(),
              item.id,
            );
          continue;
        }
        if (!claim) continue;
        const { recipient, attempt } = claim;
        // A pause/unsubscribe arriving during an already started provider request cannot recall that message.
        try {
          const id = await transport.send(
            attempt.provider.kind,
            attempt.provider.settings,
            await message(
              item.org_id,
              recipient.email,
              item.subject,
              item.body,
              item.content_type,
            ),
          );
          await transaction(db, async () => {
            await db
              .prepare(
                "UPDATE recipients SET status='accepted',message_id=? WHERE id=?",
              )
              .run(id || "", recipient.id);
            await db
              .prepare("UPDATE attempts SET status='accepted' WHERE id=?")
              .run(attempt.id);
          });
        } catch (error) {
          const result = failedDelivery(error);
          await transaction(db, async () => {
            await db
              .prepare("UPDATE recipients SET status=?,error=? WHERE id=?")
              .run(result.status, result.message, recipient.id);
            await db
              .prepare("UPDATE attempts SET status=? WHERE id=?")
              .run(result.status, attempt.id);
            await db
              .prepare(
                "UPDATE campaigns SET status='paused',error=?,updated_at=? WHERE id=?",
              )
              .run(result.message, now(), item.id);
          });
        }
      }
    } finally {
      working = false;
    }
  }
  async function recover(staleAfterMs = 0) {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    await transaction(db, async () => {
      await db
        .prepare(
          "UPDATE campaigns SET status='paused',error='Server restarted during a send. Check uncertain outcomes before resuming.' WHERE id IN (SELECT campaign_id FROM recipients WHERE status='sending' AND (attempted_at IS NULL OR attempted_at<=?))",
        )
        .run(cutoff);
      await db
        .prepare(
          "UPDATE recipients SET status='uncertain',error='Interrupted send; check your provider.' WHERE status='sending' AND (attempted_at IS NULL OR attempted_at<=?)",
        )
        .run(cutoff);
      await db
        .prepare(
          "UPDATE attempts SET status='uncertain' WHERE status='sending' AND created_at<=?",
        )
        .run(cutoff);
    });
  }
  return { app, db, tick, recover, crypto };
}
