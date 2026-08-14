// Minimal Lightspeed Retail (R-Series) API V3 client: OAuth2 refresh-token
// flow + cursor-based pagination, mirroring the request shape used by the
// atc-qbp Rails app (see app/lib/lightspeed_api.rb / app/lib/lsapi/o_auth).

const TOKEN_URL = "https://cloud.merchantos.com/oauth/access_token.php";
const API_BASE = "https://api.merchantos.com/API/V3";

export class LightspeedClient {
  constructor({ clientId, clientSecret, refreshToken, accountId }) {
    if (!clientId || !clientSecret || !refreshToken || !accountId) {
      throw new Error(
        "LightspeedClient requires clientId, clientSecret, refreshToken, and accountId"
      );
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.accountId = accountId;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.expiresAt - 15_000) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  async refreshAccessToken() {
    const body = new URLSearchParams({
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
    });
    const res = await fetch(TOKEN_URL, { method: "POST", body });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Lightspeed token refresh failed: ${res.status} ${text}`);
    }
    const json = JSON.parse(text);
    if (!json.access_token) {
      throw new Error(`Lightspeed token refresh returned no access_token: ${text}`);
    }
    this.accessToken = json.access_token;
    this.expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 10 * 60 * 1000);
    return this.accessToken;
  }

  // path: e.g. "Sale.json"; params: plain object of query params
  async request(path, params = {}) {
    const url = new URL(`${API_BASE}/Account/${this.accountId}/${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    return this.#authedFetch(url.toString());
  }

  // for following the `next`/`previous` cursor URLs the API returns verbatim
  async requestAbsolute(url) {
    return this.#authedFetch(url);
  }

  async #authedFetch(url, retried = false) {
    const token = await this.getAccessToken();
    const res = await fetch(url, { headers: { authorization: `OAuth ${token}` } });
    if (res.status === 401 && !retried) {
      this.accessToken = null; // force a fresh token and retry once
      return this.#authedFetch(url, true);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Lightspeed API error ${res.status} for ${url}: ${text}`);
    }
    return JSON.parse(text);
  }
}

// Builds a Lightspeed `timeStamp` filter query value.
//   since only      -> ">,2024-01-01T00:00:00-05:00"
//   until only      -> "<,2024-01-01T00:00:00-05:00"
//   since and until -> "><,2024-01-01T00:00:00-05:00,2024-02-01T00:00:00-05:00"
export function timeStampFilter(since, until) {
  if (since && until) return `><,${since},${until}`;
  if (since) return `>,${since}`;
  if (until) return `<,${until}`;
  return undefined;
}

// Fetches a page-by-page collection of `resourceName` records (e.g. "Sale",
// "Item", "Customer", "Vendor"), following the `@attributes.next` cursor URL
// until `limit` results (post-filter) are collected or pages run out.
//
// Returns { results, hasMore, apiCount }:
//   - hasMore: true if there were more matching records beyond what's
//     returned (either more unconsumed records/pages, or `maxPages` was hit
//     while a `next` cursor still existed). Lets callers tell "that's
//     everything" apart from "silently truncated at the cap".
//   - apiCount: the API's own `@attributes.count` from the first page, i.e.
//     the total records matching the query *before* any client-side
//     `filter` (e.g. completed_only) is applied. Undefined if the API
//     didn't report one.
async function paginate(client, resourceName, params, { limit, filter, maxPages = 50 } = {}) {
  const results = [];
  let nextUrl = null;
  let page = 0;
  let hasMore = false;
  let apiCount;

  while (page < maxPages) {
    page++;
    const json = nextUrl
      ? await client.requestAbsolute(nextUrl)
      : await client.request(`${resourceName}.json`, params);

    if (page === 1) {
      const rawCount = json?.["@attributes"]?.count;
      if (rawCount !== undefined) apiCount = Number(rawCount);
    }

    const raw = json?.[resourceName];
    const records = Array.isArray(raw) ? raw : raw ? [raw] : [];
    nextUrl = json?.["@attributes"]?.next || null;

    for (const record of records) {
      if (filter && !filter(record)) continue;
      if (results.length >= limit) {
        hasMore = true;
        break;
      }
      results.push(record);
    }

    if (results.length >= limit) {
      if (nextUrl) hasMore = true;
      break;
    }

    if (!nextUrl) break;
  }

  if (page >= maxPages && nextUrl) hasMore = true;

  return { results, hasMore, apiCount };
}

// Fetches Sale records (optionally with SaleLines), following cursor
// pagination until `limit` results are collected or pages run out.
// Returns { sales, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchSales(
  client,
  { since, until, completedOnly = true, limit = 50, includeLines = true, maxPages = 50 } = {}
) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "-timeStamp",
    ...(includeLines ? { load_relations: '["SaleLines"]' } : {}),
    ...(timeStamp ? { timeStamp } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Sale", params, {
    limit,
    maxPages,
    filter: completedOnly ? (sale) => sale.completed === "true" : undefined,
  });
  return { sales: results, hasMore, apiCount };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Aggregates Sale + SaleLine records into summary stats for a date range —
