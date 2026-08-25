// ingest.js — a CSV goes in, contacts come out, and the run is logged.
//
// The flow, in order:
//   read file -> map columns -> normalize -> group duplicates -> merge
//   -> preview (stop here unless --commit) -> upsert to HubSpot -> log it
//
// Nothing is written to HubSpot unless `commit` is true. That is deliberate:
// the default should always be safe.
//
// EDIT THIS FILE IF: you need a new source type, or the shape of what gets
// written to HubSpot changes. Column mapping lives in data/mappings.json, so
// a new organizer format usually needs no code change at all.

import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import * as hubspot from "./hubspot.js";
import { normalizeRow } from "./normalize.js";
import { groupContacts, mergeGroup } from "./merge.js";
import { PATHS } from "./config.js";
import { ACTIONS, record, loadShows } from "./registry.js";

/** Where a contact came from. Recorded on every contact, always. */
export const SOURCES = ["booth_tablet", "badge_scan", "roster_pre", "roster_post", "referral"];

/**
 * How we guess which spreadsheet column is which. First match wins, checked
 * against the lowercased header. Add to these lists rather than writing new
 * code when an organizer uses a name we have not seen.
 */
export const COLUMN_GUESSES = {
  email: ["email", "email address", "e-mail", "emailaddress", "attendee email"],
  firstName: ["first name", "firstname", "first", "given name", "fname"],
  lastName: ["last name", "lastname", "last", "surname", "family name", "lname"],
  phone: ["phone", "phone number", "mobile", "cell", "telephone", "tel"],
  company: ["company", "company name", "organization", "organisation", "business", "shop name", "auto_shop_name"],
  jobTitle: ["title", "job title", "jobtitle", "position", "role"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  country: ["country"],
  website: ["website", "url", "web", "domain"],
};

/** Reads a CSV into { headers, rows }. Handles a UTF-8 BOM and quoted fields. */
export function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

/**
 * Works out which column is which.
 *
 * @param {string[]} headers
 * @param {object} saved  a mapping the user confirmed before, from mappings.json
 * @returns {object} our field name -> the CSV header to read it from
 */
export function guessMapping(headers, saved = {}) {
  const mapping = { ...saved };
  const lowered = headers.map((header) => ({ header, key: header.toLowerCase().trim() }));

  for (const [field, candidates] of Object.entries(COLUMN_GUESSES)) {
    if (mapping[field]) continue;
    const hit = lowered.find((column) => candidates.includes(column.key));
    if (hit) mapping[field] = hit.header;
  }
  return mapping;
}

/** Loads saved per-organizer column mappings. Keyed by a name you choose. */
export function loadMappings() {
  const file = path.join(PATHS.data, "mappings.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveMapping(profileName, mapping) {
  const file = path.join(PATHS.data, "mappings.json");
  const all = loadMappings();
  all[profileName] = mapping;
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n", "utf8");
  return all;
}

/**
 * The stable key we upsert against.
 *
 * Email is deliberately NOT the id property: HubSpot does not support partial
 * upserts when email is the idProperty, so sending a subset of fields would
 * blank the rest. A key we control avoids that and makes a re-run of the same
 * file a no-op instead of a duplicate storm.
 */
export function dedupeKey(contact) {
  const basis = contact.email || contact.phone;
  return `tsf:${basis}`;
}

/**
 * Runs a file through the whole pipeline.
 *
 * @param {object} options
 * @param {string} options.file      path to the CSV
 * @param {string} options.showId    which show this belongs to
 * @param {string} options.source    one of SOURCES
 * @param {object} options.mapping   column mapping; guessed if omitted
 * @param {boolean} options.commit   false (default) previews, true writes
 * @param {string} options.consentTextId  which consent wording applies
 */
export async function ingestFile({
  file,
  showId,
  source,
  mapping: providedMapping,
  commit = false,
  consentTextId = "",
}) {
  if (!SOURCES.includes(source)) {
    throw new Error(`Unknown source "${source}". Use one of: ${SOURCES.join(", ")}`);
  }
  const shows = loadShows();
  if (!shows.some((show) => show.id === showId)) {
    throw new Error(`Unknown show "${showId}". Add it first: tsf show add`);
  }

  const { headers, rows } = readCsv(file);
  const mapping = providedMapping || guessMapping(headers);

  if (!mapping.email && !mapping.phone) {
    throw new Error(
      `Could not find an email or phone column in ${path.basename(file)}.\n` +
        `Headers were: ${headers.join(", ")}\n` +
        `Map them by hand with --mapping, or add the header to COLUMN_GUESSES in src/ingest.js.`
    );
  }

  // ---- normalize -----------------------------------------------------------
  const normalized = [];
  const rejects = [];
  const batchId = `${showId}-${source}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const nowIso = new Date().toISOString();

  rows.forEach((row, index) => {
    const mapped = {};
    for (const [field, header] of Object.entries(mapping)) {
      if (header && row[header] !== undefined) mapped[field] = row[header];
    }

    const result = normalizeRow(mapped);
    if (!result.ok) {
      rejects.push({ rowNumber: index + 2, reason: result.reason, raw: row });
      return;
    }

    // Stamp provenance on every single row, whether or not we route on it.
    normalized.push({
      ...result.contact,
      ts_sources: source,
      ts_events_attended: showId,
      ts_first_event: showId,
      ts_first_source: source,
      ts_import_batch: batchId,
      ...(source === "booth_tablet" || source === "badge_scan"
        ? { ts_consent_status: "express_optin", ts_consent_at: nowIso, ts_consent_text_id: consentTextId }
        : { ts_consent_status: "registration_optin", ts_consent_text_id: consentTextId }),
    });
  });

  // ---- group and merge -----------------------------------------------------
  const { groups, review } = groupContacts(normalized);

  // What does HubSpot already have for these people?
  const keys = groups.map((group) => dedupeKey(group.contacts[0]));
  let existingByKey = new Map();

  if (commit || keys.length) {
    try {
      const existing = await hubspot.readContactsByProperty(
        keys,
        "ts_dedupe_key",
        ["email", "phone", "firstname", "lastname", "company",
         "ts_sources", "ts_events_attended", "ts_interest",
         "ts_consent_at", "ts_consent_status", "ts_first_event"]
      );
      existingByKey = new Map(
        existing.map((contact) => [contact.properties?.ts_dedupe_key, contact.properties])
      );
    } catch (error) {
      // A missing property on a fresh portal is expected before setup runs.
      if (!/ts_dedupe_key/i.test(error.message)) throw error;
    }
  }

  const toWrite = groups.map((group) => {
    const key = dedupeKey(group.contacts[0]);
    const merged = mergeGroup(group.contacts, existingByKey.get(key));
    return {
      id: key,
      isNew: !existingByKey.has(key),
      mergedFrom: group.contacts.length,
      matchedBy: group.matchedBy,
      properties: toHubspotProperties(merged, key),
    };
  });

  const summary = {
    file: path.basename(file),
    showId,
    source,
    batchId,
    rowsRead: rows.length,
    rejected: rejects.length,
    needsReview: review.length,
    contacts: toWrite.length,
    created: toWrite.filter((record_) => record_.isNew).length,
    updated: toWrite.filter((record_) => !record_.isNew).length,
    mergedWithinFile: toWrite.reduce((total, r) => total + (r.mergedFrom - 1), 0),
    committed: false,
  };

  if (!commit) {
    return { summary, toWrite, rejects, review, mapping };
  }

  // ---- write ---------------------------------------------------------------
  await hubspot.upsertContacts(toWrite.map(({ id, properties }) => ({ id, properties })));
  summary.committed = true;

  record(ACTIONS.IMPORT_COMMITTED, { ...summary });

  return { summary, toWrite, rejects, review, mapping };
}

/** Maps our internal field names onto the HubSpot property names. */
function toHubspotProperties(merged, key) {
  const properties = {
    ts_dedupe_key: key,
    email: merged.email || undefined,
    phone: merged.phone || undefined,
    firstname: merged.firstName || undefined,
    lastname: merged.lastName || undefined,
    company: merged.company || undefined,
    jobtitle: merged.jobTitle || undefined,
    city: merged.city || undefined,
    state: merged.state || undefined,
    country: merged.country || undefined,
    ts_sources: merged.ts_sources || undefined,
    ts_events_attended: merged.ts_events_attended || undefined,
    ts_first_event: merged.ts_first_event || undefined,
    ts_first_source: merged.ts_first_source || undefined,
    ts_consent_status: merged.ts_consent_status || undefined,
    ts_consent_at: merged.ts_consent_at || undefined,
    ts_consent_text_id: merged.ts_consent_text_id || undefined,
    ts_import_batch: merged.ts_import_batch || undefined,
  };
  // HubSpot rejects undefined values, so drop them.
  for (const field of Object.keys(properties)) {
    if (properties[field] === undefined) delete properties[field];
  }
  return properties;
}

/** Writes the rejected rows next to the input file so they can be fixed. */
export function writeRejects(inputFile, rejects) {
  if (!rejects.length) return null;
  const out = inputFile.replace(/\.csv$/i, "") + ".rejects.csv";
  const headers = Object.keys(rejects[0].raw || {});
  const lines = [
    ["row_number", "reason", ...headers].join(","),
    ...rejects.map((reject) =>
      [reject.rowNumber, quote(reject.reason), ...headers.map((h) => quote(reject.raw?.[h] ?? ""))].join(",")
    ),
  ];
  fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
  return out;
}

function quote(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
