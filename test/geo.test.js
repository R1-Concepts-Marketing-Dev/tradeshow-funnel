// Tests for the geo targeting window and spec. No network — geocode() is the
// only function here that calls out, and it is not tested.

import test from "node:test";
import assert from "node:assert/strict";
import { shiftDate, daysBetween, buildGeoSpec, DEFAULT_RINGS } from "../src/geo.js";

const show = {
  id: "sema-2026",
  name: "SEMA 2026",
  startDate: "2026-11-03",
  endDate: "2026-11-06",
  venue: { name: "Las Vegas Convention Center", lat: 36.1310204, lng: -115.1501804 },
};

test("shiftDate moves across month boundaries", () => {
  assert.equal(shiftDate("2026-11-03", -2), "2026-11-01");
  assert.equal(shiftDate("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
});

test("daysBetween is inclusive of both ends", () => {
  assert.equal(daysBetween("2026-11-01", "2026-11-07"), 7);
  assert.equal(daysBetween("2026-11-03", "2026-11-03"), 1);
});

test("the run window is wider than the show — attendees arrive early", () => {
  const spec = buildGeoSpec(show);
  assert.equal(spec.window.showStart, "2026-11-03");
  assert.equal(spec.window.runStart, "2026-11-01"); // 2 lead days
  assert.equal(spec.window.runEnd, "2026-11-07");   // 1 lag day
  assert.equal(spec.window.totalDays, 7);
});

test("lead and lag days can be overridden", () => {
  const spec = buildGeoSpec(show, { leadDays: 0, lagDays: 0 });
  assert.equal(spec.window.runStart, "2026-11-03");
  assert.equal(spec.window.runEnd, "2026-11-06");
  assert.equal(spec.window.totalDays, 4);
});

test("rings carry both miles and kilometres", () => {
  const spec = buildGeoSpec(show);
  assert.equal(spec.rings.length, DEFAULT_RINGS.length);
  const venueRing = spec.rings.find((ring) => ring.name === "venue");
  assert.equal(venueRing.radiusMiles, 2);
  assert.equal(venueRing.radiusKm, 3.2);
});

test("a show with no venue gives an actionable error", () => {
  assert.throws(
    () => buildGeoSpec({ ...show, venue: null }),
    /tsf show research --id sema-2026/
  );
});