// totals, daily breakdown, top items, largest sales — instead of returning
// every raw record. Fetches up to `limit` sales (same truncation semantics
// as fetchSales; check `truncated` on the result before trusting totals for
// a range that might exceed `limit`).
export async function fetchSalesSummary(
  client,
  { since, until, completedOnly = true, limit = 2000, maxPages = 100, topN = 10 } = {}
) {
  const { sales, hasMore } = await fetchSales(client, {
    since,
    until,
    completedOnly,
    limit,
    maxPages,
    includeLines: true,
  });

  let totalRevenue = 0;
  let revenueBearingCount = 0;
  let revenueBearingTotal = 0;
  let totalUnits = 0;
  let totalLineItems = 0;
  const byDate = new Map(); // date -> { count, revenue }
  const itemQty = new Map(); // itemID -> qty
  const itemRevenue = new Map(); // itemID -> revenue

  for (const sale of sales) {
    const total = parseFloat(sale.total ?? "0") || 0;
    totalRevenue += total;
    if (total > 0) {
      revenueBearingCount++;
      revenueBearingTotal += total;
    }

    const date = (sale.timeStamp || "").slice(0, 10);
    const dayEntry = byDate.get(date) || { count: 0, revenue: 0 };
    dayEntry.count++;
    dayEntry.revenue += total;
    byDate.set(date, dayEntry);

    const lines = sale.SaleLines?.SaleLine;
    const lineArray = Array.isArray(lines) ? lines : lines ? [lines] : [];
    for (const line of lineArray) {
      totalLineItems++;
      const qty = parseFloat(line.unitQuantity ?? "0") || 0;
      const rev = parseFloat(line.calcTotal ?? "0") || 0;
      totalUnits += qty;
      const itemId = line.itemID ?? "unknown";
      itemQty.set(itemId, (itemQty.get(itemId) || 0) + qty);
      itemRevenue.set(itemId, (itemRevenue.get(itemId) || 0) + rev);
    }
  }

  const topItemsByQuantity = [...itemQty.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([itemID, qty]) => ({ itemID, qty }));

  const topItemsByRevenue = [...itemRevenue.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([itemID, revenue]) => ({ itemID, revenue: round2(revenue) }));

  const largestSales = [...sales]
    .sort((a, b) => (parseFloat(b.total) || 0) - (parseFloat(a.total) || 0))
    .slice(0, topN)
    .map((s) => ({ saleID: s.saleID, total: round2(parseFloat(s.total) || 0), timeStamp: s.timeStamp }));

  const dailyBreakdown = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, count: v.count, revenue: round2(v.revenue) }));

  return {
    saleCount: sales.length,
    truncated: hasMore,
    totalRevenue: round2(totalRevenue),
    averageSaleValue: sales.length ? round2(totalRevenue / sales.length) : 0,
    revenueBearingSaleCount: revenueBearingCount,
    averageRevenueBearingSaleValue: revenueBearingCount ? round2(revenueBearingTotal / revenueBearingCount) : 0,
    totalUnits,
    totalLineItems,
    dailyBreakdown,
    topItemsByQuantity,
    topItemsByRevenue,
    largestSales,
  };
}

export async function fetchSale(client, saleId, { includeLines = true } = {}) {
  const params = includeLines ? { load_relations: '["SaleLines"]' } : {};
  const json = await client.request(`Sale/${saleId}.json`, params);
  return json?.Sale ?? null;
}

