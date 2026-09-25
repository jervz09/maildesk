import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
if (existsSync(".env")) {
  console.log(".env already exists; left unchanged.");
} else {
  const template = readFileSync(".env.example", "utf8");
  writeFileSync(
    ".env",
    template.replace(
      "ENCRYPTION_KEY=",
      `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log("Created .env with a private encryption key.");
}
mkdirSync("data", { recursive: true, mode: 0o700 });
