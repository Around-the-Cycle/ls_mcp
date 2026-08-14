# ls-mcp

A local MCP server that exposes Lightspeed Retail (R-Series) API **V3** sales
history as tools for Claude Desktop. Standalone — not part of the atc-qbp
Rails app, so it can be pointed at Claude Desktop without dragging in Rails.

## Setup

```
npm install
cp .env.example .env
```

Fill in `.env` with your Lightspeed OAuth2 credentials (client id/secret,
refresh token, account id). If you already have these for the atc-qbp app,
they're the same values — see the mapping in `.env.example`.

## Register with Claude Desktop

Add to `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "lightspeed": {
      "command": "node",
      "args": ["/home/dechimp/.repos/ls_mcp/index.js"],
      "env": {
        "LS_CLIENT_ID": "...",
        "LS_CLIENT_SECRET": "...",
        "LS_REFRESH_TOKEN": "...",
        "LS_ACCOUNT_ID": "..."
      }
    }
  }
}
```

Claude Desktop launches the server as a subprocess and does not read `.env`
files from arbitrary directories, so credentials need to be passed via the
`env` block above (or exported in the shell Desktop inherits from). Restart
Claude Desktop after editing the config.

## Tools

- `list_sales(since?, until?, completed_only?, include_lines?, limit?)` —
  paginated sales history, newest first. `since`/`until` are ISO 8601
  timestamps (e.g. `2024-01-01T00:00:00-05:00`).
- `get_sale(sale_id, include_lines?)` — a single sale by `saleID`.
- `list_items(search?, since?, until?, limit?)` — catalog items, `search`
  matches against `description` (substring).
- `get_item(item_id)` — a single catalog item by `itemID`.
- `list_customers(search?, since?, until?, limit?)` — customers, `search`
  matches against `lastName` (substring).
- `get_customer(customer_id)` — a single customer by `customerID`.
- `list_vendors(search?, since?, until?, limit?)` — vendors, `search`
  matches against `name` (substring).
- `get_vendor(vendor_id)` — a single vendor by `vendorID`.

Scope: only `Sale`, `Item`, `Customer`, and `Vendor` are exposed — not the
full Lightspeed API surface (no write endpoints, no other resources like
Employee/Register/Inventory). `LightspeedClient.request()` in
`lightspeed.js` is generic, so adding another read-only resource follows the
same pattern as the existing `fetch*` helpers.

## Notes

- Uses the V3 cursor-based pagination endpoints
  (`https://api.merchantos.com/API/V3/...`) and the same OAuth refresh-token
  flow as the atc-qbp Rails app.
- Line items come back as raw Lightspeed `SaleLine` records (itemID,
  quantity, price, etc.) — no item description/title join. Add that later by
  extending `load_relations` in `lightspeed.js` if needed.
- Credentials are secrets — `.env` is gitignored; never commit it.
