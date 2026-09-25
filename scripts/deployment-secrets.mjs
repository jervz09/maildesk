import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

// Keep secrets out of terminal output and never replace an existing key.
writeFileSync(
  ".env.deployment-secrets",
  [
    `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
    `WORKER_SECRET=${randomBytes(32).toString("hex")}`,
    "",
  ].join("\n"),
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created private .env.deployment-secrets. Copy its values into Vercel and back it up securely.",
);
