#!/usr/bin/env node
import { loadCredentials, missingCredentialsMessage, writesEnabled } from "./config.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  LightspeedClient,
  pickAllowed,
  fetchSales,
  fetchSale,
  fetchSalesSummary,
  fetchOrders,
  fetchOrder,
  createOrder,
  updateOrder,
  fetchWorkorders,
  fetchWorkorder,
  createWorkorder,
  updateWorkorder,
  fetchWorkorderStatuses,
  fetchWorkorderStatus,
  fetchItems,
  fetchItem,
  createItem,
  updateItem,
  buildItemPayload,
  pickItemFields,
  ITEM_WRITABLE_FIELDS,
  fetchCustomers,
  fetchCustomer,
  createCustomer,
  updateCustomer,
  fetchVendors,
  fetchVendor,
  createVendor,
  updateVendor,
  fetchEmployees,
  fetchEmployee,
  fetchCategories,
  fetchCategory,
  createCategory,
  updateCategory,
  fetchManufacturers,
  fetchManufacturer,
  createManufacturer,
  updateManufacturer,
  fetchShops,
  fetchShop,
} from "./lightspeed.js";

// Attaches hasMore/apiMatchCount alongside a resource's records so callers
// can tell "that's everything" apart from "silently truncated at the cap".
function paginatedPayload(key, records, hasMore, apiCount) {
  return {
    count: records.length,
    hasMore,
    ...(apiCount !== undefined ? { apiMatchCount: apiCount } : {}),
    [key]: records,
  };
}

const { credentials, missing } = loadCredentials();
if (missing.length) {
  console.error(missingCredentialsMessage(missing));
  process.exit(1);
}

const client = new LightspeedClient(credentials);
const writesOn = writesEnabled();
console.error(`ls-mcp: write tools ${writesOn ? "ENABLED" : "disabled"} (set LS_MCP_ENABLE_WRITES=true to enable)`);

const server = new McpServer({ name: "ls-mcp", version: "1.0.0" });

const limitSchema = (def) =>
  z.number().int().positive().max(500).optional().default(def).describe("Maximum records to return (paginates automatically, capped at 500).");
const sinceSchema = z.string().optional().describe("ISO 8601 timestamp. Only return records modified at or after this time.");
const untilSchema = z.string().optional().describe("ISO 8601 timestamp. Only return records modified at or before this time.");

server.registerTool(
  "list_sales",
  {
    description:
      "List Lightspeed Retail (R-Series) sales history, optionally filtered by date range. " +
      "Returns sale-level records (total, timestamps, status) and, by default, their line items.",
    inputSchema: {
      since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return sales at or after this time, e.g. 2024-01-01T00:00:00-05:00"),
      until: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return sales at or before this time."),
      completed_only: z
        .boolean()
        .optional()
        .default(true)
        .describe("Exclude sales that are not marked completed in Lightspeed."),
      include_lines: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include each sale's SaleLines (line items) in the result."),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .default(50)
        .describe("Maximum number of sales to return (paginates automatically, capped at 500)."),
    },
  },
  async ({ since, until, completed_only, include_lines, limit }) => {
    const { sales, hasMore, apiCount } = await fetchSales(client, {
      since,
      until,
      completedOnly: completed_only,
      includeLines: include_lines,
      limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(paginatedPayload("sales", sales, hasMore, apiCount), null, 2) }],
    };
  }
);

