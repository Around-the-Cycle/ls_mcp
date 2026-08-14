#!/usr/bin/env node
// Preflight check: verifies deps, credentials, OAuth refresh, and a live API
// call, so setup problems surface here instead of as an opaque
// "Connection closed" error inside an MCP host.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCredentials, missingCredentialsMessage, packageRoot } from "./config.js";
import { LightspeedClient, fetchShops } from "./lightspeed.js";

const pass = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => console.log(`  FAIL  ${msg}`);

console.log("ls-mcp doctor\n");

const [major] = process.versions.node.split(".").map(Number);
if (major >= 18) pass(`node ${process.versions.node}`);
else {
  fail(`node ${process.versions.node} — need >= 18 (global fetch)`);
  process.exit(1);
}

if (existsSync(join(packageRoot, "node_modules", "@modelcontextprotocol", "sdk"))) {
  pass("dependencies installed");
} else {
  fail("dependencies missing — run `npm install`");
  process.exit(1);
}

const { credentials, missing } = loadCredentials();
if (missing.length) {
  fail("credentials incomplete");
  console.log(`\n${missingCredentialsMessage(missing)}`);
  process.exit(1);
}
pass(`credentials present (account ${credentials.accountId})`);

const client = new LightspeedClient(credentials);

try {
  await client.getAccessToken();
  pass("OAuth token refresh");
} catch (err) {
  fail("OAuth token refresh");
  console.log(`\n${err.message}\n`);
  console.log("Check LS_CLIENT_ID / LS_CLIENT_SECRET / LS_REFRESH_TOKEN.");
  console.log("Refresh tokens are revoked if the API client is reset in Lightspeed.");
  process.exit(1);
}

try {
  const { shops } = await fetchShops(client, { limit: 5 });
  pass(`API reachable (${shops.length} shop${shops.length === 1 ? "" : "s"}: ${shops.map((s) => s.name).join(", ")})`);
} catch (err) {
  fail("API request");
  console.log(`\n${err.message}\n`);
  console.log("Token refresh worked, so check that LS_ACCOUNT_ID is correct.");
  process.exit(1);
}

console.log("\nAll checks passed. Register the server with:");
console.log(`  claude mcp add lightspeed --scope user -- ${join(packageRoot, "bin", "ls-mcp")}`);
console.log("\nThen restart your Claude Code session — MCP servers connect at session start.");
