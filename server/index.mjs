import { resolve, dirname } from "node:path";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  closeSync,
} from "node:fs";
import { createApp } from "./app.mjs";
const databasePath = resolve(
  process.env.DATABASE_PATH || "./data/maildesk.sqlite",
);
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const lock = `${databasePath}.lock`;
function acquire() {
  try {
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error("Invalid process lock. Inspect it before starting.");
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") {
        unlinkSync(lock);
        return acquire();
      }
      throw err;
    }
    throw new Error(
      "Maildesk is already running against this database. Run one instance only.",
    );
  }
}
acquire();
process.on("exit", () => {
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  } catch {}
});
const production = process.env.NODE_ENV === "production";
const publicUrl = process.env.PUBLIC_URL || "http://localhost:4320";
if (production && !publicUrl.startsWith("https://"))
  throw new Error("Production requires an HTTPS PUBLIC_URL.");
const { app, tick, recover, db } = createApp({
  databasePath,
  key: process.env.ENCRYPTION_KEY,
  publicUrl,
  production,
  allowSignup: process.env.ALLOW_SIGNUP === "true",
});
await recover();
let running;
const timer = setInterval(() => {
  if (!running)
    running = tick()
      .catch((e) => console.error("Worker failed:", e.name))
      .finally(() => {
        running = null;
      });
}, 1100);
const server = app.listen(
  Number(process.env.PORT || 4320),
  process.env.HOST || "127.0.0.1",
  () => console.log(`Maildesk is ready at ${publicUrl}`),
);
function shutdown() {
  clearInterval(timer);
  server.close(async () => {
    await running;
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 25000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
