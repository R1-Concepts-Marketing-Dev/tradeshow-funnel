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
import { readTable, readTableFile } from "./readfile.js";
import * as hubspot from "./hubspot.js";
import { normalizeRow } from "./normalize.js";
import { groupContacts, mergeGroup } from "./merge.js";
import { PATHS } from "./config.js";
import { ACTIONS, record, loadShows } from "./registry.js";
import { requireBrand } from "./brands.js";

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

// Reading files is its own problem — organizer exports are .xlsx with junk
// rows above the header and four sheets. See src/readfile.js.
export { readTable, readTableFile };

/**
 * Distinctive words to look for when no header matches exactly. Organizers
 * write "Badge Email", "Registrant Email", "Work Email" — all obviously the
 * email column, none of them an exact match for anything.
 */
export const CORE_KEYWORDS = {
  email: ["email", "e-mail"],
  firstName: ["first", "given", "fname", "forename"],
  lastName: ["last", "surname", "family", "lname"],
  phone: ["phone", "mobile", "cell", "telephone"],
  company: ["company", "organization", "organisation", "business", "shop", "employer", "firm"],
  jobTitle: ["job title", "jobtitle", "position", "role"],
  city: ["city", "town"],
  state: ["state", "province"],
  country: ["country"],
  website: ["website", "domain"],
};

/**
 * Headers that contain a keyword but are definitely not the field. "Email
 * Opt Out" is not an email column, and mapping it would be worse than
 * mapping nothing.
 */
const NEVER_MATCH = /opt.?out|opt.?in|consent|unsubscribe|subscrib|verified|is.?valid|preference|bounce|invalid/i;

/**
 * Works out which column is which.
 *
 * Two passes. Exact matches first, because they are certain. Then a keyword
 * pass for the many real headers that are obviously right but not on any list.
 * Skipping the second pass is how a file imports with no email addresses in it
 * and nobody notices until the audience is empty.
 *
 * @param {string[]} headers
 * @param {object} saved  a mapping the user confirmed before, from mappings.json
 * @returns {object} our field name -> the header to read it from
 */
export function guessMapping(headers, saved = {}) {
  const mapping = { ...saved };
  const lowered = headers.map((header) => ({ header, key: header.toLowerCase().trim() }));
  const taken = new Set(Object.values(mapping));

  // Pass 1 — exact.
  for (const [field, candidates] of Object.entries(COLUMN_GUESSES)) {
    if (mapping[field]) continue;
    const hit = lowered.find((column) => candidates.includes(column.key) && !taken.has(column.header));
    if (hit) {
      mapping[field] = hit.header;
      taken.add(hit.header);
    }
  }

  // Pass 2 — contains a distinctive word. Shortest header wins, on the theory
  // that "Email" beats "Email Address Confirmed" for being the real one.
  for (const [field, keywords] of Object.entries(CORE_KEYWORDS)) {
    if (mapping[field]) continue;
    const hits = lowered
      .filter(
        (column) =>
          !taken.has(column.header) &&
          !NEVER_MATCH.test(column.key) &&
          keywords.some((word) => column.key.includes(word))
      )
      .sort((a, b) => a.key.length - b.key.length);

    if (hits.length) {
      mapping[field] = hits[0].header;
      taken.add(hits[0].header);
    }
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
export function dedupeKey(contact, brandId) {
  const basis = contact.email || contact.phone;
  // Brand-scoped on purpose. The same person can legitimately be an R1 contact
  // and a DFC contact, and collapsing them would merge two brands' consent and
  // engagement history into one record.
  return `tsf:${brandId}:${basis}`;
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
  data,
  filename,
  brand: brandInput,
  showId,
  source,
  mapping: providedMapping,
  commit = false,
  consentTextId = "",
}) {
  // Brand is required, and there is no default. An unbranded import is the one
  // way R1 contacts could end up in a DFC audience.
  const brand = requireBrand(brandInput);

  if (!SOURCES.includes(source)) {
    throw new Error(`Unknown source "${source}". Use one of: ${SOURCES.join(", ")}`);
  }
  const shows = loadShows();
  if (!shows.some((show) => show.id === showId)) {
    throw new Error(`Unknown show "${showId}". Add it first: tsf show add`);
  }

  // The CLI passes a path; the web UI passes the bytes, because a spreadsheet
  // is binary and the browser has already read it.
  const displayName = filename || (file ? path.basename(file) : "upload.csv");
  const table = data !== undefined ? readTable(data, displayName) : readTableFile(file);
  const { headers, rows } = table;
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
  const batchId = `${brand.id}-${showId}-${source}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
      ts_brand: brand.id,
      ts_import_batch: batchId,
      ...(source === "booth_tablet" || source === "badge_scan"
        ? { ts_consent_status: "express_optin", ts_consent_at: nowIso, ts_consent_text_id: consentTextId }
        : { ts_consent_status: "registration_optin", ts_consent_text_id: consentTextId }),
    });
  });

  // ---- group and merge -----------------------------------------------------
  const { groups, review } = groupContacts(normalized);

  // What does HubSpot already have for these people?
  const keys = groups.map((group) => dedupeKey(group.contacts[0], brand.id));
  let existingByKey = new Map();

  if (commit || keys.length) {
    try {
      const existing = await hubspot.readContactsByProperty(
        keys,
        "ts_dedupe_key",
        ["email", "phone", "firstname", "lastname", "company",
         "ts_brand", "ts_sources", "ts_events_attended", "ts_interest",
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
    const key = dedupeKey(group.contacts[0], brand.id);
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
    file: displayName,
    sheetName: table.sheetName,
    readNotes: table.notes,
    brand: brand.id,
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
    ts_brand: merged.ts_brand || undefined,
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
