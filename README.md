# ls-mcp

A local MCP server that exposes Lightspeed Retail (R-Series) API **V3** data
as tools for **Claude Code** — sales, purchase orders, workorders, items,
customers, vendors, employees, categories, manufacturers, and shops.
Read-only by default; item creation/updates are available as an opt-in (see
[Write tools](#write-tools-off-by-default)). Standalone — not part of the
atc-qbp Rails app, so it runs without dragging in Rails.

Requires Node 18+ and the `claude` CLI.

## Setup

```bash
git clone https://github.com/Around-the-Cycle/ls_mcp.git ~/.repos/ls_mcp
cd ~/.repos/ls_mcp
LS_CLIENT_ID=... LS_CLIENT_SECRET=... LS_REFRESH_TOKEN=... LS_ACCOUNT_ID=... ./setup.sh
```

`setup.sh` installs dependencies, writes a `0600` `.env`, verifies the
credentials against the live API, and registers the server with Claude Code.
It is safe to re-run.

The `LIGHTSPEED_*` names from the atc-qbp Rails app also work, so credentials
copied from there need no hand-mapping:

| ls-mcp | atc-qbp |
| --- | --- |
| `LS_CLIENT_ID` | `LIGHTSPEED_USERNAME` |
| `LS_CLIENT_SECRET` | `LIGHTSPEED_PASS` |
| `LS_REFRESH_TOKEN` | `LIGHTSPEED_OAUTH_REFRESH_TOKEN` |
| `LS_ACCOUNT_ID` | `LIGHTSPEED_ACCOUNT_ID` |

Without credentials in the environment, `setup.sh` uses an existing `.env`
(copy `.env.example` and fill it in).

**Restart your Claude Code session afterwards** — MCP servers connect at
session start, so a server registered mid-session won't appear until then.

Verify at any time:

```bash
npm run doctor
```

This checks the Node version, dependencies, credentials, OAuth refresh, and a
live API call, reporting exactly which step failed.

## Where credentials live

In `.env` in this directory, which is gitignored and mode `0600`. It is loaded
relative to this package, not the working directory, so it works no matter
where the MCP host launches the server from.

Credentials deliberately are **not** put in the `claude mcp add --env` block:
that writes them in plaintext into `~/.claude.json`, giving a second copy to
keep in sync and leak.

## Claude Desktop / claude.ai

Not supported. This is a local stdio server, so it only works with Claude
Code. The claude.ai web app runs in the cloud and cannot launch a local
process, and current Claude desktop app builds configure connectors through
their own UI rather than a hand-edited `mcpServers` JSON block. Exposing this
to those surfaces would mean hosting it as a remote MCP server over HTTPS.

## Troubleshooting

**"Failed to connect" / "Connection closed" in Claude Code.** Run
`npm run doctor` — it surfaces the underlying cause, which the MCP host hides.
Note that the registered command is `bin/ls-mcp`, a launcher that reinstalls
dependencies automatically if `node_modules` goes missing.

**Tools don't appear after registering.** Restart the session; MCP servers
connect only at session start.

**`OAuth token refresh` fails.** The refresh token is likely revoked —
resetting the API client in Lightspeed invalidates it. Issue a new one.

**`API request` fails but token refresh passed.** `LS_ACCOUNT_ID` is probably
wrong.

## Tools

- `list_sales(since?, until?, completed_only?, include_lines?, limit?)` —
  paginated sales history, newest first. `since`/`until` are ISO 8601
  timestamps (e.g. `2024-01-01T00:00:00-05:00`). For busy date ranges this
  can return a lot of raw JSON (every sale + line item) — prefer
  `sales_summary` for revenue/volume questions.
- `sales_summary(since?, until?, completed_only?, top_n?, limit?)` —
  aggregates sales for a date range into total revenue, average sale value,
  a daily breakdown, top items by quantity/revenue, and the largest
  individual sales, computed server-side. Use this instead of `list_sales`
  for questions like "how much did we sell this month" — it returns a
  compact summary instead of every raw sale/line item. If the range has more
  matching sales than `limit` (default 2000, max 5000), the response's
  `truncated` field is `true` and the totals are an undercount.
- `get_sale(sale_id, include_lines?)` — a single sale by `saleID`.
- `list_orders(since?, until?, vendor_id?, complete_only?, include_lines?, limit?)`
  — purchase orders placed *with* vendors (not customer Sales), newest
  first. `complete_only` defaults to `false` — open/in-transit orders are
  usually what you want to see, unlike `completed_only` on `list_sales`.
- `get_order(order_id, include_lines?)` — a single purchase order by
  `orderID`, including `OrderLines` (items ordered/received).
- `list_workorders(since?, until?, customer_id?, employee_id?, workorder_status_id?, include_lines?, limit?)`
  — service/repair tickets, newest first. **Not the same as `list_orders`**:
  `Order` is a vendor purchase order (stock coming in), `Workorder` is a
  repair/service job (work done for a customer). Includes each workorder's
  `WorkorderLines` (labor/tasks) and `WorkorderItems` (parts used) by
  default.
- `get_workorder(workorder_id, include_lines?)` — a single workorder by
  `workorderID`.
- `list_workorder_statuses(limit?)` — the status labels configured on the
  account (e.g. "In Progress", "Ready for Pickup"), for resolving
  `Workorder.workorderStatusID`.
- `get_workorder_status(workorder_status_id)` — a single status by
  `workorderStatusID`.
- `list_items(search?, since?, until?, limit?)` — catalog items, `search`
  matches against `description` (substring).
- `get_item(item_id)` — a single catalog item by `itemID`.
- `list_customers(search?, since?, until?, limit?)` — customers, `search`
  matches against `lastName` (substring).
- `get_customer(customer_id)` — a single customer by `customerID`.
- `list_vendors(search?, since?, until?, limit?)` — vendors, `search`
  matches against `name` (substring).
- `get_vendor(vendor_id)` — a single vendor by `vendorID`.
- `list_employees(search?, since?, until?, limit?)` — employees, `search`
  matches against `lastName` (substring).
- `get_employee(employee_id)` — a single employee by `employeeID`.
- `list_categories(search?, since?, until?, limit?)` — item categories
  (hierarchical — see `parentID`/`fullPathName`), `search` matches against
  `name` (substring).
- `get_category(category_id)` — a single category by `categoryID`.
- `list_manufacturers(search?, since?, until?, limit?)` — manufacturers
  (brands), `search` matches against `name` (substring).
- `get_manufacturer(manufacturer_id)` — a single manufacturer by
  `manufacturerID`.
- `list_shops(since?, until?, limit?)` — store locations (typically a short,
  mostly-static list).
- `get_shop(shop_id)` — a single shop by `shopID`.

### Write tools (off by default)

- `create_item(description, default_cost?, tax?, discountable?, upc?, ean?, custom_sku?, manufacturer_sku?, model_year?, category_id?, tax_class_id?, manufacturer_id?, default_vendor_id?, prices?, confirm?)`
  — creates a new catalog `Item`. `confirm` defaults to `false`: without it,
  the tool returns the payload it *would* send instead of creating anything.
  Pass `confirm: true` to actually create it.
- `update_item(item_id, description?, default_cost?, ..., prices?, confirm?)`
  — same fields as `create_item`, applied to an existing item. `confirm`
  defaults to `false`: without it, the tool fetches the item and returns
  `{ current, proposed }` so you can review the diff before applying it.
  Pass `confirm: true` to actually apply the update.
- `prices` on both: an array of `{ use_type_id, amount }`. `use_type_id` is
  an account-specific price-slot ID (Default, MSRP, etc.) with no fixed
  numbering — read valid IDs off an existing item's `Prices.ItemPrice` via
  `get_item` first. Only slots you list are touched; others are left as-is.
- Both tools only accept a conservative field allowlist (see
  `ITEM_WRITABLE_FIELDS` in `lightspeed.js`) — deliberately excludes
  `itemType`, `serialized`, and `itemMatrixID`, which change an item's
  structural type and are too easy to corrupt blind through an MCP tool.

**These tools don't exist unless you opt in.** Set `LS_MCP_ENABLE_WRITES=true`
in `.env` (or the server's env block) — otherwise `create_item`/`update_item`
never get registered, regardless of what the OAuth credentials are scoped
for. This is a separate gate from `confirm`: the env var controls whether the
tools are *available* at all; `confirm` controls whether a given call
*mutates* anything. Restart your Claude Code session after changing it, same
as any other MCP config change.

Every `list_*` tool's response includes `count` (records returned),
`hasMore` (`true` if more matching records exist beyond the `limit`/page cap
— i.e. the response was truncated, not exhaustive), and `apiMatchCount`
(Lightspeed's own reported total match count for the query, when it
provides one — note this is *before* client-side filters like
`completed_only`, so it can be a bit higher than the true filtered total).

Scope: `Sale`, `Order`, `Workorder`/`WorkorderStatus`, `Item`, `Customer`,
`Vendor`, `Employee`, `Category`, `Manufacturer`, and `Shop` are exposed —
not the full Lightspeed API surface (no other resources like
Register/Inventory/Tax). Writes are currently limited to `Item`
(`create_item`/`update_item`, opt-in — see above); everything else is
read-only. `LightspeedClient.request()`/`LightspeedClient.write()` in
`lightspeed.js` are generic, so adding another read-only or writable
resource follows the same pattern as the existing `fetch*`/`createItem`/
`updateItem` helpers.

## Notes

- Uses the V3 cursor-based pagination endpoints
  (`https://api.merchantos.com/API/V3/...`) and the same OAuth refresh-token
  flow as the atc-qbp Rails app.
- Line items come back as raw Lightspeed `SaleLine` records (itemID,
  quantity, price, etc.) — no item description/title join. Add that later by
  extending `load_relations` in `lightspeed.js` if needed.
- Credentials are secrets — `.env` is gitignored; never commit it.
