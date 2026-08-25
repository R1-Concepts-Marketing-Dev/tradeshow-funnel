// merge.js — deciding when two rows are the same person, and what wins.
//
// This is the part of the system that turns a roster and a tablet export into
// one contact instead of two duplicates. It is worth reading before you change
// anything, because a wrong merge is very hard to undo.
//
// EDIT THIS FILE IF: you want a different match pass, or a different field to
// win a conflict. Both are expressed as data below rather than buried in code.

import { companyDomain } from "./normalize.js";

/**
 * Fields that are written once and then never changed, no matter what a later
 * file says. Consent is the obvious one: if someone opted in at the booth in
 * March, a roster in November does not get to restate when that happened.
 */
export const WRITE_ONCE_FIELDS = [
  "ts_consent_at",
  "ts_consent_text_id",
  "ts_first_event",
  "ts_first_source",
];

/**
 * Fields that accumulate rather than replace. A contact can be on the tablet
 * AND the roster, and can attend five shows — overwriting either of those
 * throws away the signal we most want.
 */
export const APPEND_FIELDS = ["ts_sources", "ts_events_attended", "ts_interest"];

/**
 * Which source wins a straight conflict, per field. The tablet knows what the
 * person said at your booth; the roster usually has cleaner firmographics.
 * Anything not listed here falls back to "first non-empty value wins".
 */
export const FIELD_PRECEDENCE = {
  phone: ["booth_tablet", "badge_scan", "roster_post", "roster_pre"],
  jobTitle: ["roster_pre", "roster_post", "badge_scan", "booth_tablet"],
  company: ["roster_pre", "roster_post", "badge_scan", "booth_tablet"],
  firstName: ["booth_tablet", "badge_scan", "roster_pre", "roster_post"],
  lastName: ["booth_tablet", "badge_scan", "roster_pre", "roster_post"],
};

/**
 * The match passes, in the order they are tried. The first one that hits wins.
 *
 * `confident: false` means we will NOT merge automatically — the pair goes to
 * the review file instead. Name+company is right often enough to be useful and
 * wrong often enough that a human should look.
 */
export const MATCH_PASSES = [
  {
    name: "email",
    confident: true,
    key: (contact) => (contact.email ? `email:${contact.email}` : null),
  },
  {
    name: "phone",
    confident: true,
    key: (contact) => (contact.phone ? `phone:${contact.phone}` : null),
  },
  {
    name: "name+company",
    confident: false,
    key: (contact) => {
      const domain = contact.companyDomain || companyDomain(contact.email);
      if (!contact.lastName || !domain) return null;
      return `nc:${contact.lastName.toLowerCase()}|${domain}`;
    },
  },
];

/**
 * Groups rows that refer to the same person.
 *
 * @param {Array<object>} contacts normalized contacts
 * @returns {{groups: Array<object>, review: Array<object>}}
 *   groups  — confidently merged clusters, each { contacts, matchedBy }
 *   review  — pairs that matched only on a non-confident pass
 */
export function groupContacts(contacts) {
  // Kept apart on purpose: a hit in confidentKeys merges, a hit in reviewKeys
  // only raises a flag. Using one map for both is how you get silent bad merges.
  const confidentKeys = new Map(); // key -> index into groups
  const reviewKeys = new Map();    // key -> index into groups
  const groups = [];
  const review = [];

  for (const contact of contacts) {
    let groupIndex = null;
    let matchedBy = null;

    // Pass 1: confident matches actually merge.
    for (const pass of MATCH_PASSES) {
      if (!pass.confident) continue;
      const key = pass.key(contact);
      if (key && confidentKeys.has(key)) {
        groupIndex = confidentKeys.get(key);
        matchedBy = pass.name;
        break;
      }
    }

    if (groupIndex !== null) {
      groups[groupIndex].contacts.push(contact);
      groups[groupIndex].matchedBy.add(matchedBy);
    } else {
      // No confident match, so this contact stands on its own. It always gets
      // its own group — a flagged contact must never be dropped from the output.
      groupIndex = groups.length;
      groups.push({ contacts: [contact], matchedBy: new Set() });

      // Pass 2: did a softer rule hit? Say so, but leave them separate.
      for (const pass of MATCH_PASSES) {
        if (pass.confident) continue;
        const key = pass.key(contact);
        if (key && reviewKeys.has(key)) {
          review.push({
            contact,
            thisGroup: groupIndex,
            suggestedGroup: reviewKeys.get(key),
            matchedBy: pass.name,
            reason: `matched "${key}" — confirm before merging`,
          });
          break;
        }
      }
    }

    registerKeys(confidentKeys, reviewKeys, contact, groupIndex);
  }

  return {
    groups: groups.map((group) => ({
      contacts: group.contacts,
      matchedBy: [...group.matchedBy],
    })),
    review,
  };
}

