// hubspot.js — every call to HubSpot goes through here.
//
// EDIT THIS FILE IF: HubSpot changes an endpoint, or you need a call the tool
// does not make yet. Add a small named function rather than calling `request`
// from elsewhere — it keeps the rest of the codebase free of URLs.

import { loadConfig } from "./config.js";

const BASE = "https://api.hubapi.com";

// HubSpot allows 100 records per batch on CRM object endpoints.
export const BATCH_SIZE = 100;

let cachedToken = null;

/**
 * Gets a usable access token. If refresh credentials are present we always
 * refresh, because the stored access token expires after 30 minutes and a
 * stale one is the single most common "why did this stop working" cause.
 */
async function getToken() {
  if (cachedToken) return cachedToken;
  const { hubspot } = loadConfig();

  if (hubspot.refreshToken && hubspot.clientId && hubspot.clientSecret) {
    const response = await fetch(`${BASE}/oauth/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: hubspot.clientId,
        client_secret: hubspot.clientSecret,
        refresh_token: hubspot.refreshToken,
      }),
    });
    const body = await response.json();
    if (body.access_token) {
      cachedToken = body.access_token;
      return cachedToken;
    }
    throw new Error(
      `HubSpot token refresh failed: ${body.message || JSON.stringify(body)}`
    );
  }

  if (hubspot.accessToken) {
    cachedToken = hubspot.accessToken;
    return cachedToken;
  }

  throw new Error(
    "No HubSpot credentials found. Copy .env.example to .env and fill it in."
  );
}

/**
 * One HTTP call to HubSpot, with retries on the errors that are worth retrying
 * (429 rate limit and 5xx). Anything else throws immediately with the message
 * HubSpot gave us, because guessing at a fix is worse than stopping.
 */
async function request(method, path, body, { retries = 4 } = {}) {
  const token = await getToken();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();

    if (response.ok) return text ? JSON.parse(text) : null;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries) {
      // HubSpot sends Retry-After on 429. Fall back to a widening backoff.
      const headerWait = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(headerWait) && headerWait > 0
        ? headerWait * 1000
        : 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    throw new Error(`HubSpot ${method} ${path} → ${response.status}: ${text.slice(0, 500)}`);
  }
}

export const get = (path) => request("GET", path);
export const post = (path, body) => request("POST", path, body);
export const patch = (path, body) => request("PATCH", path, body);

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Creates or updates contacts in batches.
 *
 * We upsert against a custom unique property (ts_dedupe_key), NOT email.
 * HubSpot does not support partial upserts when email is the idProperty — it
 * would blank out any field we did not send. See docs/DECISIONS.md.
 *
 * @param {Array<{id: string, properties: object}>} records
 *        `id` is the ts_dedupe_key value; `properties` is what to write.
 */
export async function upsertContacts(records, idProperty = "ts_dedupe_key") {
  const results = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    const response = await post("/crm/v3/objects/contacts/batch/upsert", {
      inputs: chunk.map((record) => ({
        idProperty,
        id: record.id,
        properties: record.properties,
      })),
    });
    results.push(...(response?.results || []));
  }
  return results;
}

/** Looks up contacts by a property value, in batches. Missing ones are omitted. */
export async function readContactsByProperty(values, idProperty, propertiesToReturn) {
  const found = [];
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const chunk = values.slice(i, i + BATCH_SIZE);
    const response = await post("/crm/v3/objects/contacts/batch/read", {
      idProperty,
      properties: propertiesToReturn,
      inputs: chunk.map((value) => ({ id: value })),
    });
    found.push(...(response?.results || []));
  }
  return found;
}

/** Runs a CRM search. Used to find duplicates by phone or name+company. */
export async function searchContacts(filterGroups, properties, limit = 100) {
  const response = await post("/crm/v3/objects/contacts/search", {
    filterGroups,
    properties,
    limit,
  });
  return response?.results || [];
}

// ---------------------------------------------------------------------------
// Lists — this is what an "audience" actually is on the HubSpot side
// ---------------------------------------------------------------------------

/** Creates a list. processingType MANUAL lets us add members explicitly. */
export async function createList({ name, processingType = "MANUAL", filterBranch }) {
  const payload = { name, objectTypeId: "0-1", processingType };
  if (filterBranch) payload.filterBranch = filterBranch;
  const response = await post("/crm/v3/lists", payload);
  return response?.list || response;
}

/** Fetches one list, including its current size. */
export async function getList(listId) {
  const response = await get(`/crm/v3/lists/${listId}?includeFilters=true`);
  return response?.list || response;
}

/** Adds contact record IDs to a MANUAL list. */
export async function addToList(listId, contactIds) {
  for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
    await post(`/crm/v3/lists/${listId}/memberships/add`, contactIds.slice(i, i + BATCH_SIZE));
  }
}

/** Searches lists by name. Useful for spotting an audience that already exists. */
export async function searchLists(query, count = 50) {
  const response = await post("/crm/v3/lists/search", { query, count, offset: 0 });
  return response?.lists || [];
}

// ---------------------------------------------------------------------------
// Forms — used by `tsf discover forms` to find where tablet sign-ups land
// ---------------------------------------------------------------------------

export async function listForms() {
  const response = await get("/marketing/v3/forms?limit=100");
  return response?.results || [];
}

export async function getFormSubmissions(formId, limit = 20) {
  const response = await get(
    `/form-integrations/v1/submissions/forms/${formId}?limit=${limit}`
  );
  return response?.results || [];
}

/** Resets the cached token. Only needed in tests. */
export function _resetTokenCache() {
  cachedToken = null;
}
