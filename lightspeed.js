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
async function paginate(client, resourceName, params, { limit, filter, maxPages = 50 } = {}) {
  const results = [];
  let nextUrl = null;
  let page = 0;

  while (page < maxPages) {
    page++;
    const json = nextUrl
      ? await client.requestAbsolute(nextUrl)
      : await client.request(`${resourceName}.json`, params);

    const raw = json?.[resourceName];
    const records = Array.isArray(raw) ? raw : raw ? [raw] : [];

    for (const record of records) {
      if (filter && !filter(record)) continue;
      results.push(record);
      if (results.length >= limit) return results;
    }

    nextUrl = json?.["@attributes"]?.next || null;
    if (!nextUrl) break;
  }

  return results;
}

// Fetches Sale records (optionally with SaleLines), following cursor
// pagination until `limit` results are collected or pages run out.
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
  return paginate(client, "Sale", params, {
    limit,
    maxPages,
    filter: completedOnly ? (sale) => sale.completed === "true" : undefined,
  });
}

export async function fetchSale(client, saleId, { includeLines = true } = {}) {
  const params = includeLines ? { load_relations: '["SaleLines"]' } : {};
  const json = await client.request(`Sale/${saleId}.json`, params);
  return json?.Sale ?? null;
}

// Item.description supports a LIKE-style filter: `~,%word%`.
export async function fetchItems(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "description",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { description: `~,%${search}%` } : {}),
  };
  return paginate(client, "Item", params, { limit, maxPages });
}

export async function fetchItem(client, itemId) {
  const json = await client.request(`Item/${itemId}.json`);
  return json?.Item ?? null;
}

// `search` matches against Customer.lastName (LIKE, e.g. "smith").
export async function fetchCustomers(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "lastName",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { lastName: `~,%${search}%` } : {}),
  };
  return paginate(client, "Customer", params, { limit, maxPages });
}

export async function fetchCustomer(client, customerId) {
  const json = await client.request(`Customer/${customerId}.json`);
  return json?.Customer ?? null;
}

// `search` matches against Vendor.name (LIKE, e.g. "qbp").
export async function fetchVendors(client, { since, until, search, limit = 50, maxPages = 50 } = {}) {
  const timeStamp = timeStampFilter(since, until);
  const params = {
    limit: Math.min(limit, 100),
    sort: "name",
    ...(timeStamp ? { timeStamp } : {}),
    ...(search ? { name: `~,%${search}%` } : {}),
  };
  return paginate(client, "Vendor", params, { limit, maxPages });
}

export async function fetchVendor(client, vendorId) {
  const json = await client.request(`Vendor/${vendorId}.json`);
  return json?.Vendor ?? null;
}
