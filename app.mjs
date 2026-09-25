// Vercel's Express entry point. No listener, local database, or background timer.
import express from "express";
import { attachDatabasePool } from "@vercel/functions";
import { createApp } from "./server/app.mjs";
import { postgresDatabase } from "./server/postgres.mjs";
import { deploymentConfig } from "./server/config.mjs";

const config = deploymentConfig(process.env);
const db = postgresDatabase({
  connectionString: config.databaseUrl,
  ca: process.env.DATABASE_CA_CERT,
});
attachDatabasePool(db.pool);
const app = express();
createApp({ ...config, db, app });
export default app;
