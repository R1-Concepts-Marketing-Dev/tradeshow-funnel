// meta.js — reading ads, spend and creative out of Meta.
//
// Read-only. This tool does not create or change anything in Meta; Ben builds
// the campaigns there. All we do is find the ones that belong to a show and
// report on them.
//
// EDIT THIS FILE IF: Meta versions the Graph API, or you need a field the
// report does not carry yet.

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { parseTag } from "./metaNaming.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/** HubSpot's native ads sync names every audience it pushes like this. */
export const HUBSPOT_AUDIENCE_PREFIX = "HubSpot - ";

function credentials() {
  const { meta } = loadConfig();
  if (!meta.accessToken || !meta.adAccountId) {
    throw new Error(
      "No Meta credentials. Set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID.\n" +
        "Without them the report still runs — it just has no paid social in it."
    );
  }
  return meta;
}

async function graph(pathAndQuery) {
  const { accessToken } = credentials();
  const joiner = pathAndQuery.includes("?") ? "&" : "?";
  const response = await fetch(`${GRAPH}${pathAndQuery}${joiner}access_token=${accessToken}`);
  const text = await response.text();

  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).error?.message || message;
    } catch { /* keep the raw text */ }
    throw new Error(`Meta ${pathAndQuery.split("?")[0]} → ${response.status}: ${message}`);
  }
  return JSON.parse(text);
}

/** Follows Meta's paging until it runs out or hits the cap. */
async function graphAll(pathAndQuery, cap = 500) {
  const out = [];
  let next = pathAndQuery;

  while (next && out.length < cap) {
    const page = await graph(next);
    out.push(...(page.data || []));
    if (!page.paging?.cursors?.after || !page.data?.length) break;
    const base = next.split("&after=")[0];
    next = `${base}&after=${page.paging.cursors.after}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Ad sets with enough targeting detail to work out which show they belong to. */
export async function listAdSets() {
  const { adAccountId } = credentials();
  return graphAll(
    `/${adAccountId}/adsets?limit=100&fields=` +
      "id,name,status,campaign{id,name},lifetime_budget,daily_budget,budget_remaining," +
      "start_time,end_time," +
      "targeting{custom_audiences,geo_locations{cities,custom_locations,regions}}"
  );
}

/** Every ad, with the creative we need for the screenshots. */
export async function listAds() {
  const { adAccountId } = credentials();
  return graphAll(
    `/${adAccountId}/ads?limit=100&fields=` +
      "id,name,status,adset{id,name},campaign{id,name}," +
      "creative{id,name,thumbnail_url,image_url,object_story_spec}"
  );
}

/**
 * Spend and delivery, for whatever level you ask for.
 *
 * @param {string} level  "campaign" | "adset" | "ad"
 * @param {object} range  { since: "YYYY-MM-DD", until: "YYYY-MM-DD" }
 */
export async function insights(level, range) {
  const { adAccountId } = credentials();
  const fields = [
    "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
    "spend", "impressions", "clicks", "reach", "frequency", "ctr", "cpc", "cpm",
  ].join(",");
  const timeRange = encodeURIComponent(JSON.stringify({ since: range.since, until: range.until }));
  return graphAll(
    `/${adAccountId}/insights?level=${level}&time_range=${timeRange}&fields=${fields}&limit=200`
  );
}

/**
 * A rendered preview of the ad — Meta returns an iframe, which is as close to
 * a screenshot as the API offers without running a browser.
 */
export async function adPreview(adId, format = "MOBILE_FEED_STANDARD") {
  const result = await graph(`/${adId}/previews?ad_format=${format}`);
  const body = result.data?.[0]?.body || "";
  const src = /src="([^"]+)"/.exec(body)?.[1] || null;
  // Meta HTML-encodes the URL inside the iframe attribute.
  return src ? src.replace(/&amp;/g, "&") : null;
}

/**
 * Downloads a creative image to disk. Returns the local filename, or null if
 * it could not be fetched — a missing image should never fail a whole report.
 */
export async function downloadCreative(url, directory, basename) {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const type = response.headers.get("content-type") || "";
    const extension = type.includes("png") ? ".png" : type.includes("gif") ? ".gif" : ".jpg";
    const filename = `${basename}${extension}`;

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, filename), Buffer.from(await response.arrayBuffer()));
    return filename;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Matching ads to a show
// ---------------------------------------------------------------------------

/**
 * Works out which ad sets belong to a show, and says how it decided. Three
 * ways, strongest first — the method is reported so nobody has to trust a
 * match they cannot see the reason for.
 *
 * @param {object} show
 * @param {Array}  audiences   the show's audiences from our registry
 * @param {Array}  adSets      from listAdSets()
 */
export function matchAdSets(show, audiences, adSets) {
  const matches = [];

  // The names HubSpot will have given our lists once its ads sync ran.
  const syncedNames = new Set(
    audiences
      .filter((a) => a.type !== "geo" && a.hubspotListName)
      .map((a) => (HUBSPOT_AUDIENCE_PREFIX + a.hubspotListName).toLowerCase())
  );

  // Anything explicitly recorded against an audience wins outright.
  const recordedIds = new Set(
    audiences
      .flatMap((a) => a.destinations || [])
      .filter((d) => d.platform === "meta" && d.externalId)
      .map((d) => String(d.externalId))
  );

  const showWords = [show.id, show.name].map((s) => String(s).toLowerCase());
  const venueCity = (show.city || "").split(",")[0].trim().toLowerCase();

  for (const adSet of adSets) {
    let via = null;
    let detail = "";

    // The tag in the name is the intended way — see src/metaNaming.js.
    const tag = parseTag(adSet.name) || parseTag(adSet.campaign?.name);
    if (tag && tag.showId === show.id) {
      via = "tag";
      detail = tag.campaignType
        ? `tagged for this show, as the ${tag.campaignType} campaign`
        : "tagged for this show";
      matches.push({ adSet, via, detail, campaignType: tag.campaignType });
      continue;
    }

    // A tag for a DIFFERENT show is a definite no, whatever else matches.
    if (tag && tag.showId !== show.id) continue;

    if (recordedIds.has(adSet.id) || recordedIds.has(adSet.campaign?.id)) {
      via = "recorded";
      detail = "the Meta id recorded against this audience";
    }

    if (!via) {
      const used = adSet.targeting?.custom_audiences || [];
      const hit = used.find((audience) => syncedNames.has(String(audience.name).toLowerCase()));
      if (hit) {
        via = "audience";
        detail = `targets "${hit.name}"`;
      }
    }

    if (!via) {
      const haystack = `${adSet.name} ${adSet.campaign?.name || ""}`.toLowerCase();
      if (showWords.some((word) => word && haystack.includes(word))) {
        via = "name";
        detail = "the ad set or campaign name mentions this show";
      }
    }

    // A geo campaign will not reference an audience at all, so fall back to
    // the venue city. Weakest signal — flagged as needing a human look.
    if (!via && venueCity && show.venue) {
      const cities = adSet.targeting?.geo_locations?.cities || [];
      if (cities.some((city) => String(city.name).toLowerCase() === venueCity)) {
        via = "geo";
        detail = `targets ${venueCity}, where this show is — confirm this is the show campaign`;
      }
    }

    if (via) matches.push({ adSet, via, detail, campaignType: null });
  }

  return matches;
}
