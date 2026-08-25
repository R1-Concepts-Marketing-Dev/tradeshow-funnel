// audiences.js — building an audience and keeping its record honest.
//
// An "audience" here is two things kept in step:
//   1. a list on the HubSpot side, which is what actually syncs to ad platforms
//   2. a JSON record in data/audiences/, which is what we can still read in a
//      year when nobody remembers why the list exists
//
// Never create a list in the HubSpot UI for this program. If it is not in the
// registry, nothing downstream knows about it, and that is how a portal ends
// up with 401 lists nobody can account for.
//
// EDIT THIS FILE IF: you want a new kind of audience rule, or you want to sync
// somewhere HubSpot cannot reach natively.

import * as hubspot from "./hubspot.js";
import { buildGeoSpec } from "./geo.js";
import { requireBrand } from "./brands.js";
import {
  ACTIONS,
  loadAudience,
  listAudiences,
  newAudience,
  record,
  recordSize,
  saveAudience,
  slugify,
  audienceExists,
} from "./registry.js";

/**
 * Platform floors, so the tool can tell you an audience is too small BEFORE
 * you go looking for why it will not deliver. These are matched-user counts,
 * not row counts — expect to match 40–60% on email alone, 60–75% with phone.
 *
 * Sources are in docs/DECISIONS.md.
 */
export const PLATFORM_FLOORS = {
  "google-ads": { min: 100, recommended: 5000, unit: "members" },
  meta: { min: 1000, recommended: 1000, unit: "matched users" },
  tiktok: { min: 1000, recommended: 1000, unit: "rows and matched users" },
  linkedin: { min: 300, recommended: 1000, unit: "matched members" },
  "hubspot-email": { min: 1, recommended: 1, unit: "contacts" },
};

/** Rough share of a list that ad platforms will actually match to a user. */
export const ASSUMED_MATCH_RATE = { emailOnly: 0.5, withPhone: 0.68 };

/**
 * Builds the HubSpot list filter for an audience defined by shows and sources.
 *
 * This is the only place that knows the shape of a HubSpot filter branch. If
 * you want a rule this cannot express, write the filterBranch by hand and pass
 * it in as `definition.filterBranch` instead of extending this.
 */
export function buildFilterBranch({ shows = [], sources = [], brand = null }) {
  const filters = [];

  // Brand first — this is the filter that keeps R1 and DFC audiences apart.
  if (brand) {
    filters.push({
      filterType: "PROPERTY",
      property: "ts_brand",
      operation: {
        operationType: "ENUMERATION",
        operator: "IS_ANY_OF",
        values: [brand],
        includeObjectsWithNoValueSet: false,
      },
    });
  }

  if (shows.length) {
    filters.push({
      filterType: "PROPERTY",
      property: "ts_events_attended",
      operation: {
        operationType: "MULTISTRING",
        operator: "IS_ANY_OF",
        values: shows,
        includeObjectsWithNoValueSet: false,
      },
    });
  }

  if (sources.length) {
    filters.push({
      filterType: "PROPERTY",
      property: "ts_sources",
      operation: {
        operationType: "MULTISTRING",
        operator: "IS_ANY_OF",
        values: sources,
        includeObjectsWithNoValueSet: false,
      },
    });
  }

  return {
    filterBranchType: "AND",
    filterBranchOperator: "AND",
    filters,
    filterBranches: [],
  };
}

/**
 * Creates an audience: the HubSpot list plus the registry record.
 *
 * @param {object} options
 * @param {string} options.name        human name, e.g. "SEMA 2026 — Booth + Roster"
 * @param {string} options.purpose     why it exists, in plain English
 * @param {string[]} options.shows     show ids that feed it
 * @param {string[]} options.sources   source values that feed it
 * @param {boolean} options.dryRun     if true, nothing is created
 */
export async function createAudience({
  brand: brandInput,
  name,
  purpose = "",
  shows = [],
  sources = [],
  dryRun = false,
}) {
  const brand = requireBrand(brandInput);

  // The id is brand-prefixed because both brands attend the same shows —
  // without this, "SEMA 2026 — Contacts" would collide between R1 and DFC.
  const id = `${brand.id}-${slugify(name)}`;

  // The HubSpot list name is prefixed too, so it is identifiable among the
  // hundreds of lists already in the portal.
  const listName = `${brand.shortName} · ${name}`;

  if (audienceExists(id)) {
    throw new Error(
      `Audience "${id}" already exists. Use a different name, or edit data/audiences/${id}.json.`
    );
  }

  const filterBranch = buildFilterBranch({ shows, sources, brand: brand.id });
  const definition = { brand: brand.id, shows, sources, filterBranch };

  if (dryRun) {
    return { dryRun: true, id, name, listName, brand: brand.id, definition };
  }

  // DYNAMIC means HubSpot keeps membership up to date as contacts change,
  // which is what we want — a static snapshot goes stale the moment the next
  // roster lands.
  const list = await hubspot.createList({
    name: listName,
    processingType: "DYNAMIC",
    filterBranch,
  });

  const audience = newAudience({
    id,
    name,
    brand: brand.id,
    purpose,
    shows,
    sources,
    definition,
    hubspotListId: list.listId ?? list.id ?? null,
  });

  saveAudience(audience);
  record(ACTIONS.AUDIENCE_CREATED, {
    audienceId: id,
    audienceName: name,
    brand: brand.id,
    type: "list",
    purpose,
    shows,
    sources,
    hubspotListId: audience.hubspotListId,
  });

  // A brand new dynamic list reports size 0 until HubSpot finishes evaluating
  // it, so take a first measurement now and expect `refresh` to correct it.
  await refreshAudience(id, "created");

  return loadAudience(id);
}

