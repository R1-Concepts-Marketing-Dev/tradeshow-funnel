// exportAudience.js — an audience out of HubSpot and into a file you can upload.
//
// The shape of the job:
//   audience -> HubSpot list members -> filter -> platform format -> CSV -> log
//
// The formatting rules live in src/adPlatforms.js. This file is about getting
// the right PEOPLE, which is a different question and mostly a question of who
// to leave out.
//
// WHO GETS LEFT OUT, AND WHY
//
// An ad-platform upload is not an email send, so the rules are not identical —
// but three exclusions apply to both, and all three are here:
//
//   opted out      Someone who asked not to be marketed to did not mean
//                  "except on Facebook". This is the one that matters.
//   hard bounced   The address does not exist. It cannot match. It is noise
//                  in the file and it drags the match rate down.
//   role inboxes   info@, sales@, service@ — a shared mailbox is not a person,
//                  will not match, and should never have been in the list.
//
// Nothing here deletes or edits a contact. Excluding is a decision about one
// file, made fresh every time it is exported.
//
// EDIT THIS FILE IF: you want a different exclusion rule, or a new destination.

import fs from "node:fs";
import path from "node:path";
import * as hubspot from "./hubspot.js";
import { isRoleInbox } from "./normalize.js";
import { buildRows, toCsv, describeFile, PLATFORMS } from "./adPlatforms.js";
import { ACTIONS, record, loadAudience } from "./registry.js";
import { PATHS } from "./config.js";
import { brandLabel } from "./brands.js";

/** Everything we need from HubSpot to build any platform's file. */
const PROPERTIES = [
  "email",
  "phone",
  "firstname",
  "lastname",
  "company",
  "jobtitle",
  "city",
  "state",
  "zip",
  "country",
  "hs_email_optout",
  "hs_email_hard_bounce_reason_enum",
  "ts_brand",
  "ts_events_attended",
  "ts_sources",
];

/** HubSpot's property names into the names src/adPlatforms.js expects. */
function toContact(properties = {}) {
  return {
    email: properties.email || "",
    phone: properties.phone || "",
    firstName: properties.firstname || "",
    lastName: properties.lastname || "",
    company: properties.company || "",
    jobTitle: properties.jobtitle || "",
    city: properties.city || "",
    state: properties.state || "",
    zip: properties.zip || "",
    country: properties.country || "",
  };
}

/**
 * Decides whether one contact belongs in an upload.
 *
 * @returns {string|null} why it was excluded, or null to keep it
 */
export function exclusionReason(properties = {}, { includeOptedOut = false } = {}) {
  // HubSpot writes this as the string "true", not a boolean.
  const optedOut = properties.hs_email_optout === "true" || properties.hs_email_optout === true;
  if (optedOut && !includeOptedOut) return "opted out of marketing";

  if (properties.hs_email_hard_bounce_reason_enum) return "email hard bounced";

  const email = String(properties.email || "").trim();
  if (email && isRoleInbox(email)) return "shared mailbox, not a person";

  if (!email && !String(properties.phone || "").trim()) return "no email or phone";

  return null;
}

/**
 * Pulls every contact in an audience.
 *
 * Uses list memberships rather than a CRM search, because search stops paging
 * at 10,000 and a silently truncated audience is the worst possible outcome
 * here — the upload succeeds and simply misses people.
 */
export async function fetchAudienceContacts(audience, { onProgress = () => {} } = {}) {
  if (!audience.hubspotListId) {
    throw new Error(
      `"${audience.name}" has no HubSpot list behind it, so there is nobody to export.\n` +
        (audience.type === "geo"
          ? "It is a geo audience — a place and a date range, not a list of people.\n" +
            "Target it in the ad platform with the radius and dates from `tsf show geo`."
          : "Run `tsf audience refresh --id " + audience.id + "` and check it was created properly.")
    );
  }

  onProgress({ stage: "members" });
  const ids = await hubspot.listMemberships(audience.hubspotListId, (n) =>
    onProgress({ stage: "members", count: n })
  );

  onProgress({ stage: "details", total: ids.length });
  const records = await hubspot.batchReadContacts(ids, PROPERTIES);

  return records.map((row) => row.properties || {});
}

/**
 * Builds one platform's file for one audience.
 *
 * @param {object} options
 * @param {string} options.audienceId
 * @param {string} options.platform        a key of PLATFORMS
 * @param {boolean} options.hash           SHA-256 the hashable columns
 * @param {boolean} options.includeOptedOut
 * @param {string} options.outDir          defaults to <data>/exports
 * @param {boolean} options.write          false builds and reports without writing
 */
export async function exportAudience({
  audienceId,
  platform,
  hash = false,
  includeOptedOut = false,
  outDir,
  write = true,
  onProgress = () => {},
} = {}) {
  if (!PLATFORMS[platform]) {
    throw new Error(
      `"${platform}" is not a platform I know. Try one of: ${Object.keys(PLATFORMS).join(", ")}.`
    );
  }

  const audience = loadAudience(audienceId);
  if (!audience) throw new Error(`No audience with id "${audienceId}".`);

  const properties = await fetchAudienceContacts(audience, { onProgress });

  // --- filter -------------------------------------------------------------
  const excluded = {};
  const kept = [];
  for (const row of properties) {
    const reason = exclusionReason(row, { includeOptedOut });
    if (reason) {
      excluded[reason] = (excluded[reason] || 0) + 1;
      continue;
    }
    kept.push(toContact(row));
  }

  // --- format -------------------------------------------------------------
  const { headers, rows, skipped, platform: spec } = buildRows(kept, platform, { hash });

  // buildRows drops rows this platform cannot use at all; fold those into the
  // same tally so one number explains every person who is not in the file.
  for (const item of skipped) {
    excluded[item.reason] = (excluded[item.reason] || 0) + 1;
  }

  const summary = {
    audienceId: audience.id,
    audienceName: audience.name,
    brand: audience.brand,
    brandName: brandLabel(audience.brand),
    platform,
    platformLabel: spec.label,
    hashed: hash,
    inHubSpot: properties.length,
    excluded,
    excludedTotal: Object.values(excluded).reduce((n, count) => n + count, 0),
    ...describeFile({ rows, platform: spec, hash }),
    notes: spec.notes,
    headersUnverified: Boolean(spec.headersUnverified),
    file: null,
  };

  if (!write) return { summary, headers, rows };

  // --- write --------------------------------------------------------------
  const directory = outDir || path.join(PATHS.data, "exports");
  fs.mkdirSync(directory, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = audience.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const file = path.join(
    directory,
    `${safeName}-${platform}${hash ? "-hashed" : ""}-${stamp}.csv`
  );

  fs.writeFileSync(file, toCsv(headers, rows), "utf8");
  summary.file = file;

  // The registry is the point of this tool: a file that went to a platform is
  // an event worth being able to ask about a year from now.
  record(ACTIONS.AUDIENCE_EXPORTED, {
    audienceId: audience.id,
    audienceName: audience.name,
    brand: audience.brand,
    platform,
    hashed: hash,
    rows: rows.length,
    excluded: summary.excludedTotal,
    clearsMinimum: summary.clearsMinimum,
    file,
  });

  return { summary, headers, rows };
}
