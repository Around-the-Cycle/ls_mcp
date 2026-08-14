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

Every `list_*` tool's response includes `count` (records returned),
`hasMore` (`true` if more matching records exist beyond the `limit`/page cap
— i.e. the response was truncated, not exhaustive), and `apiMatchCount`
(Lightspeed's own reported total match count for the query, when it
provides one — note this is *before* client-side filters like
`completed_only`, so it can be a bit higher than the true filtered total).

Scope: `Sale`, `Order`, `Workorder`/`WorkorderStatus`, `Item`, `Customer`,
`Vendor`, `Employee`, `Category`, `Manufacturer`, and `Shop` are exposed —
not the full Lightspeed API surface (no write endpoints, no other resources
like Register/Inventory/Tax). `LightspeedClient.request()` in
`lightspeed.js` is generic, so adding another read-only resource follows
the same pattern as the existing `fetch*` helpers.

## Notes

- Uses the V3 cursor-based pagination endpoints
  (`https://api.merchantos.com/API/V3/...`) and the same OAuth refresh-token
  flow as the atc-qbp Rails app.
- Line items come back as raw Lightspeed `SaleLine` records (itemID,
  quantity, price, etc.) — no item description/title join. Add that later by
  extending `load_relations` in `lightspeed.js` if needed.
- Credentials are secrets — `.env` is gitignored; never commit it.
