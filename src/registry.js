// registry.js — the memory of this system.
//
// This is the most important file in the repo. Everything else feeds it.
//
// Two stores, both plain files so a person (or Claude) can read them without
// running anything:
//
//   data/audiences/<id>.json   Current state of one audience. Overwritten on
//                              change, but it carries its own sizeHistory so
//                              you can still see how it grew.
//
//   data/history/YYYY-MM.jsonl Append-only log, one JSON object per line.
//                              NOTHING is ever edited or deleted here. If you
//                              need to correct a record, append a correction.
//
// Why append-only: the whole point of this project is being able to ask "what
// audience did we build for AAPEX, how big was it, and where did it go" nine
// months later. A store you can overwrite cannot answer that.
//
// EDIT THIS FILE IF: you need a new kind of history event, or a new field on
// an audience record. Add to ACTIONS below and keep the shape backwards
// compatible — old lines in the log must stay readable.

import fs from "node:fs";
import path from "node:path";
import { PATHS, ensureDataDirs, loadConfig } from "./config.js";

/**
 * Every kind of thing that can happen. Keep this list closed — if you find
 * yourself wanting a free-text action, you probably want a new named one here
 * so it can be counted and filtered later.
 */
export const ACTIONS = {
  SHOW_CREATED: "show.created",
  SHOW_RESEARCHED: "show.researched",
  IMPORT_COMMITTED: "import.committed",
  TABLET_CLAIMED: "tablet.claimed",
  AUDIENCE_CREATED: "audience.created",
  AUDIENCE_REFRESHED: "audience.refreshed",
  AUDIENCE_MEMBERS_ADDED: "audience.members_added",
  AUDIENCE_EDITED: "audience.edited",
  AUDIENCE_RETIRED: "audience.retired",
  AUDIENCE_DESTINATION_SET: "audience.destination_set",
  REPORT_EXPORTED: "report.exported",
  NOTE: "note",
};

/** Turns "SEMA 2026 — Booth" into "sema-2026-booth". Used for filenames and ids. */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// History log
// ---------------------------------------------------------------------------

function historyFileFor(isoTimestamp) {
  return path.join(PATHS.history, `${isoTimestamp.slice(0, 7)}.jsonl`);
}

/**
 * Appends one event to the log. Call this for anything a person would want to
 * find later. It is cheap, and an over-full log is far better than a gap.
 *
 * @param {string} action    one of ACTIONS
 * @param {object} details   anything useful; keep it JSON-serialisable
 */