// Item.description supports a LIKE-style filter: `~,%word%`.
// Returns { items, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchItems(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "description",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { description: `~,%${search}%` } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Item", params, { limit, maxPages });
  return { items: results, hasMore, apiCount };
}

export async function fetchItem(client, itemId) {
  const json = await client.request(`Item/${itemId}.json`);
  return json?.Item ?? null;
}

// `search` matches against Customer.lastName (LIKE, e.g. "smith").
// Returns { customers, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchCustomers(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "lastName",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { lastName: `~,%${search}%` } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Customer", params, { limit, maxPages });
  return { customers: results, hasMore, apiCount };
}

export async function fetchCustomer(client, customerId) {
  const json = await client.request(`Customer/${customerId}.json`);
  return json?.Customer ?? null;
}

// `search` matches against Vendor.name (LIKE, e.g. "qbp").
// Returns { vendors, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchVendors(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "name",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { name: `~,%${search}%` } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Vendor", params, { limit, maxPages });
  return { vendors: results, hasMore, apiCount };
}

export async function fetchVendor(client, vendorId) {
  const json = await client.request(`Vendor/${vendorId}.json`);
  return json?.Vendor ?? null;
}

// Purchase orders placed with vendors (not customer Sales). Optionally
// filtered by date, vendorID, and/or completion status (`complete` is only
// set once an order has been fully checked in — most shops want to see
// open/in-transit orders too, so unlike fetchSales this does NOT filter to
// completed-only by default).
// Returns { orders, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchOrders(
  client,
  { since, until, completeOnly = false, vendorId, limit = 50, includeLines = true, maxPages = 50 } = {}
) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "-timeStamp",
    ...(includeLines ? { load_relations: '["OrderLines"]' } : {}),
    ...(timeStamp ? { timeStamp } : {}),
    ...(vendorId !== undefined ? { vendorID: vendorId } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Order", params, {
    limit,
    maxPages,
    filter: completeOnly ? (order) => order.complete === "true" : undefined,
  });
  return { orders: results, hasMore, apiCount };
}

export async function fetchOrder(client, orderId, { includeLines = true } = {}) {
  const params = includeLines ? { load_relations: '["OrderLines"]' } : {};
  const json = await client.request(`Order/${orderId}.json`, params);
  return json?.Order ?? null;
}

// `search` matches against Employee.lastName (LIKE, e.g. "smith").
// Returns { employees, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchEmployees(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "employeeID",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { lastName: `~,%${search}%` } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Employee", params, { limit, maxPages });
  return { employees: results, hasMore, apiCount };
}

export async function fetchEmployee(client, employeeId) {
  const json = await client.request(`Employee/${employeeId}.json`);
  return json?.Employee ?? null;
}

// Item categories (hierarchical — see `parentID`/`fullPathName`).
// `search` matches against Category.name (LIKE, e.g. "wheels").
// Returns { categories, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchCategories(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "categoryID",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { name: `~,%${search}%` } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Category", params, { limit, maxPages });
  return { categories: results, hasMore, apiCount };
}

export async function fetchCategory(client, categoryId) {
  const json = await client.request(`Category/${categoryId}.json`);
  return json?.Category ?? null;
}

// `search` matches against Manufacturer.name (LIKE, e.g. "shimano").
// Returns { manufacturers, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchManufacturers(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "name",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { name: `~,%${search}%` } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Manufacturer", params, { limit, maxPages });
  return { manufacturers: results, hasMore, apiCount };
}

export async function fetchManufacturer(client, manufacturerId) {
  const json = await client.request(`Manufacturer/${manufacturerId}.json`);
  return json?.Manufacturer ?? null;
}

// Store locations. Typically a short, mostly-static list, so no `search`.
// Returns { shops, hasMore, apiCount } — see `paginate` for what those mean.
export async function fetchShops(client, { since, until, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "shopID",
    ...(timeStamp ? { timeStamp } : {}),
  };
  const { results, hasMore, apiCount } = await paginate(client, "Shop", params, { limit, maxPages });
  return { shops: results, hasMore, apiCount };
}

export async function fetchShop(client, shopId) {
  const json = await client.request(`Shop/${shopId}.json`);
  return json?.Shop ?? null;
}
