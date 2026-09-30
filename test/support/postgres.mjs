import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { postgresDatabase } from "../../server/postgres.mjs";

export async function testDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) return undefined;
  const schema = `maildesk_test_${randomUUID().replaceAll("-", "")}`;
  const ssl = !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(connectionString).hostname,
  );
  const makeConnection = () =>
    postgresDatabase({ connectionString, ssl, schema });
  const db = makeConnection();
  const directory = new URL("../../supabase/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = readFileSync(new URL(name, directory), "utf8");
    await db.pool.query(migration.replaceAll(/\bmaildesk\b/g, schema));
  }
  const close = db.close;
  db.connectPeer = makeConnection;
  db.close = async () => {
    try {
      await db.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await close();
    }
  };
  return db;
}
