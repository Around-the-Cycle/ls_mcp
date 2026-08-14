#!/usr/bin/env bash
# Builds dist/ls-mcp.mcpb — a one-click Claude Desktop extension.
#
# Packs a *copy* of the server (not the working directory in place) so a
# stray .env or .git never ends up inside the archive, and so the bundled
# node_modules is a clean production install rather than whatever's on disk.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$root/dist/mcpb-build"
out="$root/dist/ls-mcp.mcpb"

rm -rf "$build" "$out"
mkdir -p "$build"

cp "$root/index.js" "$root/lightspeed.js" "$root/config.js" \
   "$root/manifest.json" "$root/package.json" "$root/package-lock.json" \
   "$root/README.md" "$build/"
[ -f "$root/icon.png" ] && cp "$root/icon.png" "$build/"

echo "==> Installing production dependencies for bundle"
(cd "$build" && npm install --omit=dev --no-audit --no-fund --no-package-lock)

echo "==> Validating manifest"
npx -y @anthropic-ai/mcpb validate "$build/manifest.json"

echo "==> Packing MCPB"
npx -y @anthropic-ai/mcpb pack "$build" "$out"

rm -rf "$build"

echo "==> Wrote $(realpath --relative-to="$root" "$out" 2>/dev/null || echo "$out")"