server.registerTool(
  "sales_summary",
  {
    description:
      "Aggregate Lightspeed Retail (R-Series) sales into summary statistics for a date range — total " +
      "revenue, average sale value, a daily breakdown, top items by quantity/revenue, and the largest " +
      "individual sales — computed server-side instead of returning every raw sale and line item. Use this " +
      "for revenue/volume questions (e.g. 'how much did we sell this month') instead of list_sales, which " +
      "returns raw records and can be very large for busy date ranges.",
    inputSchema: {
      since: z.string().optional().describe("ISO 8601 timestamp. Only include sales at or after this time, e.g. 2024-01-01T00:00:00-05:00"),
      until: z.string().optional().describe("ISO 8601 timestamp. Only include sales at or before this time."),
      completed_only: z
        .boolean()
        .optional()
        .default(true)
        .describe("Exclude sales that are not marked completed in Lightspeed."),
      top_n: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .default(10)
        .describe("How many top items and largest sales to include in the summary."),
      limit: z
        .number()
        .int()
        .positive()
        .max(5000)
        .optional()
        .default(2000)
        .describe(
          "Maximum sales to fetch and aggregate over (paginates automatically). If the date range has " +
          "more matching sales than this, the response's `truncated` flag will be true and totals will " +
          "be an undercount — narrow the date range or raise this limit."
        ),
    },
  },
  async ({ since, until, completed_only, top_n, limit }) => {
    const summary = await fetchSalesSummary(client, {
      since,
      until,
      completedOnly: completed_only,
      topN: top_n,
      limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

server.registerTool(
  "get_sale",
  {
    description: "Fetch a single Lightspeed sale by its saleID, including line items.",
    inputSchema: {
      sale_id: z.union([z.string(), z.number()]).describe("The Lightspeed saleID to look up."),
      include_lines: z.boolean().optional().default(true),
    },
  },
  async ({ sale_id, include_lines }) => {
    const sale = await fetchSale(client, sale_id, { includeLines: include_lines });
    if (!sale) {
      return { content: [{ type: "text", text: `No sale found for saleID ${sale_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(sale, null, 2) }] };
  }
);

server.registerTool(
  "list_orders",
  {
    description:
      "List Lightspeed Retail (R-Series) purchase orders placed with vendors, optionally filtered by date " +
      "range, vendor, or completion status. Returns order-level records (costs, vendor, dates, status) and, " +
      "by default, their OrderLines (items ordered/received). Not the same as list_sales — Orders are what " +
      "the shop buys from vendors, Sales are what customers buy from the shop.",
    inputSchema: {
      since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return orders at or after this time, e.g. 2024-01-01T00:00:00-05:00"),
      until: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return orders at or before this time."),
      vendor_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Only return orders placed with this vendorID."),
      complete_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Only include orders marked complete (fully checked in). Defaults to false since open/in-transit " +
          "orders are usually what you want to see, unlike completed_only on list_sales."
        ),
      include_lines: z.boolean().optional().default(true).describe("Include each order's OrderLines (items ordered) in the result."),
      limit: limitSchema(50),
    },
  },
  async ({ since, until, vendor_id, complete_only, include_lines, limit }) => {
    const { orders, hasMore, apiCount } = await fetchOrders(client, {
      since,
      until,
      vendorId: vendor_id,
      completeOnly: complete_only,
      includeLines: include_lines,
      limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("orders", orders, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_order",
  {
    description: "Fetch a single Lightspeed purchase order by its orderID, including OrderLines.",
    inputSchema: {
      order_id: z.union([z.string(), z.number()]).describe("The Lightspeed orderID to look up."),
      include_lines: z.boolean().optional().default(true),
    },
  },
  async ({ order_id, include_lines }) => {
    const order = await fetchOrder(client, order_id, { includeLines: include_lines });
    if (!order) {
      return { content: [{ type: "text", text: `No order found for orderID ${order_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(order, null, 2) }] };
  }
);

server.registerTool(
  "list_workorders",
  {
    description:
      "List Lightspeed Retail (R-Series) workorders — service/repair tickets (customer, employee, status, " +
      "parts, labor) — newest first. NOT the same as list_orders: Order is a vendor purchase order (stock " +
      "you're buying in), Workorder is a repair/service job (work you're doing for a customer). Includes " +
      "each workorder's WorkorderLines (labor/tasks) and WorkorderItems (parts used) by default.",
    inputSchema: {
      since: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return workorders at or after this time, e.g. 2024-01-01T00:00:00-05:00"),
      until: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return workorders at or before this time."),
      customer_id: z.union([z.string(), z.number()]).optional().describe("Only return workorders for this customerID."),
      employee_id: z.union([z.string(), z.number()]).optional().describe("Only return workorders assigned to this employeeID."),
      workorder_status_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Only return workorders with this workorderStatusID. Use list_workorder_statuses to look up IDs/names."),
      include_lines: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include each workorder's WorkorderLines and WorkorderItems in the result."),
      limit: limitSchema(50),
    },
  },
  async ({ since, until, customer_id, employee_id, workorder_status_id, include_lines, limit }) => {
    const { workorders, hasMore, apiCount } = await fetchWorkorders(client, {
      since,
      until,
      customerId: customer_id,
      employeeId: employee_id,
      workorderStatusId: workorder_status_id,
      includeLines: include_lines,
      limit,
    });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("workorders", workorders, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_workorder",
  {
    description: "Fetch a single Lightspeed workorder (repair/service ticket) by its workorderID, including WorkorderLines and WorkorderItems.",
    inputSchema: {
      workorder_id: z.union([z.string(), z.number()]).describe("The Lightspeed workorderID to look up."),
      include_lines: z.boolean().optional().default(true),
    },
  },
  async ({ workorder_id, include_lines }) => {
    const workorder = await fetchWorkorder(client, workorder_id, { includeLines: include_lines });
    if (!workorder) {
      return { content: [{ type: "text", text: `No workorder found for workorderID ${workorder_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(workorder, null, 2) }] };
  }
);

server.registerTool(
  "list_workorder_statuses",
  {
    description:
      "List the workorder status labels configured on this Lightspeed account (e.g. 'In Progress', 'Ready " +
      "for Pickup'), used to resolve Workorder.workorderStatusID to a human-readable name/color.",
    inputSchema: { limit: limitSchema(50) },
  },
  async ({ limit }) => {
    const { workorderStatuses, hasMore, apiCount } = await fetchWorkorderStatuses(client, { limit });
    return {
      content: [{ type: "text", text: JSON.stringify(paginatedPayload("workorderStatuses", workorderStatuses, hasMore, apiCount), null, 2) }],
    };
  }
);

server.registerTool(
  "get_workorder_status",
  {
    description: "Fetch a single Lightspeed workorder status by its workorderStatusID.",
    inputSchema: { workorder_status_id: z.union([z.string(), z.number()]).describe("The Lightspeed workorderStatusID to look up.") },
  },
  async ({ workorder_status_id }) => {
    const status = await fetchWorkorderStatus(client, workorder_status_id);
    if (!status) {
      return { content: [{ type: "text", text: `No workorder status found for workorderStatusID ${workorder_status_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

server.registerTool(
  "list_items",
  {
    description: "List Lightspeed catalog items (products), optionally filtered by description text or modified date.",
    inputSchema: {
      search: z.string().optional().describe("Substring to match against Item.description, e.g. 'stem'."),
      since: sinceSchema,
      until: untilSchema,
      limit: limitSchema(50),
    },
  },
  async ({ search, since, until, limit }) => {
    const { items, hasMore, apiCount } = await fetchItems(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("items", items, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_item",
  {
    description: "Fetch a single Lightspeed catalog item by its itemID.",
    inputSchema: { item_id: z.union([z.string(), z.number()]).describe("The Lightspeed itemID to look up.") },
  },
  async ({ item_id }) => {
    const item = await fetchItem(client, item_id);
    if (!item) return { content: [{ type: "text", text: `No item found for itemID ${item_id}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
  }
);

server.registerTool(
  "list_customers",
  {
    description: "List Lightspeed customers, optionally filtered by last name or modified date.",
    inputSchema: {
      search: z.string().optional().describe("Substring to match against Customer.lastName, e.g. 'smith'."),
      since: sinceSchema,
      until: untilSchema,
      limit: limitSchema(50),
    },
  },
  async ({ search, since, until, limit }) => {
    const { customers, hasMore, apiCount } = await fetchCustomers(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("customers", customers, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_customer",
  {
    description: "Fetch a single Lightspeed customer by their customerID.",
    inputSchema: { customer_id: z.union([z.string(), z.number()]).describe("The Lightspeed customerID to look up.") },
  },
  async ({ customer_id }) => {
    const customer = await fetchCustomer(client, customer_id);
    if (!customer) {
      return { content: [{ type: "text", text: `No customer found for customerID ${customer_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(customer, null, 2) }] };
  }
);

server.registerTool(
  "list_vendors",
  {
    description: "List Lightspeed vendors, optionally filtered by name or modified date.",
    inputSchema: {
      search: z.string().optional().describe("Substring to match against Vendor.name, e.g. 'qbp'."),
      since: sinceSchema,
      until: untilSchema,
      limit: limitSchema(50),
    },
  },
  async ({ search, since, until, limit }) => {
    const { vendors, hasMore, apiCount } = await fetchVendors(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("vendors", vendors, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_vendor",
  {
    description: "Fetch a single Lightspeed vendor by its vendorID.",
    inputSchema: { vendor_id: z.union([z.string(), z.number()]).describe("The Lightspeed vendorID to look up.") },
  },
  async ({ vendor_id }) => {
    const vendor = await fetchVendor(client, vendor_id);
    if (!vendor) return { content: [{ type: "text", text: `No vendor found for vendorID ${vendor_id}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(vendor, null, 2) }] };
  }
);

server.registerTool(
  "list_employees",
  {
    description: "List Lightspeed employees, optionally filtered by last name or modified date.",
    inputSchema: {
      search: z.string().optional().describe("Substring to match against Employee.lastName, e.g. 'smith'."),
      since: sinceSchema,
      until: untilSchema,
      limit: limitSchema(50),
    },
  },
  async ({ search, since, until, limit }) => {
    const { employees, hasMore, apiCount } = await fetchEmployees(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("employees", employees, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_employee",
  {
    description: "Fetch a single Lightspeed employee by their employeeID.",
    inputSchema: { employee_id: z.union([z.string(), z.number()]).describe("The Lightspeed employeeID to look up.") },
  },
  async ({ employee_id }) => {
    const employee = await fetchEmployee(client, employee_id);
    if (!employee) {
      return { content: [{ type: "text", text: `No employee found for employeeID ${employee_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(employee, null, 2) }] };
  }
);

server.registerTool(
  "list_categories",
  {
    description: "List Lightspeed item categories (hierarchical), optionally filtered by name or modified date.",
    inputSchema: {
      search: z.string().optional().describe("Substring to match against Category.name, e.g. 'wheels'."),
      since: sinceSchema,
      until: untilSchema,
      limit: limitSchema(50),
    },
  },
  async ({ search, since, until, limit }) => {
    const { categories, hasMore, apiCount } = await fetchCategories(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("categories", categories, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_category",
  {
    description: "Fetch a single Lightspeed item category by its categoryID.",
    inputSchema: { category_id: z.union([z.string(), z.number()]).describe("The Lightspeed categoryID to look up.") },
  },
  async ({ category_id }) => {
    const category = await fetchCategory(client, category_id);
    if (!category) {
      return { content: [{ type: "text", text: `No category found for categoryID ${category_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(category, null, 2) }] };
  }
);

server.registerTool(
  "list_manufacturers",
  {
    description: "List Lightspeed manufacturers (brands), optionally filtered by name or modified date.",
    inputSchema: {
      search: z.string().optional().describe("Substring to match against Manufacturer.name, e.g. 'shimano'."),
      since: sinceSchema,
      until: untilSchema,
      limit: limitSchema(50),
    },
  },
  async ({ search, since, until, limit }) => {
    const { manufacturers, hasMore, apiCount } = await fetchManufacturers(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("manufacturers", manufacturers, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_manufacturer",
  {
    description: "Fetch a single Lightspeed manufacturer by its manufacturerID.",
    inputSchema: { manufacturer_id: z.union([z.string(), z.number()]).describe("The Lightspeed manufacturerID to look up.") },
  },
  async ({ manufacturer_id }) => {
    const manufacturer = await fetchManufacturer(client, manufacturer_id);
    if (!manufacturer) {
      return { content: [{ type: "text", text: `No manufacturer found for manufacturerID ${manufacturer_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(manufacturer, null, 2) }] };
  }
);

server.registerTool(
  "list_shops",
  {
    description: "List Lightspeed shop (store) locations, optionally filtered by modified date.",
    inputSchema: {
      since: sinceSchema,
      until: untilSchema,
      limit: limitSchema(50),
    },
  },
  async ({ since, until, limit }) => {
    const { shops, hasMore, apiCount } = await fetchShops(client, { since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify(paginatedPayload("shops", shops, hasMore, apiCount), null, 2) }] };
  }
);

server.registerTool(
  "get_shop",
  {
    description: "Fetch a single Lightspeed shop (store location) by its shopID.",
    inputSchema: { shop_id: z.union([z.string(), z.number()]).describe("The Lightspeed shopID to look up.") },
  },
  async ({ shop_id }) => {
    const shop = await fetchShop(client, shop_id);
    if (!shop) return { content: [{ type: "text", text: `No shop found for shopID ${shop_id}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(shop, null, 2) }] };
  }
);

// --- Write tools (create_*/update_*) — off unless LS_MCP_ENABLE_WRITES=true ---
//
// Registers a create_<noun>/update_<noun> pair on `server`. Every writable
// resource follows the same shape: snake_case tool input mapped to the
// camelCase fields Lightspeed's API uses, an allowlist-filtered payload, and
// a dry-run-by-default/confirm:true-to-apply flow. `specs` entries are
// [snakeName, camelName, zodType, transform?] — `transform` (default
// identity) lets a field need reshaping between tool input and API payload,
// e.g. Item's `prices`.
//
// `buildPayload`/`pickCurrent` default to a plain allowlist pick (derived
// from `specs`' camel names) but can be overridden for resources that need
// extra shaping — Item passes its own to fold `prices` into the nested
// `Prices.ItemPrice` structure the API expects.
function registerWritePair(
  server,
  { noun, resourceLabel, idParam, idField, specs, extraCreateSchema = {}, extraNotes = "", buildPayload, pickCurrent, fetchOne, create, update }
) {
  const allowlist = specs.map(([, camel]) => camel);
  const buildPayloadFn = buildPayload ?? ((fields) => pickAllowed(fields, allowlist));
  const pickCurrentFn = pickCurrent ?? ((current) => pickAllowed(current, allowlist));
  const baseSchema = Object.fromEntries(specs.map(([snake, , zodType]) => [snake, zodType]));
  const notesSuffix = extraNotes ? ` ${extraNotes}` : "";

  function mapInput(input) {
    const fields = {};
    for (const [snake, camel, , transform] of specs) {
      if (input[snake] !== undefined) {
        fields[camel] = transform ? transform(input[snake]) : input[snake];
      }
    }
    return fields;
  }

  server.registerTool(
    `create_${noun}`,
    {
      description:
        `Create a new Lightspeed ${resourceLabel}. WRITES to the live store. Defaults to a dry run — ` +
        `returns the payload that would be sent without creating anything. Pass confirm: true to actually ` +
        `create it.${notesSuffix}`,
      inputSchema: {
        ...baseSchema,
        ...extraCreateSchema,
        confirm: z.boolean().optional().default(false).describe(`Set true to actually create the ${noun}. Defaults to false (dry run).`),
      },
    },
    async ({ confirm, ...input }) => {
      const fields = mapInput(input);
      const payload = buildPayloadFn(fields);
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { dryRun: true, proposed: payload, message: `Dry run — no ${noun} created. Pass confirm: true to create it.` },
                null,
                2
              ),
            },
          ],
        };
      }
      const created = await create(client, fields);
      return { content: [{ type: "text", text: JSON.stringify({ applied: true, [noun]: created }, null, 2) }] };
    }
  );

  server.registerTool(
    `update_${noun}`,
    {
      description:
        `Update fields on an existing Lightspeed ${resourceLabel}. WRITES to the live store. Defaults to a ` +
        `dry run — returns the current values and proposed change without applying it. Pass confirm: true to ` +
        `actually apply the update.${notesSuffix}`,
      inputSchema: {
        [idParam]: z.union([z.string(), z.number()]).describe(`The Lightspeed ${idField} to update.`),
        ...baseSchema,
        confirm: z.boolean().optional().default(false).describe("Set true to actually apply the update. Defaults to false (dry run)."),
      },
    },
    async (rawInput) => {
      const { confirm, [idParam]: id, ...input } = rawInput;
      const current = await fetchOne(client, id);
      if (!current) {
        return { content: [{ type: "text", text: `No ${noun} found for ${idField} ${id}` }], isError: true };
      }
      const fields = mapInput(input);
      const payload = buildPayloadFn(fields);
      if (Object.keys(payload).length === 0) {
        return { content: [{ type: "text", text: "No fields provided to update." }], isError: true };
      }
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  dryRun: true,
                  [idField]: id,
                  current: pickCurrentFn(current),
                  proposed: payload,
                  message: "Dry run — no changes applied. Pass confirm: true to apply this update.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      const updated = await update(client, id, fields);
      return { content: [{ type: "text", text: JSON.stringify({ applied: true, [noun]: updated }, null, 2) }] };
    }
  );
}

const pricesSpec = [
  "prices",
  "prices",
  z
    .array(
      z.object({
        use_type_id: z
          .union([z.string(), z.number()])
          .describe(
            "Account-specific price-slot ID (Default, MSRP, etc.) — there's no fixed numbering. " +
              "Read valid IDs off this item's current Prices via get_item before setting one."
          ),
        amount: z.union([z.string(), z.number()]).describe("Price amount, e.g. 49.99."),
      })
    )
    .optional()
    .describe("Prices to set. Only include slots you intend to change — unlisted slots are left as-is."),
  (arr) => arr.map((p) => ({ useTypeID: p.use_type_id, amount: p.amount })),
];

if (writesOn) {
  registerWritePair(server, {
    noun: "item",
    resourceLabel: "Item (catalog product)",
    idParam: "item_id",
    idField: "itemID",
    specs: [
      ["description", "description", z.string().optional()],
      ["default_cost", "defaultCost", z.union([z.string(), z.number()]).optional().describe("Cost the shop pays, e.g. 12.50.")],
      ["tax", "tax", z.boolean().optional()],
      ["discountable", "discountable", z.boolean().optional()],
      ["upc", "upc", z.string().optional()],
      ["ean", "ean", z.string().optional()],
      ["custom_sku", "customSku", z.string().optional()],
      ["manufacturer_sku", "manufacturerSku", z.string().optional()],
      ["model_year", "modelYear", z.union([z.string(), z.number()]).optional()],
      ["category_id", "categoryID", z.union([z.string(), z.number()]).optional().describe("Item.categoryID — see list_categories/get_category.")],
      ["tax_class_id", "taxClassID", z.union([z.string(), z.number()]).optional()],
      [
        "manufacturer_id",
        "manufacturerID",
        z.union([z.string(), z.number()]).optional().describe("Item.manufacturerID — see list_manufacturers/get_manufacturer."),
      ],
      [
        "default_vendor_id",
        "defaultVendorID",
        z.union([z.string(), z.number()]).optional().describe("Item.defaultVendorID — see list_vendors/get_vendor."),
      ],
      pricesSpec,
    ],
    extraCreateSchema: { description: z.string().describe("Item description/title. Required by Lightspeed.") },
    extraNotes:
      "Only a safe subset of Item fields is writable (not itemType/serialized/itemMatrixID, which change an " +
      "item's structural type). Prices need an account-specific useTypeID; look one up from get_item.",
    buildPayload: (fields) => buildItemPayload(fields, ITEM_WRITABLE_FIELDS),
    pickCurrent: (current) => pickItemFields(current, ITEM_WRITABLE_FIELDS),
    fetchOne: fetchItem,
    create: createItem,
    update: updateItem,
  });

  registerWritePair(server, {
    noun: "customer",
    resourceLabel: "Customer",
    idParam: "customer_id",
    idField: "customerID",
    specs: [
      ["first_name", "firstName", z.string().optional()],
      ["last_name", "lastName", z.string().optional()],
      ["title", "title", z.string().optional()],
      ["company", "company", z.string().optional()],
      ["company_registration_number", "companyRegistrationNumber", z.string().optional()],
      ["vat_number", "vatNumber", z.string().optional()],
      ["dob", "dob", z.string().optional().describe("ISO 8601 date, e.g. 1990-01-15T00:00:00+00:00.")],
      ["customer_type_id", "customerTypeID", z.union([z.string(), z.number()]).optional().describe("Configured in Lightspeed admin.")],
      ["discount_id", "discountID", z.union([z.string(), z.number()]).optional()],
      ["tax_category_id", "taxCategoryID", z.union([z.string(), z.number()]).optional()],
      ["archived", "archived", z.boolean().optional().describe("Archives/unarchives the customer.")],
    ],
    extraNotes: "Contact info (addresses/phones/emails) isn't supported by this tool — manage that in the Lightspeed UI.",
    fetchOne: fetchCustomer,
    create: createCustomer,
    update: updateCustomer,
  });

  registerWritePair(server, {
    noun: "vendor",
    resourceLabel: "Vendor",
    idParam: "vendor_id",
    idField: "vendorID",
    specs: [
      ["name", "name", z.string().optional()],
      ["account_number", "accountNumber", z.string().optional()],
      ["price_level", "priceLevel", z.union([z.string(), z.number()]).optional()],
      ["update_price", "updatePrice", z.boolean().optional().describe("Auto-update MSRP from this vendor's catalog feed.")],
      ["update_cost", "updateCost", z.boolean().optional().describe("Auto-update cost from this vendor's catalog feed.")],
      ["update_description", "updateDescription", z.boolean().optional().describe("Auto-update item description from this vendor's catalog feed.")],
      ["share_sell_through", "shareSellThrough", z.boolean().optional()],
      ["b2b_seller_uid", "b2bSellerUID", z.string().optional().describe("NuORDER vendor identifier.")],
    ],
    extraCreateSchema: { name: z.string().describe("Vendor name. Required by Lightspeed.") },
    extraNotes: "Contact info and Reps aren't supported by this tool — manage those in the Lightspeed UI.",
    fetchOne: fetchVendor,
    create: createVendor,
    update: updateVendor,
  });

  registerWritePair(server, {
    noun: "category",
    resourceLabel: "Category (item category)",
    idParam: "category_id",
    idField: "categoryID",
    specs: [
      ["name", "name", z.string().optional()],
      ["full_path_name", "fullPathName", z.string().optional().describe("Slash-delimited path, e.g. 'Misc/Home'.")],
      ["parent_id", "parentID", z.union([z.string(), z.number()]).optional().describe("Parent categoryID; 0 for top-level.")],
    ],
    extraCreateSchema: { name: z.string().describe("Category name. Required by Lightspeed.") },
    fetchOne: fetchCategory,
    create: createCategory,
    update: updateCategory,
  });

  registerWritePair(server, {
    noun: "manufacturer",
    resourceLabel: "Manufacturer (brand)",
    idParam: "manufacturer_id",
    idField: "manufacturerID",
    specs: [["name", "name", z.string().optional()]],
    extraCreateSchema: { name: z.string().describe("Manufacturer/brand name. Required by Lightspeed.") },
    fetchOne: fetchManufacturer,
    create: createManufacturer,
    update: updateManufacturer,
  });

  registerWritePair(server, {
    noun: "order",
    resourceLabel: "Order (vendor purchase order)",
    idParam: "order_id",
    idField: "orderID",
    specs: [
      ["ordered_date", "orderedDate", z.string().optional().describe("ISO 8601 timestamp. Setting this moves the order to 'Ordered' status.")],
      ["received_date", "receivedDate", z.string().optional().describe("ISO 8601 timestamp. Setting this moves the order to 'Check-In' status.")],
      ["arrival_date", "arrivalDate", z.string().optional().describe("Expected arrival date, ISO 8601.")],
      ["ref_num", "refNum", z.string().optional()],
      ["ship_instructions", "shipInstructions", z.string().optional()],
      ["stock_instructions", "stockInstructions", z.string().optional()],
      ["ship_cost", "shipCost", z.union([z.string(), z.number()]).optional()],
      ["other_cost", "otherCost", z.union([z.string(), z.number()]).optional()],
      ["discount", "discount", z.union([z.string(), z.number()]).optional().describe("Percentage discount on unit costs.")],
      ["shop_id", "shopID", z.union([z.string(), z.number()]).optional()],
      ["vendor_id", "vendorID", z.union([z.string(), z.number()]).optional().describe("See list_vendors/get_vendor.")],
      ["b2b_order_uid", "b2bOrderUID", z.string().optional()],
      ["b2b_order_number", "b2bOrderNumber", z.string().optional()],
    ],
    extraCreateSchema: { vendor_id: z.union([z.string(), z.number()]).describe("The vendorID this order is placed with. Required by Lightspeed.") },
    extraNotes:
      "This only creates/updates the order header — OrderLines (items ordered) aren't supported by this tool " +
      "yet; add those in the Lightspeed UI.",
    fetchOne: (c, id) => fetchOrder(c, id, { includeLines: false }),
    create: createOrder,
    update: updateOrder,
  });

  registerWritePair(server, {
    noun: "workorder",
    resourceLabel: "Workorder (repair/service ticket)",
    idParam: "workorder_id",
    idField: "workorderID",
    specs: [
      ["time_in", "timeIn", z.string().optional().describe("ISO 8601 timestamp.")],
      ["eta_out", "etaOut", z.string().optional().describe("ISO 8601 timestamp.")],
      ["note", "note", z.string().optional().describe("Customer-visible note.")],
      ["internal_note", "internalNote", z.string().optional().describe("Internal/staff-only note.")],
      ["warranty", "warranty", z.boolean().optional()],
      ["hook_in", "hookIn", z.string().optional().describe("Storage location the item was checked in at.")],
      ["hook_out", "hookOut", z.string().optional().describe("Storage location the item is checked out at.")],
      ["save_parts", "saveParts", z.boolean().optional()],
      ["assign_employee_to_all", "assignEmployeeToAll", z.boolean().optional()],
      ["customer_id", "customerID", z.union([z.string(), z.number()]).optional().describe("See list_customers/get_customer.")],
      ["discount_id", "discountID", z.union([z.string(), z.number()]).optional()],
      ["employee_id", "employeeID", z.union([z.string(), z.number()]).optional().describe("See list_employees/get_employee.")],
      ["serialized_id", "serializedID", z.union([z.string(), z.number()]).optional()],
      ["shop_id", "shopID", z.union([z.string(), z.number()]).optional()],
      [
        "workorder_status_id",
        "workorderStatusID",
        z.union([z.string(), z.number()]).optional().describe("See list_workorder_statuses/get_workorder_status."),
      ],
    ],
    extraCreateSchema: {
      customer_id: z.union([z.string(), z.number()]).describe("The customerID this workorder is for. Required by Lightspeed."),
    },
    extraNotes:
      "This only creates/updates the workorder header — WorkorderLines (labor) and WorkorderItems (parts) " +
      "aren't supported by this tool yet; manage those in the Lightspeed UI.",
    fetchOne: (c, id) => fetchWorkorder(c, id, { includeLines: false }),
    create: createWorkorder,
    update: updateWorkorder,
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
