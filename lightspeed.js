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

// Fetches Sale records (optionally with SaleLines), following cursor
// pagination until `limit` results are collected or pages run out.
export async function fetchSales(
  client,
  { since, until, completedOnly = true, limit = 50, includeLines = true, maxPages = 50 } = {}
) {
  const timeStamp = timeStampFilter(since, until);
  const baseParams = {
    limit: Math.min(limit, 100),
    sort: "-timeStamp",
    ...(includeLines ? { load_relations: '["SaleLines"]' } : {}),
    ...(timeStamp ? { timeStamp } : {}),
  };

  const results = [];
  let nextUrl = null;
  let page = 0;

  while (page < maxPages) {
    page++;
    const json = nextUrl
      ? await client.requestAbsolute(nextUrl)
      : await client.request("Sale.json", baseParams);

    const raw = json?.Sale;
    const sales = Array.isArray(raw) ? raw : raw ? [raw] : [];

    for (const sale of sales) {
      if (completedOnly && sale.completed !== "true") continue;
      results.push(sale);
      if (results.length >= limit) return results;
    }

    nextUrl = json?.["@attributes"]?.next || null;
    if (!nextUrl) break;
  }

  return results;
}

export async function fetchSale(client, saleId, { includeLines = true } = {}) {
  const params = includeLines ? { load_relations: '["SaleLines"]' } : {};
  const json = await client.request(`Sale/${saleId}.json`, params);
  return json?.Sale ?? null;
}
