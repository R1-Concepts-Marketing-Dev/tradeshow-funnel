// campaigns.js — "I just loaded a show's list, now what do I run?"
//
// A campaign type is a named recipe that turns one show into one audience,
// with the window, radius and source filter already decided. It exists so the
// answer to that question is a checkbox rather than a set of judgement calls
// you have to re-make every show.
//
// This module builds audiences. It does NOT create campaigns in Google or Meta
// — Ben builds those himself, and the spec here is the handoff.
//
// EDIT THIS FILE IF: you want a new recipe, or the defaults on one are wrong.
// Everything is data in CAMPAIGN_TYPES; no logic changes needed for a new type.

import { DEFAULT_RINGS } from "./geo.js";
import * as audiences from "./audiences.js";
import { requireBrand } from "./brands.js";

/** Picks named rings out of the default set. */
const rings = (...names) => DEFAULT_RINGS.filter((ring) => names.includes(ring.name));

/**
 * The recipes.
 *
 * kind "geo"  — a place and a window. No contact data, no platform floor.
 * kind "list" — contacts, filtered by source. Subject to platform floors.
 *
 * `needsVenue` types cannot be built until `tsf show research` has run.
 */
export const CAMPAIGN_TYPES = [
  {
    id: "pre-show",
    name: "Pre-show awareness",
    kind: "geo",
    needsVenue: true,
    suffix: "Pre-show",
    summary:
      "Reach attendees in the days before the doors open, while they are still " +
      "deciding which booths are worth their time.",
    creates: "A geo audience over the campus and metro rings, running the lead days up to opening day.",
    geo: { windowMode: "pre", leadDays: 5, rings: rings("campus", "metro") },
    platforms: ["google-ads", "meta"],
  },
  {
    id: "booth-traffic",
    name: "Booth traffic",
    kind: "geo",
    needsVenue: true,
    suffix: "Booth traffic",
    summary:
      "Reach people while they are physically in the hall. Tightest radius, " +
      "highest intent, and it does not care how many contacts you have.",
    creates: "A geo audience on the venue ring only, running the show days.",
    geo: { windowMode: "during", rings: rings("venue") },
    platforms: ["google-ads", "meta"],
  },
  {
    id: "post-show-retarget",
    name: "Post-show retargeting",
    kind: "list",
    needsVenue: false,
    suffix: "Post-show retargeting",
    summary:
      "Stay in front of everyone the show produced, whichever way they arrived.",
    creates: "A contact audience of every source from this show.",
    list: { sources: [] }, // empty means any source
    platforms: ["google-ads", "meta"],
  },
  {
    id: "booth-engaged",
    name: "Booth-engaged nurture",
    kind: "list",
    needsVenue: false,
    suffix: "Booth-engaged",
    summary:
      "Only the people who actually stopped at the booth — they typed their own " +
      "details in or handed you a badge. The highest-intent segment a show produces.",
    creates: "A contact audience filtered to the tablet and badge-scan sources.",
    list: { sources: ["booth_tablet", "badge_scan"] },
    platforms: ["hubspot-email", "google-ads"],
  },
  {
    id: "lookalike-seed",
    name: "Lookalike seed",
    kind: "list",
    needsVenue: false,
    pooled: true, // spans every show, not just this one
    summary:
      "A rolling pool across every show, because one show almost never clears " +
      "the platform floors. This is what seeds a lookalike.",
    creates: "One shared contact audience across all shows for this brand. Reused, not recreated per show.",
    list: { sources: [] },
    fixedName: "Trade Show Universe",
    platforms: ["meta", "google-ads"],
  },
];

export function findCampaignType(id) {
  const type = CAMPAIGN_TYPES.find((entry) => entry.id === id);
  if (!type) {
    throw new Error(
      `Unknown campaign type "${id}". Valid: ${CAMPAIGN_TYPES.map((t) => t.id).join(", ")}`
    );
  }
  return type;
}

/**
 * Works out which types can be built for a show right now, and why not for the
 * rest. The UI shows this so a disabled checkbox always explains itself.
 */
export function availableFor(show) {
  return CAMPAIGN_TYPES.map((type) => ({
    ...type,
    available: !(type.needsVenue && !show?.venue),
    blockedReason:
      type.needsVenue && !show?.venue
        ? "Needs the venue location. Look it up first — it takes a second."
        : null,
  }));
}

/** The audience name a type produces for a show. */
export function audienceNameFor(type, show) {
  return type.fixedName || `${show.name} — ${type.suffix}`;
}

/**
 * Builds the selected campaign types for one show and brand.
 *
 * @param {object} options
 * @param {string} options.brand
 * @param {object} options.show      a show record
 * @param {string[]} options.typeIds
 * @param {boolean} options.commit   false previews, true creates
 * @returns {Promise<{created: object[], skipped: object[]}>}
 */
export async function createCampaigns({ brand: brandInput, show, typeIds, commit = false }) {
  const brand = requireBrand(brandInput);
  const created = [];
  const skipped = [];

  for (const typeId of typeIds) {
    const type = findCampaignType(typeId);

    if (type.needsVenue && !show.venue) {
      skipped.push({ typeId, reason: "Show has no venue location yet." });
      continue;
    }

    const name = audienceNameFor(type, show);

    try {
      if (type.kind === "geo") {
        created.push({
          typeId,
          typeName: type.name,
          audience: await audiences.createGeoAudience({
            brand: brand.id,
            show,
            name,
            purpose: type.summary,
            windowMode: type.geo.windowMode,
            leadDays: type.geo.leadDays,
            lagDays: type.geo.lagDays,
            rings: type.geo.rings,
            dryRun: !commit,
          }),
        });
      } else {
        created.push({
          typeId,
          typeName: type.name,
          audience: await audiences.createAudience({
            brand: brand.id,
            name,
            purpose: type.summary,
            // A pooled type deliberately spans every show, so it takes no
            // show filter — that is the whole point of it.
            shows: type.pooled ? [] : [show.id],
            sources: type.list.sources,
            dryRun: !commit,
          }),
        });
      }
    } catch (error) {
      // An audience that already exists is the normal case for the pooled type
      // on the second show, and is not a failure.
      if (/already exists/.test(error.message)) {
        skipped.push({ typeId, reason: "Already exists — reusing it." });
      } else {
        throw error;
      }
    }
  }

  return { created, skipped };
}
