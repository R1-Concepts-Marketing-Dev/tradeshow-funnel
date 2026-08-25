// Tests for the campaign recipes and the windows they produce.
//
// These are the defaults nobody will re-derive per show, so they need to be
// right once and stay right.

import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_TYPES, availableFor, audienceNameFor, findCampaignType } from "../src/campaigns.js";
import { buildGeoSpec } from "../src/geo.js";

const show = {
  id: "sema-2026", name: "SEMA 2026",
  startDate: "2026-11-03", endDate: "2026-11-06",
  venue: { name: "Las Vegas Convention Center", lat: 36.131, lng: -115.15 },
};
const showWithoutVenue = { ...show, venue: null };

test("every campaign type has what the UI needs to explain itself", () => {
  for (const type of CAMPAIGN_TYPES) {
    assert.ok(type.id && type.name, `${type.id} needs an id and name`);
    assert.ok(["geo", "list"].includes(type.kind), `${type.id} has an odd kind`);
    assert.ok(type.summary?.length > 20, `${type.id} needs a real summary`);
    assert.ok(type.creates?.length > 20, `${type.id} needs to say what it creates`);
  }
});

test("geo types are blocked until the venue is known, with a reason", () => {
  const available = availableFor(showWithoutVenue);
  const preShow = available.find((t) => t.id === "pre-show");
  assert.equal(preShow.available, false);
  assert.match(preShow.blockedReason, /venue/i);

  // List types do not need a venue and stay available.
  assert.equal(available.find((t) => t.id === "post-show-retarget").available, true);
});

test("everything is available once the venue is known", () => {
  assert.ok(availableFor(show).every((type) => type.available));
});

test("pre-show runs before the doors open and stops there", () => {
  const type = findCampaignType("pre-show");
  const spec = buildGeoSpec(show, type.geo);
  assert.equal(spec.window.runStart, "2026-10-29"); // 5 lead days
  assert.equal(spec.window.runEnd, "2026-11-03");   // opening day
  assert.equal(spec.window.mode, "pre");
});

test("booth traffic runs only the show days, on the tightest ring", () => {
  const type = findCampaignType("booth-traffic");
  const spec = buildGeoSpec(show, type.geo);
  assert.equal(spec.window.runStart, "2026-11-03");
  assert.equal(spec.window.runEnd, "2026-11-06");
  assert.deepEqual(spec.rings.map((r) => r.name), ["venue"]);
});

test("the two geo campaigns do not overlap", () => {
  // Pre-show ends the day booth traffic starts, so nobody is bid against twice.
  const pre = buildGeoSpec(show, findCampaignType("pre-show").geo);
  const during = buildGeoSpec(show, findCampaignType("booth-traffic").geo);
  assert.ok(pre.window.runEnd <= during.window.runStart);
});

test("booth-engaged filters to the sources that mean someone stopped", () => {
  const type = findCampaignType("booth-engaged");
  assert.deepEqual(type.list.sources, ["booth_tablet", "badge_scan"]);
});

test("the lookalike seed is pooled and keeps one fixed name", () => {
  const type = findCampaignType("lookalike-seed");
  assert.equal(type.pooled, true);
  // Pooled means it spans every show — a per-show name would be a lie, and
  // creating one per show is what puts you under the platform floors.
  assert.equal(audienceNameFor(type, show), "Trade Show Universe");
});

test("per-show types are named after the show", () => {
  assert.equal(
    audienceNameFor(findCampaignType("post-show-retarget"), show),
    "SEMA 2026 — Post-show retargeting"
  );
});

test("an unknown type lists the valid ones rather than failing silently", () => {
  assert.throws(() => findCampaignType("nope"), /Valid: pre-show/);
});
