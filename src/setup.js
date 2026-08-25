// setup.js — creates the contact properties this tool depends on.
//
// Run once per HubSpot portal: `tsf setup --commit`. It is safe to re-run; a
// property that already exists is left alone.
//
// EDIT THIS FILE IF: you want a new field on the contact record. Add it to
// PROPERTIES and re-run setup. Do not create these in the HubSpot UI instead —
// the internal name has to match exactly or the tool will not find it.

import * as hubspot from "./hubspot.js";

/** The property group everything lands in, so it is easy to find in the UI. */
export const GROUP_NAME = "tradeshow";

/**
 * Every property, with a comment on why it exists. The order here is the order
 * they appear in HubSpot.
 */
export const PROPERTIES = [
  {
    name: "ts_dedupe_key",
    label: "Trade Show — Dedupe Key",
    type: "string",
    fieldType: "text",
    hasUniqueValue: true, // this is what makes idempotent upserts possible
    description:
      "Stable unique key used to upsert this contact. Do not edit by hand. " +
      "Email is not used as the upsert key because HubSpot cannot do partial " +
      "upserts on email, which would blank fields we did not send.",
  },
  {
    name: "ts_sources",
    label: "Trade Show — Sources",
    type: "enumeration",
    fieldType: "checkbox",
    description: "Every way we have ever captured this person. Appends, never replaces.",
    options: [
      "booth_tablet",
      "badge_scan",
      "roster_pre",
      "roster_post",
      "referral",
    ],
  },
  {
    name: "ts_first_source",
    label: "Trade Show — First Source",
    type: "string",
    fieldType: "text",
    description: "How we first met them. Write-once.",
  },
  {
    name: "ts_events_attended",
    label: "Trade Show — Events Attended",
    type: "enumeration",
    fieldType: "checkbox",
    description:
      "Every show this contact has appeared at. Appends. Repeat attendance is " +
      "the strongest intent signal we have, and overwriting hides it.",
    options: [], // filled in as shows are added
  },
  {
    name: "ts_first_event",
    label: "Trade Show — First Event",
    type: "string",
    fieldType: "text",
    description: "The show where we first met them. Write-once.",
  },
  {
    name: "ts_consent_status",
    label: "Trade Show — Consent Status",
    type: "enumeration",
    fieldType: "select",
    description: "Recorded on every contact whether or not we route on it.",
    options: ["express_optin", "registration_optin", "none", "revoked"],
  },
  {
    name: "ts_consent_at",
    label: "Trade Show — Consent Timestamp",
    type: "datetime",
    fieldType: "date",
    description: "When consent was given. Write-once; earliest wins on merge.",
  },
  {
    name: "ts_consent_text_id",
    label: "Trade Show — Consent Wording Version",
    type: "string",
    fieldType: "text",
    description:
      "Which wording they agreed to, e.g. booth-v2-2026, or the organizer's " +
      "registration clause. This is what answers the question if it is ever asked.",
  },
  {
    name: "ts_interest",
    label: "Trade Show — Product Interest",
    type: "enumeration",
    fieldType: "checkbox",
    description: "What the rep tapped at the booth. Routes the nurture track.",
    options: ["rotors", "pads", "calipers", "heavy_duty", "police", "ambassador", "hardware"],
  },
  {
    name: "ts_account_type",
    label: "Trade Show — Account Type",
    type: "enumeration",
    fieldType: "select",
    description: "Qualification. Maps to the existing DFC campaign structure.",
    options: ["shop", "fleet", "distributor", "installer", "law_enforcement", "consumer", "other"],
  },
  {
    name: "ts_booth_rep",
    label: "Trade Show — Booth Rep",
    type: "string",
    fieldType: "text",
    description: "Who actually talked to them. Makes booth staffing measurable.",
  },
  {
    name: "ts_import_batch",
    label: "Trade Show — Import Batch",
    type: "string",
    fieldType: "text",
    description:
      "Ties this contact back to one ingest run, so a bad file can be found " +
      "and reversed. Matches a batchId in data/history/*.jsonl.",
  },
];

/** Builds the payload HubSpot wants for one property. */
function toPayload(property, displayOrder) {
  const payload = {
    name: property.name,
    label: property.label,
    type: property.type,
    fieldType: property.fieldType,
    groupName: GROUP_NAME,
    description: property.description,
    displayOrder,
  };
  if (property.hasUniqueValue) payload.hasUniqueValue = true;
  if (property.options) {
    payload.options = property.options.map((value, index) => ({
      label: value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      value,
      displayOrder: index,
    }));
  }
  return payload;
}

/**
 * Creates the property group and every property.
 *
 * @param {object} options
 * @param {boolean} options.commit  false previews, true writes
 */
export async function setupProperties({ commit = false } = {}) {
  // What is already there?
  const existing = await hubspot.get("/crm/v3/properties/contacts");
  const existingNames = new Set((existing?.results || []).map((p) => p.name));

  const report = { properties: [], created: 0, existing: 0 };

  if (commit) {
    // The group may already exist; a 409 here is fine and expected.
    try {
      await hubspot.post("/crm/v3/properties/contacts/groups", {
        name: GROUP_NAME,
        label: "Trade Show",
        displayOrder: -1,
      });
    } catch (error) {
      if (!/409|already exists|EXISTING/i.test(error.message)) throw error;
    }
  }

  for (const [index, property] of PROPERTIES.entries()) {
    if (existingNames.has(property.name)) {
      report.properties.push({ name: property.name, status: "exists" });
      report.existing++;
      continue;
    }

    if (!commit) {
      report.properties.push({ name: property.name, status: "would add" });
      continue;
    }

    await hubspot.post("/crm/v3/properties/contacts", toPayload(property, index));
    report.properties.push({ name: property.name, status: "created" });
    report.created++;
  }

  return report;
}

/**
 * Adds a show id as an option on ts_events_attended, so it can be picked in
 * the HubSpot UI and used in list filters. Called when a show is added.
 */
export async function addShowOption(showId, showName) {
  const property = await hubspot.get("/crm/v3/properties/contacts/ts_events_attended");
  const options = property.options || [];
  if (options.some((option) => option.value === showId)) return property;

  options.push({ label: showName, value: showId, displayOrder: options.length });
  return hubspot.patch("/crm/v3/properties/contacts/ts_events_attended", { options });
}
