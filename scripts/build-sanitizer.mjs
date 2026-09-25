import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// sanitize-html requires its ESM-only parser from CommonJS. Some serverless
// runtimes disable require(ESM), even on Node 24. Bundle the complete dependency
// tree into CommonJS at install time, preserving the current security fixes.
await build({
  entryPoints: [fileURLToPath(import.meta.resolve("sanitize-html"))],
  outfile: fileURLToPath(new URL("../server/generated/sanitize-html.cjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  legalComments: "inline",
  logLevel: "info",
});
