import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export function database(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id), kind TEXT NOT NULL, config TEXT NOT NULL,
      verified_at TEXT, info TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', consent TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(org_id,email));
    CREATE TABLE IF NOT EXISTS suppressions (
      org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL, reason TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(org_id,email));
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'text', status TEXT NOT NULL DEFAULT 'draft',
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recipients (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), org_id TEXT NOT NULL REFERENCES organizations(id),
      email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, message_id TEXT,
      attempted_at TEXT, UNIQUE(campaign_id,email));
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), campaign_id TEXT,
      email TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_org_time ON attempts(org_id,created_at);
    CREATE INDEX IF NOT EXISTS recipients_queue ON recipients(campaign_id,status);
    CREATE INDEX IF NOT EXISTS campaigns_org ON campaigns(org_id,created_at);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (
      org_id TEXT NOT NULL REFERENCES organizations(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id), PRIMARY KEY(org_id,request_key));
    CREATE TABLE IF NOT EXISTS gates (org_id TEXT PRIMARY KEY REFERENCES organizations(id), next_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS draft_previews (token TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), preview TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS previews_expiry ON draft_previews(expires_at);
    CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(until_at);
  `);
  // Additive migration: existing plain-text drafts and send history are preserved.
  if (
    !db
      .prepare("PRAGMA table_info(campaigns)")
      .all()
      .some((column) => column.name === "content_type")
  ) {
    db.exec(
      "ALTER TABLE campaigns ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text'",
    );
  }
  return db;
}
// Serialize access while an asynchronous SQLite transaction owns the connection.
export function asyncDatabase(path) {
  const raw = database(path);
  const context = new AsyncLocalStorage();
  let pending = Promise.resolve();
  function exclusive(fn) {
    if (context.getStore()) return Promise.resolve().then(fn);
    const result = pending.then(() => context.run(true, fn));
    pending = result.catch(() => {});
    return result;
  }
  return {
    prepare(sql) {
      const statement = raw.prepare(sql);
      return Object.fromEntries(
        ["get", "all", "run"].map((method) => [
          method,
          (...args) => exclusive(() => statement[method](...args)),
        ]),
      );
    },
    transaction(fn) {
      if (context.getStore()) return fn();
      return exclusive(async () => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn();
          raw.exec("COMMIT");
          return result;
        } catch (error) {
          raw.exec("ROLLBACK");
          throw error;
        }
      });
    },
    close: () => exclusive(() => raw.close()),
  };
}
export function transaction(db, fn) {
  return db.transaction(fn);
}

// Bound parameter counts and avoid one network round trip per imported contact.
export async function insertRows(db, table, columns, rows, ignore = false) {
  if (!/^[a-z_]+$/.test(table) || columns.some((c) => !/^[a-z_]+$/.test(c)))
    throw new Error("Invalid insert identifiers.");
  let added = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const values = batch
      .map(() => `(${columns.map(() => "?").join(",")})`)
      .join(",");
    const result = await db
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}${ignore ? " ON CONFLICT DO NOTHING" : ""}`,
      )
      .run(...batch.flat());
    added += result.changes;
  }
  return added;
}
