// tablet.js — claiming booth tablet sign-ups for a show.
//
// The problem this solves: the tablet form in HubSpot has no show field. It
// gets cloned per event, so a submission carries no record of which show it
// came from. See docs/DECISIONS.md.
//
// The fix: a show has dates, and a tablet form has submission timestamps. Take
// the submissions to that show's form(s) inside the show's window and stamp
// them as that show's booth contacts.
//
// IMPORTANT — the date range alone is not enough.
//
// During SEMA week you also create contacts from the website, paid search and
// everything else. Sweeping every contact created that week into "booth tablet,
// express opt-in" would assign consent that those people never gave, which is
// the one mistake in this whole system that is genuinely hard to walk back.
//
// So the qualifier is the FORM, and the date range narrows it to this show.
// A show with no linked form ids cannot be claimed, on purpose.
//
// EDIT THIS FILE IF: the buffer around the show is wrong, or you need to claim
// from something other than a form.

import * as hubspot from "./hubspot.js";
import { normalizeRow } from "./normalize.js";
import { groupContacts, mergeGroup } from "./merge.js";
import { requireBrand } from "./brands.js";
import { ACTIONS, record } from "./registry.js";

/**
 * How far either side of the show to accept a submission.
 *
 * Booth staff set up the day before and tear down the day after, and a tablet
 * queued offline may not sync until the next morning. One day each side covers
 * both without reaching into the following week.
 */
export const DEFAULT_BUFFER_DAYS = 1;

/** The HubSpot form fields we know how to read, mapped to our own names. */
const FIELD_ALIASES = {
  email: ["email"],
  firstName: ["firstname", "first_name"],
  lastName: ["lastname", "last_name"],
  phone: ["phone", "mobilephone"],
  company: ["company", "auto_shop_name", "shop_name"],
  jobTitle: ["jobtitle"],
  city: ["city"],
  state: ["state"],
};

function windowFor(show, bufferDays) {
  const start = new Date(`${show.startDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - bufferDays);
  const end = new Date(`${show.endDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + bufferDays + 1); // inclusive of the last day
  return { fromMs: start.getTime(), toMs: end.getTime(), from: start.toISOString(), to: end.toISOString() };
}

/** Turns one HubSpot form submission into a row our pipeline understands. */
function submissionToRow(submission) {
  const row = {};
  for (const value of submission.values || []) {
    const name = String(value.name || "").toLowerCase();
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.includes(name) && value.value) row[field] = value.value;
    }
  }
  return row;
}

/**
 * Finds and optionally claims the tablet sign-ups for a show.
 *
 * @param {object} options
 * @param {string} options.brand
 * @param {object} options.show        a show record, with formIds
 * @param {number} options.bufferDays
 * @param {boolean} options.commit     false previews, true writes
 * @param {string} options.consentTextId
 */
export async function claimTabletContacts({
  brand: brandInput,
  show,
  bufferDays = DEFAULT_BUFFER_DAYS,
  commit = false,
  consentTextId = "",
}) {
  const brand = requireBrand(brandInput);

  if (!show.formIds?.length) {
    throw new Error(
      `"${show.name}" has no tablet form linked, so there is nothing to claim.\n` +
        `Find the form with:  tsf discover forms --match "${show.name.split(" ")[0]}"\n` +
        `Then link it with:   tsf show link-form --show ${show.id} --form <form-id>`
    );
  }

  const range = windowFor(show, bufferDays);
  const rows = [];
  const perForm = [];
  const outsideWindow = [];

  for (const formId of show.formIds) {
    // The submissions endpoint returns newest first and pages; a booth form is
    // small, so a few pages is plenty.
    let seen = 0;
    let inRange = 0;
    for (const submission of await hubspot.getFormSubmissions(formId, 200)) {
      seen++;
      const at = Number(submission.submittedAt);
      if (at < range.fromMs || at >= range.toMs) {
        outsideWindow.push({ formId, at: new Date(at).toISOString() });
        continue;
      }
      inRange++;
      rows.push({ ...submissionToRow(submission), submittedAt: at });
    }
    perForm.push({ formId, seen, inRange });
  }

  // ---- same pipeline as a file import, so the rules cannot drift ----
  const batchId = `${brand.id}-${show.id}-booth_tablet-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const normalized = [];
  const rejects = [];

  rows.forEach((row, index) => {
    const result = normalizeRow(row);
    if (!result.ok) {
      rejects.push({ rowNumber: index + 1, reason: result.reason, raw: row });
      return;
    }
    normalized.push({
      ...result.contact,
      ts_sources: "booth_tablet",
      ts_events_attended: show.id,
      ts_first_event: show.id,
      ts_first_source: "booth_tablet",
      ts_brand: brand.id,
      ts_import_batch: batchId,
      ts_consent_status: "express_optin",
      // The submission time IS when they consented — far better than stamping
      // "now", which would claim they opted in the day we ran the backfill.
      ts_consent_at: new Date(row.submittedAt).toISOString(),
      ts_consent_text_id: consentTextId,
    });
  });

  const { groups, review } = groupContacts(normalized);
  const toWrite = groups.map((group) => {
    const merged = mergeGroup(group.contacts);
    const key = `tsf:${brand.id}:${merged.email || merged.phone}`;
    return {
      id: key,
      properties: {
        ts_dedupe_key: key,
        email: merged.email || undefined,
        phone: merged.phone || undefined,
        firstname: merged.firstName || undefined,
        lastname: merged.lastName || undefined,
        company: merged.company || undefined,
        jobtitle: merged.jobTitle || undefined,
        city: merged.city || undefined,
        state: merged.state || undefined,
        ts_brand: brand.id,
        ts_sources: merged.ts_sources,
        ts_events_attended: merged.ts_events_attended,
        ts_first_event: merged.ts_first_event,
        ts_first_source: merged.ts_first_source,
        ts_consent_status: merged.ts_consent_status,
        ts_consent_at: merged.ts_consent_at,
        ts_consent_text_id: merged.ts_consent_text_id || undefined,
        ts_import_batch: batchId,
      },
    };
  });

  for (const entry of toWrite) {
    for (const field of Object.keys(entry.properties)) {
      if (entry.properties[field] === undefined) delete entry.properties[field];
    }
  }

  const summary = {
    brand: brand.id,
    showId: show.id,
    showName: show.name,
    source: "booth_tablet",
    batchId,
    formIds: show.formIds,
    window: { from: range.from, to: range.to, bufferDays },
    perForm,
    submissionsInWindow: rows.length,
    submissionsOutsideWindow: outsideWindow.length,
    contacts: toWrite.length,
    mergedWithinBatch: toWrite.length ? normalized.length - toWrite.length : 0,
    rejected: rejects.length,
    needsReview: review.length,
    committed: false,
  };

  if (!commit) return { summary, toWrite, rejects, review };

  await hubspot.upsertContacts(toWrite.map(({ id, properties }) => ({ id, properties })));
  summary.committed = true;
  record(ACTIONS.TABLET_CLAIMED, { ...summary });

  return { summary, toWrite, rejects, review };
}
