// reverse.js — undoing an import.
//
// WHAT "UNDO" CAN AND CANNOT MEAN HERE
//
// It cannot mean "put HubSpot back exactly as it was". An import upserts: some
// contacts were created, others already existed and had fields updated. The
// previous values of those fields are gone — HubSpot keeps its own property
// history, but this tool never captured them, and pretending otherwise would be
// worse than being honest about it.
//
// So undo does the two things that are both safe and actually useful:
//
//   1. Un-stamps the show. Removes this show from ts_events_attended, and
//      clears ts_first_event where it pointed at this show. The contact stops
//      counting towards this show's audiences immediately, which is what
//      someone means by "get that bad roster out of the SEMA audience".
//
//   2. Marks the contacts. Sets ts_import_batch to "<batch> (reversed)" so the
//      contacts that came in on a bad file stay findable afterwards.
//
// It does NOT delete contacts. Deleting is unrecoverable, and a contact that
// arrived by a bad route is still a real person who may be in other audiences.
// Deleting is a decision for a human in HubSpot, not a side effect of a CLI.
//
// EDIT THIS FILE IF: you want undo to cover a field it currently leaves alone.

import * as hubspot from "./hubspot.js";
import { ACTIONS, record, readHistory } from "./registry.js";
import { splitList } from "./merge.js";

/** Finds the log entry for a batch, so we can say what it did before undoing it. */
export function findBatch(batchId) {
  const all = [
    ...readHistory({ action: "import.committed" }),
    ...readHistory({ action: "tablet.claimed" }),
  ];
  return all.find((entry) => entry.batchId === batchId) || null;
}

/**
 * Reverses one import batch.
 *
 * @param {string} batchId
 * @param {object} options
 * @param {boolean} options.commit  false previews, true writes
 */
export async function reverseBatch(batchId, { commit = false } = {}) {
  if (!batchId) throw new Error("Which batch? Pass a batchId — `tsf imports` lists them.");

  const entry = findBatch(batchId);
  if (!entry) {
    throw new Error(
      `No import found with batch id "${batchId}".\n` +
        "Run `tsf imports` to see them. The id is stamped on every contact as ts_import_batch."
    );
  }

  // Find the contacts this batch touched. ts_import_batch holds the id of the
  // LAST batch to write a contact, so a contact later updated by a different
  // import will not come back here — correct, since undoing this batch should
  // not unpick a later one.
  const found = await hubspot.searchContacts(
    [{ filters: [{ propertyName: "ts_import_batch", operator: "EQ", value: batchId }] }],
    ["email", "ts_events_attended", "ts_first_event", "ts_sources", "ts_import_batch"],
    100
  );

  const showId = entry.showId;
  const updates = [];

  for (const contact of found) {
    const properties = contact.properties || {};
    const events = splitList(properties.ts_events_attended).filter((id) => id !== showId);

    const change = {
      ts_events_attended: events.join(";"),
      ts_import_batch: `${batchId} (reversed)`,
    };

    // Only clear first_event if it pointed at the show being undone; otherwise
    // it belongs to an earlier, still-valid import.
    if (properties.ts_first_event === showId) {
      change.ts_first_event = events[0] || "";
    }

    updates.push({
      id: properties.ts_dedupe_key || contact.id,
      hubspotId: contact.id,
      email: properties.email,
      properties: change,
    });
  }

  const summary = {
    batchId,
    showId,
    showName: entry.showName || entry.showId,
    source: entry.source,
    brand: entry.brand,
    file: entry.file || "(claimed from form)",
    importedAt: entry.at,
    originallyCreated: entry.created ?? entry.contacts ?? 0,
    originallyUpdated: entry.updated ?? 0,
    found: found.length,
    willUpdate: updates.length,
    committed: false,
    // Said out loud every time, because it is the part people assume otherwise.
    caveat:
      "This un-stamps the show and marks the contacts. It does not delete them, " +
      "and it cannot restore field values that the import overwrote.",
  };

  if (!commit) return { summary, updates };

  if (updates.length) {
    await hubspot.upsertContacts(updates.map(({ id, properties }) => ({ id, properties })));
  }
  summary.committed = true;
  record(ACTIONS.IMPORT_REVERSED, { ...summary });

  return { summary, updates };
}
