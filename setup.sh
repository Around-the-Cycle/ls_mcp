#!/usr/bin/env bash
# One-command setup: installs deps, writes .env, verifies credentials against
# the live API, and registers the server with Claude Code.
#
# Credentials are read from the environment (or an existing .env). Either
# spelling works:
#   LS_CLIENT_ID     / LIGHTSPEED_USERNAME
#   LS_CLIENT_SECRET / LIGHTSPEED_PASS
#   LS_REFRESH_TOKEN / LIGHTSPEED_OAUTH_REFRESH_TOKEN
#   LS_ACCOUNT_ID    / LIGHTSPEED_ACCOUNT_ID
#
# LS_MCP_ENABLE_WRITES (optional, default false) gates the create_*/update_*
# tools — they don't register at all unless this is true/1/yes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. Install Node 18+ and re-run." >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  echo "node $(node -v) is too old — need 18+." >&2
  exit 1
fi

echo "==> Installing dependencies"
npm install --no-fund --no-audit

# Only write .env from the environment if credentials were actually provided;
# otherwise leave any existing .env alone.
first_set() {
  for name in "$@"; do
    local value="${!name:-}"
    if [ -n "$value" ]; then printf '%s' "$value"; return 0; fi
  done
  return 1
}

client_id="$(first_set LS_CLIENT_ID LIGHTSPEED_USERNAME || true)"
client_secret="$(first_set LS_CLIENT_SECRET LIGHTSPEED_PASS || true)"
refresh_token="$(first_set LS_REFRESH_TOKEN LIGHTSPEED_OAUTH_REFRESH_TOKEN || true)"
account_id="$(first_set LS_ACCOUNT_ID LIGHTSPEED_ACCOUNT_ID || true)"

if [ -n "$client_id" ] && [ -n "$client_secret" ] && [ -n "$refresh_token" ] && [ -n "$account_id" ]; then
  echo "==> Writing .env"
  umask 077
  cat > .env <<EOF
LS_CLIENT_ID=$client_id
LS_CLIENT_SECRET=$client_secret
LS_REFRESH_TOKEN=$refresh_token
LS_ACCOUNT_ID=$account_id
LS_MCP_ENABLE_WRITES=${LS_MCP_ENABLE_WRITES:-false}
EOF
  chmod 600 .env
elif [ -f .env ]; then
  echo "==> Using existing .env"
else
  echo "No credentials in the environment and no .env file found." >&2
  echo "Copy .env.example to .env, fill it in, and re-run." >&2
  exit 1
fi

echo "==> Verifying credentials"
node doctor.js

if command -v claude >/dev/null 2>&1; then
  echo "==> Registering with Claude Code"
  # Credentials live in .env (loaded relative to this directory), so they do
  # not need to be duplicated into the MCP host's config file.
  claude mcp remove lightspeed --scope user >/dev/null 2>&1 || true
  claude mcp add lightspeed --scope user -- "$root/bin/ls-mcp"
  echo
  echo "Done. Restart your Claude Code session — MCP servers connect at session start."
else
  echo
  echo "The 'claude' CLI was not found, so the server was not registered."
  echo "Once it is installed, run:"
  echo "  claude mcp add lightspeed --scope user -- $root/bin/ls-mcp"
fi
