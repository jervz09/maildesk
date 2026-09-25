import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

// All application SQL is static. Keep the same placeholders as the local adapter,
// but qualify tables so nothing depends on a pooled connection's search_path.
const tables =
  "organizations|users|sessions|providers|contacts|suppressions|campaigns|recipients|attempts|api_keys|requests|gates|rate_limits|draft_previews";
export function postgresSql(sql, schema = "maildesk") {
  const ignore = /INSERT OR IGNORE INTO/i.test(sql);
  let index = 0;
  return (
    sql
      .replace(/INSERT OR IGNORE INTO/gi, "INSERT INTO")
      .replace(
        new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${tables})\\b`, "gi"),
        `$1 ${schema}.$2`,
      )
      .replace(/\?/g, () => `$${++index}`) +
    (ignore ? " ON CONFLICT DO NOTHING" : "")
  );
}

export function postgresDatabase({
  connectionString,
  ssl = true,
  ca,
  pool: suppliedPool,
  schema = "maildesk",
} = {}) {
  if (!/^maildesk(?:_test_[a-z0-9_]+)?$/.test(schema))
    throw new Error("Invalid database schema.");
  if (!suppliedPool && !connectionString)
    throw new Error("DATABASE_URL is required.");
  let url;
  if (!suppliedPool) {
    url = new URL(connectionString);
    // TLS is controlled here, never silently weakened by URL query parameters.
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
      url.searchParams.delete(key);
  }
  const pool =
    suppliedPool ||
    new pg.Pool({
      connectionString: url.toString(),
      ssl: ssl ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false,
      max: 1,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
      types: {
        getTypeParser: (oid, format) =>
          oid === 20 ? Number : pg.types.getTypeParser(oid, format),
      },
    });
  pool.on("error", (error) =>
    console.error("Idle database connection failed:", error.code || error.name),
  );
  const context = new AsyncLocalStorage();
  const query = (sql, args) =>
    (context.getStore() || pool).query(postgresSql(sql, schema), args);
  return {
    pool,
    prepare(sql) {
      return {
        get: async (...args) => (await query(sql, args)).rows[0],
        all: async (...args) => (await query(sql, args)).rows,
        run: async (...args) => ({
          changes: (await query(sql, args)).rowCount,
        }),
      };
    },
    async transaction(fn) {
      if (context.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Short state transitions are serialized across instances. Never hold
        // this lock while sending email or checking provider connectivity.
        await client.query("SELECT pg_advisory_xact_lock(624913802)");
        const result = await context.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
