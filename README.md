# ls-mcp

A local MCP server that exposes Lightspeed Retail (R-Series) API **V3** data
as tools for **Claude Code** and **Claude Desktop** — sales, purchase orders,
workorders, items, customers, vendors, employees, categories, manufacturers,
and shops. Read-only by default; create/update tools for several resources
are available as an opt-in (see [Write tools](#write-tools-off-by-default)).
Standalone — not
part of the atc-qbp Rails app, so it runs without dragging in Rails.

Requires Node 18+. Claude Code setup below uses the `claude` CLI; for Claude
Desktop see [Claude Desktop](#claude-desktop).

> Built by Claude (Anthropic), prompted and reviewed by a human maintainer.

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

## Claude Desktop

Not `claude.ai` — that runs in the cloud and can't launch a local process.
Claude Desktop can, in two ways:

### One-click install (`.mcpb`)

```bash
npm run package:mcpb
```

Builds `dist/ls-mcp.mcpb` from a clean copy of the server (production
`node_modules` only — never your working `.env` or `.git`). Double-click the
file, or drag it into the Claude Desktop window, or use Settings → Extensions
→ Advanced settings → Install Extension…. Claude Desktop prompts for the four
Lightspeed credentials and stores them encrypted via the OS keychain
(Keychain on macOS, Credential Manager on Windows) — no `.env` file involved.
"Enable write tools" is a checkbox in the same install UI, equivalent to
`LS_MCP_ENABLE_WRITES`.

Rebuild and reinstall the `.mcpb` after any code change; Claude Desktop
doesn't pick up edits to a running extension automatically.

### Manual config

Add an entry to Claude Desktop's `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "lightspeed": {
      "command": "/absolute/path/to/ls_mcp/bin/ls-mcp"
    }
  }
}
```

Same launcher as Claude Code, so credentials keep living in this directory's
`.env` (see above) rather than in that JSON file. Restart Claude Desktop
after editing the config.

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

The same create/update pair exists for six more resources, all following the
identical shape (`confirm` defaults to `false`; dry run shows the payload or
`{ current, proposed }`; only an allowlisted field subset is accepted):

- `create_customer`/`update_customer(customer_id, first_name?, last_name?, title?, company?, company_registration_number?, vat_number?, dob?, customer_type_id?, discount_id?, tax_category_id?, archived?, confirm?)`
  — Contact info (addresses/phones/emails) isn't supported; manage that in
  the Lightspeed UI.
- `create_vendor`/`update_vendor(vendor_id, name, account_number?, price_level?, update_price?, update_cost?, update_description?, share_sell_through?, b2b_seller_uid?, confirm?)`
  — `name` required on create. Contact and Reps aren't supported.
- `create_category`/`update_category(category_id, name, full_path_name?, parent_id?, confirm?)`
  — `name` required on create. `parent_id` sets hierarchy (`0` for top-level).
- `create_manufacturer`/`update_manufacturer(manufacturer_id, name, confirm?)`
  — one field: `name`, required on create.
- `create_order`/`update_order(order_id, vendor_id, ordered_date?, received_date?, arrival_date?, ref_num?, ship_instructions?, stock_instructions?, ship_cost?, other_cost?, discount?, shop_id?, b2b_order_uid?, b2b_order_number?, confirm?)`
  — vendor purchase order **header only**; `vendor_id` required on create.
  `OrderLines` (the items ordered) go through a separate endpoint this client
  doesn't expose yet, so a created order has no line items until added
  another way. Setting `received_date` moves the order to "Check-In" status;
  setting `ordered_date` moves it to "Ordered".
- `create_workorder`/`update_workorder(workorder_id, customer_id, time_in?, eta_out?, note?, internal_note?, warranty?, hook_in?, hook_out?, save_parts?, assign_employee_to_all?, discount_id?, employee_id?, serialized_id?, shop_id?, workorder_status_id?, confirm?)`
  — repair/service ticket **header only**; `customer_id` required on create.
  `WorkorderLines` (labor) and `WorkorderItems` (parts) go through separate
  endpoints this client doesn't expose yet.

**These tools don't exist unless you opt in.** Set `LS_MCP_ENABLE_WRITES=true`
in `.env` (or the server's env block) — otherwise none of the `create_*`/
`update_*` tools get registered, regardless of what the OAuth credentials
are scoped for. This is a separate gate from `confirm`: the env var controls
whether the tools are *available* at all; `confirm` controls whether a given
call *mutates* anything. Restart your Claude Code session after changing it,
same as any other MCP config change.

Every `list_*` tool's response includes `count` (records returned),
`hasMore` (`true` if more matching records exist beyond the `limit`/page cap
— i.e. the response was truncated, not exhaustive), and `apiMatchCount`
(Lightspeed's own reported total match count for the query, when it
provides one — note this is *before* client-side filters like
`completed_only`, so it can be a bit higher than the true filtered total).

Scope: `Sale`, `Order`, `Workorder`/`WorkorderStatus`, `Item`, `Customer`,
`Vendor`, `Employee`, `Category`, `Manufacturer`, and `Shop` are exposed —
not the full Lightspeed API surface (no other resources like
Register/Inventory/Tax). Writes (opt-in — see above) cover `Item`,
`Customer`, `Vendor`, `Category`, `Manufacturer`, `Order`, and `Workorder`;
`Sale` and `Shop` are intentionally not writable (transactional/POS-integrity
and store-config risk), and `Employee`/`WorkorderStatus` have no write tools
either. `Order`/`Workorder` writes cover the header only — their line-item
sub-resources (`OrderLine`, `WorkorderLine`, `WorkorderItem`) aren't exposed.
`LightspeedClient.request()`/`LightspeedClient.write()` in `lightspeed.js`
are generic, and `registerWritePair()` in `index.js` generates a
`create_*`/`update_*` tool pair from a field-spec list, so adding another
read-only or writable resource follows the same pattern as the existing
ones.

## Notes

- Uses the V3 cursor-based pagination endpoints
  (`https://api.merchantos.com/API/V3/...`) and the same OAuth refresh-token
  flow as the atc-qbp Rails app.
- Line items come back as raw Lightspeed `SaleLine` records (itemID,
  quantity, price, etc.) — no item description/title join. Add that later by
  extending `load_relations` in `lightspeed.js` if needed.
- Credentials are secrets — `.env` is gitignored; never commit it.