/**
 * Indexes every key a contact has, so a later row can find it. Confident and
 * soft keys go into different maps — see groupContacts for why.
 */
function registerKeys(confidentKeys, reviewKeys, contact, groupIndex) {
  for (const pass of MATCH_PASSES) {
    const key = pass.key(contact);
    if (!key) continue;
    const target = pass.confident ? confidentKeys : reviewKeys;
    if (!target.has(key)) target.set(key, groupIndex);
  }
}

/**
 * Collapses a group of contacts into the single record we will write.
 *
 * @param {Array<object>} contacts  all rows believed to be one person
 * @param {object} existing         what HubSpot already has, or null
 */
export function mergeGroup(contacts, existing = null) {
  const merged = { ...(existing || {}) };
  const sourcesSeen = new Set(splitList(existing?.ts_sources));
  const eventsSeen = new Set(splitList(existing?.ts_events_attended));
  const interestsSeen = new Set(splitList(existing?.ts_interest));

  // Order the rows so the highest-precedence source is considered first.
  for (const field of Object.keys(FIELD_PRECEDENCE)) {
    const ranking = FIELD_PRECEDENCE[field];
    const ordered = [...contacts].sort(
      (a, b) => rankOf(a, ranking) - rankOf(b, ranking)
    );
    const winner = ordered.find((contact) => contact[field]);
    if (winner && !isWriteOnceAlreadySet(merged, field)) {
      merged[field] = winner[field];
    }
  }

  // Everything else: first non-empty value wins, and never clobber a value
  // that already exists on the HubSpot record.
  for (const contact of contacts) {
    for (const [field, value] of Object.entries(contact)) {
      if (field === "extra" || value === "" || value == null) continue;
      if (FIELD_PRECEDENCE[field]) continue; // already decided above
      if (WRITE_ONCE_FIELDS.includes(field) && merged[field]) continue;
      if (!merged[field]) merged[field] = value;
    }
    for (const source of splitList(contact.ts_sources)) sourcesSeen.add(source);
    for (const event of splitList(contact.ts_events_attended)) eventsSeen.add(event);
    for (const interest of splitList(contact.ts_interest)) interestsSeen.add(interest);
  }

  // HubSpot multi-checkbox properties are semicolon-delimited strings.
  if (sourcesSeen.size) merged.ts_sources = [...sourcesSeen].sort().join(";");
  if (eventsSeen.size) merged.ts_events_attended = [...eventsSeen].sort().join(";");
  if (interestsSeen.size) merged.ts_interest = [...interestsSeen].sort().join(";");

  // Earliest consent timestamp wins — see WRITE_ONCE_FIELDS above.
  const consentDates = [existing?.ts_consent_at, ...contacts.map((c) => c.ts_consent_at)]
    .filter(Boolean)
    .sort();
  if (consentDates.length) merged.ts_consent_at = consentDates[0];

  return merged;
}

function rankOf(contact, ranking) {
  const source = splitList(contact.ts_sources)[0] || "";
  const index = ranking.indexOf(source);
  return index === -1 ? ranking.length : index;
}

function isWriteOnceAlreadySet(merged, field) {
  return WRITE_ONCE_FIELDS.includes(field) && Boolean(merged[field]);
}

/** HubSpot multi-checkbox values come back as "a;b;c". Empty is an empty list. */
export function splitList(value) {
  if (!value) return [];
  return String(value).split(";").map((part) => part.trim()).filter(Boolean);
}
