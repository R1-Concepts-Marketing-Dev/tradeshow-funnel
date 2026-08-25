// metaNaming.js — how a Meta campaign says which show it belongs to.
//
// Meta campaigns and ad sets for this program are built per event, so rather
// than guessing from names or asking someone to copy ids around, the show id
// goes in the name as a tag:
//
//     DFC | SEMA 2026 | Booth traffic [tsf:sema-2026/booth-traffic]
//     DFC | SEMA 2026 | Pre-show      [tsf:sema-2026/pre-show]
//     R1 | AAPEX 2026                 [tsf:aapex-2026]
//
// Everything before the tag is yours — Meta's own naming convention, whatever
// it is. The tool only reads the bracket.
//
// Why a tag rather than matching the show name: names get edited, abbreviated
// and typo'd, and "SEMA" appears in things that have nothing to do with the
// show. A tag is unambiguous, survives renaming the rest, and is obvious to a
// person looking at the campaign list.
//
// The campaign type after the slash is optional. Include it and the report can
// say which recipe an ad set corresponds to; leave it off and it still counts
// for the show.
//
// EDIT THIS FILE IF: you want a different tag format. Change TAG_PATTERN and
// the examples above together.

/** Matches [tsf:show-id] or [tsf:show-id/campaign-type], anywhere in a name. */
const TAG_PATTERN = /\[tsf:([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9][a-z0-9-]*))?\]/i;

/**
 * Pulls the tag out of a campaign or ad set name.
 *
 * @returns {{showId: string, campaignType: string|null}|null}
 */
export function parseTag(name) {
  const match = TAG_PATTERN.exec(String(name || ""));
  if (!match) return null;
  return {
    showId: match[1].toLowerCase(),
    campaignType: match[2] ? match[2].toLowerCase() : null,
  };
}

/** Builds the tag to paste into a Meta campaign or ad set name. */
export function buildTag(showId, campaignType = null) {
  return campaignType ? `[tsf:${showId}/${campaignType}]` : `[tsf:${showId}]`;
}

/**
 * The names to use for a show, ready to copy into Meta. Printed by
 * `tsf show meta-names` so nobody has to remember the format.
 */
export function suggestedNames(show, brand, campaignTypes = []) {
  const prefix = `${brand.shortName} | ${show.name}`;
  const lines = [
    { what: "Campaign", name: `${prefix} ${buildTag(show.id)}` },
  ];
  for (const type of campaignTypes) {
    lines.push({
      what: `Ad set — ${type.name}`,
      name: `${prefix} | ${type.name} ${buildTag(show.id, type.id)}`,
    });
  }
  return lines;
}
