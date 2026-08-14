#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  LightspeedClient,
  fetchSales,
  fetchSale,
  fetchItems,
  fetchItem,
  fetchCustomers,
  fetchCustomer,
  fetchVendors,
  fetchVendor,
} from "./lightspeed.js";

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
    const sales = await fetchSales(client, {
      since,
      until,
      completedOnly: completed_only,
      includeLines: include_lines,
      limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ count: sales.length, sales }, null, 2) }],
    };
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

const limitSchema = (def) =>
  z.number().int().positive().max(500).optional().default(def).describe("Maximum records to return (paginates automatically, capped at 500).");
const sinceSchema = z.string().optional().describe("ISO 8601 timestamp. Only return records modified at or after this time.");
const untilSchema = z.string().optional().describe("ISO 8601 timestamp. Only return records modified at or before this time.");

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
    const items = await fetchItems(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify({ count: items.length, items }, null, 2) }] };
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
    const customers = await fetchCustomers(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify({ count: customers.length, customers }, null, 2) }] };
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
    const vendors = await fetchVendors(client, { search, since, until, limit });
    return { content: [{ type: "text", text: JSON.stringify({ count: vendors.length, vendors }, null, 2) }] };
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

const transport = new StdioServerTransport();
await server.connect(transport);
