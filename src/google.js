// google.js — reading spend, campaigns and Customer Match lists out of Google Ads.
//
// Read-only, same as src/meta.js. Ben builds the campaigns; this only finds the
// ones belonging to a show and reports on them.
//
// A note on the API version: Google sunsets these roughly every few months and
// a retired version answers 404, not a helpful error. v18 was already dead when
// this was written; v22 is current. When reports suddenly show no paid search,
// check this first — `tsf doctor` reports the version it is using.
//
// EDIT THIS FILE IF: the version needs bumping, or you want a metric the report
// does not carry yet.

import { loadConfig } from "./config.js";
import { parseTag } from "./metaNaming.js";

/** Bump when Google retires the current one. See the note above. */
export const API_VERSION = "v22";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BASE = "https://googleads.googleapis.com";

let cachedToken = null;

function credentials() {
  const { google } = loadConfig();
  const missing = ["clientId", "clientSecret", "refreshToken", "developerToken", "customerId"]
    .filter((key) => !google[key]);

  if (missing.length) {
    throw new Error(
      `Google Ads is not configured (missing ${missing.join(", ")}).\n` +
        "Without it the report still runs — it just has no paid search in it."
    );
  }
  return google;
}

async function accessToken() {
  if (cachedToken) return cachedToken;
  const google = credentials();

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: google.clientId,
      client_secret: google.clientSecret,
      refresh_token: google.refreshToken,
    }),
  });

  const body = await response.json();
  if (!body.access_token) {
    throw new Error(`Google token refresh failed: ${body.error_description || body.error || "unknown"}`);
  }
  cachedToken = body.access_token;
  return cachedToken;
}

/**
 * Runs a GAQL query and flattens the streamed pages into one array.
 *
 * @param {string} query
 */
export async function query(gaql) {
  const google = credentials();
  const token = await accessToken();
  const customer = google.customerId;

  const response = await fetch(`${BASE}/${API_VERSION}/customers/${customer}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "developer-token": google.developerToken,
      "login-customer-id": google.loginCustomerId || customer,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: gaql }),
  });

  const text = await response.text();

  if (!response.ok) {
    // A retired API version answers with an HTML 404, which is worth naming
    // rather than dumping a page of markup into the report.
    if (response.status === 404 && text.startsWith("<")) {
      throw new Error(
        `Google Ads API ${API_VERSION} is no longer available. ` +
          "Bump API_VERSION in src/google.js to the current one."
      );
    }
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      message = parsed?.[0]?.error?.message || parsed?.error?.message || message;
    } catch { /* keep the raw text */ }
    throw new Error(`Google Ads → ${response.status}: ${message}`);
  }

  return JSON.parse(text).flatMap((page) => page.results || []);
}

const dollars = (micros) => (micros ? Number(micros) / 1e6 : 0);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Campaigns with delivery over a date range.
 *
 * @param {object} range { since: "YYYY-MM-DD", until: "YYYY-MM-DD" }
 */
export async function campaigns(range) {
  const rows = await query(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign_budget.amount_micros, campaign_budget.total_amount_micros,
           metrics.cost_micros, metrics.impressions, metrics.clicks,
           metrics.conversions, metrics.ctr, metrics.average_cpc
    FROM campaign
    WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'
    ORDER BY metrics.cost_micros DESC
  `);

  return rows.map((row) => ({
    id: row.campaign.id,
    name: row.campaign.name,
    status: row.campaign.status,
    channel: row.campaign.advertisingChannelType,
    dailyBudget: dollars(row.campaignBudget?.amountMicros),
    totalBudget: dollars(row.campaignBudget?.totalAmountMicros),
    spend: dollars(row.metrics?.costMicros),
    impressions: Number(row.metrics?.impressions || 0),
    clicks: Number(row.metrics?.clicks || 0),
    conversions: Number(row.metrics?.conversions || 0),
    ctr: row.metrics?.ctr ? Number(row.metrics.ctr) * 100 : null,
    cpc: dollars(row.metrics?.averageCpc),
  }));
}

/** Customer Match lists, so an audience can be tied to what Google actually holds. */
export async function userLists() {
  const rows = await query(`
    SELECT user_list.id, user_list.name, user_list.size_for_display,
           user_list.size_for_search, user_list.type, user_list.membership_status
    FROM user_list
    WHERE user_list.type = 'CRM_BASED'
  `);

  return rows.map((row) => ({
    id: row.userList.id,
    name: row.userList.name,
    sizeDisplay: Number(row.userList.sizeForDisplay || 0),
    sizeSearch: Number(row.userList.sizeForSearch || 0),
    status: row.userList.membershipStatus,
  }));
}

// ---------------------------------------------------------------------------
// Matching campaigns to a show
// ---------------------------------------------------------------------------

/**
 * Which Google campaigns belong to a show, and why we think so.
 *
 * Same tag convention as Meta — `[tsf:sema-2026]` in the campaign name. A tag
 * naming a different show excludes outright; without a tag we fall back to a
 * recorded id or the show name appearing in the campaign name, and say so.
 */
export function matchCampaigns(show, audiences, allCampaigns) {
  const recorded = new Set(
    audiences
      .flatMap((a) => a.destinations || [])
      .filter((d) => d.platform === "google-ads" && d.externalId)
      .map((d) => String(d.externalId))
  );

  const words = [show.id, show.name].map((w) => String(w).toLowerCase()).filter(Boolean);
  const matches = [];

  for (const campaign of allCampaigns) {
    const tag = parseTag(campaign.name);

    if (tag) {
      if (tag.showId === show.id) {
        matches.push({
          ...campaign,
          matchedVia: "tag",
          matchedBecause: tag.campaignType
            ? `tagged for this show, as the ${tag.campaignType} campaign`
            : "tagged for this show",
        });
      }
      // A tag for another show is a definite no, whatever else looks close.
      continue;
    }

    if (recorded.has(String(campaign.id))) {
      matches.push({
        ...campaign,
        matchedVia: "recorded",
        matchedBecause: "the Google campaign id recorded against this audience",
      });
      continue;
    }

    const haystack = campaign.name.toLowerCase();
    if (words.some((word) => haystack.includes(word))) {
      matches.push({
        ...campaign,
        matchedVia: "name",
        matchedBecause: "the campaign name mentions this show",
      });
    }
  }

  return matches;
}

/** Resets the cached token. Only needed in tests. */
export function _resetTokenCache() {
  cachedToken = null;
}
