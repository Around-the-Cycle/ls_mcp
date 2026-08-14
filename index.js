#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  LightspeedClient,
  fetchSales,
  fetchSale,
  fetchSalesSummary,
  fetchOrders,
  fetchOrder,
  fetchWorkorders,
  fetchWorkorder,
  fetchWorkorderStatuses,
  fetchWorkorderStatus,
  fetchItems,
  fetchItem,
  fetchCustomers,
  fetchCustomer,
  fetchVendors,
  fetchVendor,
  fetchEmployees,
  fetchEmployee,
  fetchCategories,
  fetchCategory,
  fetchManufacturers,
  fetchManufacturer,
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

const requiredEnv = ["LS_CLIENT_ID", "LS_CLIENT_SECRET", "LS_REFRESH_TOKEN", "LS_ACCOUNT_ID"];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const client = new LightspeedClient({
  clientId: process.env.LS_CLIENT_ID,
  clientSecret: process.env.LS_CLIENT_SECRET,
  refreshToken: process.env.LS_REFRESH_TOKEN,
  accountId: process.env.LS_ACCOUNT_ID,
});

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

const transport = new StdioServerTransport();
await server.connect(transport);