/**
 * Creates a geo audience: a place and a time window rather than a list of
 * people. Nothing is created in HubSpot — there is no list to create — but it
 * is registered and logged exactly like a contact audience, so `tsf audience
 * list` and AUDIENCES.md show the whole picture of what is running.
 *
 * Reach for this when the contact list for a show is below the platform floors,
 * or before the show when you have not collected anyone yet.
 *
 * @param {object} options
 * @param {object} options.show      a show record with venue coordinates
 * @param {number} options.leadDays  days to start before the show opens
 * @param {number} options.lagDays   days to keep running after it closes
 * @param {boolean} options.dryRun
 */
export async function createGeoAudience({
  brand: brandInput,
  show,
  name,
  purpose = "",
  leadDays,
  lagDays,
  rings,
  dryRun = false,
}) {
  const brand = requireBrand(brandInput);
  const spec = buildGeoSpec(show, { leadDays, lagDays, rings });
  const audienceName = name || `${show.name} — Geo`;
  const id = `${brand.id}-${slugify(audienceName)}`;

  if (audienceExists(id)) {
    throw new Error(`Audience "${id}" already exists.`);
  }

  if (dryRun) return { dryRun: true, id, name: audienceName, brand: brand.id, spec };

  const audience = newAudience({
    id,
    name: audienceName,
    brand: brand.id,
    type: "geo",
    purpose: purpose || `Reach everyone at ${show.name} during the show window.`,
    shows: [show.id],
    sources: [],
    definition: { brand: brand.id, geo: spec },
    hubspotListId: null,
  });

  saveAudience(audience);
  record(ACTIONS.AUDIENCE_CREATED, {
    audienceId: id,
    audienceName,
    brand: brand.id,
    type: "geo",
    purpose: audience.purpose,
    shows: [show.id],
    venue: spec.venue.name,
    runStart: spec.window.runStart,
    runEnd: spec.window.runEnd,
  });

  return loadAudience(id);
}

/**
 * Re-reads the list size from HubSpot and appends it to the audience's history.
 * Run this after every import, and before anyone asks how big something is.
 */
export async function refreshAudience(id, note = "") {
  const audience = loadAudience(id);
  if (!audience) throw new Error(`No audience "${id}".`);
  if (!audience.hubspotListId) {
    throw new Error(`Audience "${id}" has no HubSpot list to read.`);
  }

  const list = await hubspot.getList(audience.hubspotListId);
  const size = Number(
    list?.additionalProperties?.hs_list_size ?? list?.size ?? 0
  );

  recordSize(audience, size, note);
  return loadAudience(id);
}

/** Refreshes every active audience. Cheap, and keeps the report trustworthy. */
export async function refreshAll(note = "bulk refresh", { brand = null } = {}) {
  const results = [];
  for (const audience of listAudiences({ includeRetired: false, brand })) {
    // Geo audiences have no list to measure — their "size" is a place, not a count.
    if (audience.type === "geo" || !audience.hubspotListId) continue;
    try {
      results.push(await refreshAudience(audience.id, note));
    } catch (error) {
      results.push({ id: audience.id, error: error.message });
    }
  }
  return results;
}

/**
 * Checks an audience against the floors of the platforms it is headed for.
 * Returns plain-language findings rather than throwing — the point is to warn
 * before someone wonders why a campaign will not spend.
 */
export function checkReadiness(audience, { hasPhone = false } = {}) {
  const size = audience.sizeHistory.at(-1)?.size ?? 0;
  const rate = hasPhone ? ASSUMED_MATCH_RATE.withPhone : ASSUMED_MATCH_RATE.emailOnly;
  const estimatedMatched = Math.round(size * rate);

  const findings = [];
  const platforms = audience.destinations.length
    ? audience.destinations.map((destination) => destination.platform)
    : Object.keys(PLATFORM_FLOORS);

  for (const platform of platforms) {
    const floor = PLATFORM_FLOORS[platform];
    if (!floor) continue;

    // HubSpot email has no matching step — the whole list is reachable.
    const effective = platform === "hubspot-email" ? size : estimatedMatched;

    if (effective < floor.min) {
      findings.push({
        platform,
        level: "blocked",
        message:
          `~${effective} ${floor.unit} — below the ${floor.min} minimum. Will not deliver. ` +
          `Use a geo audience for this show instead: tsf audience create --type geo --show ${audience.shows[0] || "<show>"}`,
      });
    } else if (effective < floor.recommended) {
      findings.push({
        platform,
        level: "thin",
        message: `~${effective} ${floor.unit} — clears the ${floor.min} minimum but under the ${floor.recommended} recommended. Expect limited reach.`,
      });
    } else {
      findings.push({
        platform,
        level: "ok",
        message: `~${effective} ${floor.unit} — clears the floor.`,
      });
    }
  }

  return { size, estimatedMatched, matchRateUsed: rate, findings };
}
