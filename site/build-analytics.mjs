import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Bundles the shared analytics package for the browser. Without POSTHOG_PROJECT_TOKEN
// the page does not load the bundle (see base.njk).
await build({
  entryPoints: [path.join(here, "src", "analytics.js")],
  outfile: path.join(here, "_site", "analytics.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  define: {
    "process.env.POSTHOG_PROJECT_TOKEN": JSON.stringify(process.env.POSTHOG_PROJECT_TOKEN ?? ""),
    "process.env.POSTHOG_PROXY_HOST": JSON.stringify(
      process.env.POSTHOG_PROXY_HOST || "https://a.craftmill.dev/api/ingest",
    ),
  },
});
