// geo.js — targeting the show itself, instead of the people you collected.
//
// Why this exists: a single show rarely produces enough contacts to clear the
// ad platforms' audience floors (Meta needs 1,000 MATCHED users, TikTok 1,000).
// A 400-person booth list matches to roughly 200 people and will not deliver.
//
// But everyone at the show is standing in one building for four days. Targeting
// that building for that window reaches all of them, list or no list — and it
// works before you have collected a single contact, which a customer-list
// audience never can.
//
// Use both when you can: geo for reach during the show, the contact audience
// for retargeting after it.
//
// EDIT THIS FILE IF: you want different default radii or lead/lag days, or a
// platform needs its spec formatted differently.

/** Free, keyless geocoding. Their policy asks for a real User-Agent. */
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "tradeshow-funnel/0.1 (R1 Concepts marketing tooling)";

/**
 * Default targeting rings around a venue.
 *
 * venue  — the hall itself. Tightest, highest intent, smallest reach.
 * campus — venue plus the hotels and parking that surround it.
 * metro  — the wider city. Catches attendees at their hotel and the airport,
 *          but also catches everyone who lives there, so expect waste.
 */
export const DEFAULT_RINGS = [
  { name: "venue", radiusMiles: 2, note: "The hall itself. Highest intent, smallest reach." },
  { name: "campus", radiusMiles: 5, note: "Venue plus surrounding hotels and parking." },
  { name: "metro", radiusMiles: 25, note: "Wider city. Catches hotels and the airport — and residents. Expect waste." },
];

/**
 * How many days either side of the show to run.
 *
 * Attendees fly in the day before and leave the day after, so the window is
 * wider than the show itself. Lead days also let you build frequency before
 * the floor opens, which is when booth-visit decisions actually get made.
 */
export const DEFAULT_LEAD_DAYS = 2;
export const DEFAULT_LAG_DAYS = 1;

/** Platform limits worth knowing before you build a spec that cannot be used. */
export const RADIUS_LIMITS = {
  "google-ads": { minMiles: 1, maxMiles: 500, note: "Radius targeting, miles or km." },
  meta: { minMiles: 1, maxMiles: 50, note: "Radius 1–50 miles. Use 'people recently in this location'." },
  tiktok: { minMiles: 1, maxMiles: 100, note: "Location targeting is city-level in some markets." },
  linkedin: { minMiles: null, maxMiles: null, note: "No radius — target the metro area instead." },
};

/**
 * Looks up a venue's coordinates.
 *
 * @param {string} query e.g. "Las Vegas Convention Center, Las Vegas, NV"
 * @returns {Promise<{lat:number, lng:number, displayName:string} | null>}
 */
export async function geocode(query) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (!response.ok) {
    throw new Error(`Geocoding failed (${response.status}). Try again, or set --lat and --lng by hand.`);
  }

  const results = await response.json();
  if (!results.length) return null;

  const hit = results[0];
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    displayName: hit.display_name,
  };
}

/** Adds days to a YYYY-MM-DD date and returns the same format. */
export function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
}

/**
 * Builds the full targeting spec for a show.
 *
 * @param {object} show      a show record from the registry
 * @param {object} options
 * @param {number} options.leadDays
 * @param {number} options.lagDays
 * @param {Array}  options.rings  defaults to DEFAULT_RINGS
 */
export function buildGeoSpec(show, { leadDays = DEFAULT_LEAD_DAYS, lagDays = DEFAULT_LAG_DAYS, rings = DEFAULT_RINGS } = {}) {
  if (!show.venue?.lat || !show.venue?.lng) {
    throw new Error(
      `Show "${show.id}" has no venue coordinates. Run: tsf show research --id ${show.id} --venue "<venue name and city>"`
    );
  }

  const runStart = shiftDate(show.startDate, -leadDays);
  const runEnd = shiftDate(show.endDate, lagDays);

  return {
    showId: show.id,
    showName: show.name,
    venue: show.venue,
    window: {
      showStart: show.startDate,
      showEnd: show.endDate,
      runStart,
      runEnd,
      totalDays: daysBetween(runStart, runEnd),
      leadDays,
      lagDays,
    },
    rings: rings.map((ring) => ({
      ...ring,
      radiusKm: Math.round(ring.radiusMiles * 1.60934 * 10) / 10,
    })),
    // Worth stating explicitly — this is the setting people forget, and getting
    // it wrong means you target residents instead of visitors.
    presenceSetting:
      'Target "people IN or REGULARLY IN this location" on Google, and ' +
      '"people recently in this location" on Meta. The default on both is ' +
      "broader and will include people merely interested in the city.",
  };
}

/**
 * Renders the spec as something you can read once and set up from.
 * Ben builds the campaigns himself — this is the handoff, not an API call.
 */
export function formatGeoSpec(spec) {
  const lines = [];
  lines.push(`GEO TARGET — ${spec.showName}`);
  lines.push("");
  lines.push(`  Venue      ${spec.venue.name}`);
  if (spec.venue.displayName) lines.push(`             ${spec.venue.displayName}`);
  lines.push(`  Coordinates ${spec.venue.lat}, ${spec.venue.lng}`);
  lines.push("");
  lines.push(`  Show dates ${spec.window.showStart} → ${spec.window.showEnd}`);
  lines.push(
    `  Run dates  ${spec.window.runStart} → ${spec.window.runEnd}  ` +
      `(${spec.window.totalDays} days: ${spec.window.leadDays} lead, ${spec.window.lagDays} lag)`
  );
  lines.push("");
  lines.push("  Rings");
  for (const ring of spec.rings) {
    lines.push(`    ${ring.name.padEnd(8)} ${String(ring.radiusMiles).padStart(3)} mi / ${String(ring.radiusKm).padStart(5)} km   ${ring.note}`);
  }
  lines.push("");
  lines.push("  Presence setting");
  lines.push(`    ${spec.presenceSetting}`);
  lines.push("");
  lines.push("  Platform notes");
  for (const [platform, limit] of Object.entries(RADIUS_LIMITS)) {
    lines.push(`    ${platform.padEnd(12)} ${limit.note}`);
  }
  return lines.join("\n");
}
