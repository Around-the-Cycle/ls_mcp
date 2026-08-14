// Credential loading for ls-mcp.
//
// MCP hosts launch this server as a subprocess with an arbitrary working
// directory, so `dotenv/config` (which resolves .env against process.cwd())
// would silently miss the .env sitting next to this file. Always resolve it
// against the module's own directory instead.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const packageRoot = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: join(packageRoot, ".env"), quiet: true });

// The atc-qbp Rails app names these differently. Accept either spelling so
// credentials copied from there work without hand-mapping.
const CREDENTIALS = {
  clientId: ["LS_CLIENT_ID", "LIGHTSPEED_USERNAME"],
  clientSecret: ["LS_CLIENT_SECRET", "LIGHTSPEED_PASS"],
  refreshToken: ["LS_REFRESH_TOKEN", "LIGHTSPEED_OAUTH_REFRESH_TOKEN"],
  accountId: ["LS_ACCOUNT_ID", "LIGHTSPEED_ACCOUNT_ID"],
};

export function loadCredentials(env = process.env) {
  const credentials = {};
  const missing = [];

  for (const [field, names] of Object.entries(CREDENTIALS)) {
    const name = names.find((n) => env[n]?.trim());
    if (name) credentials[field] = env[name].trim();
    else missing.push(names);
  }

  return { credentials, missing };
}

export function missingCredentialsMessage(missing) {
  const lines = missing.map(([primary, alias]) => `  - ${primary} (or ${alias})`);
  return [
    "Missing required Lightspeed credentials:",
    ...lines,
    "",
    `Set them in ${join(packageRoot, ".env")} (see .env.example), or pass them`,
    "in the MCP server's env block. Run `npm run doctor` to verify setup.",
  ].join("\n");
}

// Write tools (create_item/update_item) are off unless explicitly enabled —
// a server registered for read-only use shouldn't gain the ability to
// mutate a live store just because credentials happen to have write scope.
export function writesEnabled(env = process.env) {
  const raw = (env.LS_MCP_ENABLE_WRITES ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