export function record(action, details = {}) {
  ensureDataDirs();
  const at = new Date().toISOString();
  const { actor } = loadConfig();

  const entry = { at, actor, action, ...details };
  fs.appendFileSync(historyFileFor(at), JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/**
 * Reads history back, newest first.
 *
 * @param {object} options
 * @param {string} [options.action]      only this action
 * @param {string} [options.audienceId]  only events about this audience
 * @param {string} [options.since]       ISO date; only events on or after it
 * @param {number} [options.limit]       cap the number returned
 */
export function readHistory({ action, audienceId, brand, since, limit = Infinity } = {}) {
  ensureDataDirs();
  const files = fs
    .readdirSync(PATHS.history)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse(); // newest month first

  const out = [];
  for (const file of files) {
    const lines = fs
      .readFileSync(path.join(PATHS.history, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .reverse(); // newest line first

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a corrupt line should never stop a report
      }
      if (action && entry.action !== action) continue;
      if (audienceId && entry.audienceId !== audienceId) continue;
      // Entries with no brand (a show being added, a venue researched) are
      // portfolio-level and stay visible whichever brand you are looking at.
      if (brand && entry.brand && entry.brand !== brand) continue;
      if (since && entry.at < since) continue;
      out.push(entry);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audience records
// ---------------------------------------------------------------------------

/**
 * The shape of an audience. Written here as a function rather than a schema
 * library so the fields are obvious at a glance.
 */
export function newAudience({
  id,
  name,
  brand,
  type = "list",
  purpose = "",
  shows = [],
  sources = [],
  definition = {},
  hubspotListId = null,
}) {
  const at = new Date().toISOString();
  const { actor } = loadConfig();
  return {
    id,
    name,

    // Which business this audience belongs to. Required — R1 and DFC keep
    // separate audiences and must never be mixed. See src/brands.js.
    brand,

    // "list" — people we hold contact details for, synced as a customer list.
    // "geo"  — a place and a time window. No PII, no size floor, and it works
    //          before you have collected anyone. See src/geo.js.
    type,

    purpose,           // plain English: why this audience exists
    status: "active",  // active | retired
    createdAt: at,
    createdBy: actor,
    updatedAt: at,

    shows,             // which trade shows feed it, e.g. ["sema-2026"]
    sources,           // ["booth_tablet", "roster_pre", "roster_post", ...]
    definition,        // the rule used to build it, kept verbatim

    hubspotListId,     // the list on the HubSpot side, if one exists

    // Where this audience is meant to end up. Ben fills the ad platforms in on
    // his side and someone else owns email — we track intent and status here so
    // there is one place that knows the whole picture.
    destinations: [],  // [{ platform, status, externalId, notes, updatedAt }]

    // Every size measurement we have ever taken, oldest first. This is what
    // makes "was this audience bigger last quarter" answerable.
    sizeHistory: [],   // [{ at, size, note }]

    notes: [],         // [{ at, actor, text }]
  };
}

function audienceFile(id) {
  return path.join(PATHS.audiences, `${id}.json`);
}

export function audienceExists(id) {
  return fs.existsSync(audienceFile(id));
}

export function saveAudience(audience) {
  ensureDataDirs();
  audience.updatedAt = new Date().toISOString();
  fs.writeFileSync(audienceFile(audience.id), JSON.stringify(audience, null, 2) + "\n", "utf8");
  return audience;
}

export function loadAudience(id) {
  const file = audienceFile(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function listAudiences({ includeRetired = true, brand = null } = {}) {
  ensureDataDirs();
  return fs
    .readdirSync(PATHS.audiences)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(PATHS.audiences, name), "utf8")))
    .filter((audience) => includeRetired || audience.status === "active")
    .filter((audience) => !brand || audience.brand === brand)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Adds a size measurement and logs it. The one place size ever changes. */
export function recordSize(audience, size, note = "") {
  const previous = audience.sizeHistory.at(-1)?.size ?? null;
  audience.sizeHistory.push({ at: new Date().toISOString(), size, note });
  saveAudience(audience);
  record(ACTIONS.AUDIENCE_REFRESHED, {
    audienceId: audience.id,
    audienceName: audience.name,
    brand: audience.brand,
    size,
    previousSize: previous,
    delta: previous === null ? null : size - previous,
    note,
  });
  return audience;
}

/** Records where an audience is being used. status: planned | live | paused | removed */
export function setDestination(audience, { platform, status, externalId = null, notes = "" }) {
  const at = new Date().toISOString();
  const existing = audience.destinations.find((d) => d.platform === platform);

  if (existing) {
    Object.assign(existing, { status, externalId, notes, updatedAt: at });
  } else {
    audience.destinations.push({ platform, status, externalId, notes, updatedAt: at });
  }

  saveAudience(audience);
  record(ACTIONS.AUDIENCE_DESTINATION_SET, {
    audienceId: audience.id,
    audienceName: audience.name,
    brand: audience.brand,
    platform,
    status,
    externalId,
    notes,
  });
  return audience;
}

export function addNote(audience, text) {
  const { actor } = loadConfig();
  audience.notes.push({ at: new Date().toISOString(), actor, text });
  saveAudience(audience);
  record(ACTIONS.NOTE, { audienceId: audience.id, audienceName: audience.name, brand: audience.brand, text });
  return audience;
}

export function retireAudience(audience, reason = "") {
  audience.status = "retired";
  audience.retiredAt = new Date().toISOString();
  saveAudience(audience);
  record(ACTIONS.AUDIENCE_RETIRED, {
    audienceId: audience.id,
    audienceName: audience.name,
    brand: audience.brand,
    reason,
    finalSize: audience.sizeHistory.at(-1)?.size ?? null,
  });
  return audience;
}

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------

export function loadShows() {
  if (!fs.existsSync(PATHS.shows)) return [];
  return JSON.parse(fs.readFileSync(PATHS.shows, "utf8"));
}

export function saveShows(shows) {
  ensureDataDirs();
  fs.writeFileSync(PATHS.shows, JSON.stringify(shows, null, 2) + "\n", "utf8");
}

export function addShow({ id, name, startDate, endDate, city = "", notes = "", brands = [] }) {
  const shows = loadShows();
  if (shows.some((show) => show.id === id)) {
    throw new Error(`Show "${id}" already exists.`);
  }
  const show = {
    id,
    name,
    startDate,
    endDate,
    city,
    notes,
    // Which brands exhibit at this show. A show can serve one or both — SEMA
    // might carry both booths, a police expo only DFC.
    brands,
    // Where the show physically happens. Filled in by `tsf show research`.
    // Needed for geo targeting — see src/geo.js for why that matters more
    // than it sounds.
    venue: null, // { name, lat, lng, displayName, researchedAt }
    // Which HubSpot form IDs belong to this show. Filled in by
    // `tsf discover forms` or by hand — this is how a tablet submission gets
    // tied back to a show when the form is a per-event clone.
    formIds: [],
    createdAt: new Date().toISOString(),
  };
  shows.push(show);
  saveShows(shows);
  record(ACTIONS.SHOW_CREATED, { showId: id, showName: name, startDate, endDate, brands });
  return show;
}

/** Stores the venue we looked up, so a geo audience can be built from it. */
export function setShowVenue(showId, venue) {
  const shows = loadShows();
  const show = shows.find((entry) => entry.id === showId);
  if (!show) throw new Error(`No show "${showId}".`);

  show.venue = { ...venue, researchedAt: new Date().toISOString() };
  saveShows(shows);
  record(ACTIONS.SHOW_RESEARCHED, {
    showId,
    showName: show.name,
    venue: show.venue.name,
    lat: show.venue.lat,
    lng: show.venue.lng,
  });
  return show;
}
