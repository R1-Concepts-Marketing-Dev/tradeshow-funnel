// Tests for brand separation.
//
// R1 and DFC share a HubSpot portal but not their audiences. These tests guard
// the places where the two could leak into each other.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrand, requireBrand, brandLabel, DEFAULT_BRANDS } from "../src/brands.js";
import { buildFilterBranch } from "../src/audiences.js";
import { dedupeKey } from "../src/ingest.js";

test("brands resolve by id, short name, or full name", () => {
  assert.equal(resolveBrand("dfc").id, "dfc");
  assert.equal(resolveBrand("DFC").id, "dfc");
  assert.equal(resolveBrand("Dynamic Friction Company").id, "dfc");
  assert.equal(resolveBrand("R1").id, "r1");
  assert.equal(resolveBrand("nope"), null);
});

test("requireBrand refuses to guess, and lists the options", () => {
  assert.throws(() => requireBrand(""), /A brand is required/);
  assert.throws(() => requireBrand("hartbrakes"), /Unknown brand.*r1.*dfc/s);
});

test("the dedupe key is brand-scoped", () => {
  // The same person can be an R1 contact and a DFC contact. Sharing one key
  // would merge two brands' consent and engagement history onto one record.
  const contact = { email: "a@shop.com", phone: "" };
  assert.notEqual(dedupeKey(contact, "r1"), dedupeKey(contact, "dfc"));
  assert.match(dedupeKey(contact, "dfc"), /^tsf:dfc:a@shop\.com$/);
});

test("every list audience filters on brand first", () => {
  const branch = buildFilterBranch({ brand: "dfc", shows: ["sema-2026"] });
  assert.equal(branch.filters[0].property, "ts_brand");
  assert.deepEqual(branch.filters[0].operation.values, ["dfc"]);
});

test("an audience with no brand builds no brand filter", () => {
  // Guards against a silent all-brands list if brand is ever dropped upstream.
  const branch = buildFilterBranch({ shows: ["sema-2026"] });
  assert.ok(!branch.filters.some((f) => f.property === "ts_brand"));
});

test("brandLabel falls back to the raw id rather than throwing", () => {
  assert.equal(brandLabel("dfc"), "DFC");
  assert.equal(brandLabel("unknown-brand"), "unknown-brand");
  assert.equal(brandLabel(null), "—");
});

test("the default brands match the Paid Media Console", () => {
  // The two tools are meant to read as one suite; these ids and colours are
  // duplicated in paid-media-console/src/data/catalog.ts.
  assert.deepEqual(DEFAULT_BRANDS.map((b) => b.id), ["r1", "dfc"]);
  assert.equal(DEFAULT_BRANDS[0].accent, "#c8102e");
  assert.equal(DEFAULT_BRANDS[1].accent, "#ef6c1a");
});
