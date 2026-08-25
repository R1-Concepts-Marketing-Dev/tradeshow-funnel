// Tests for report formatting and the Meta name tag.
//
// The pipe escaping exists because of a real bug: DFC's Meta naming convention
// is pipe-delimited, so ad names like "AD | General | Video" silently turned a
// six-column table into eight columns in the management report.

import test from "node:test";
import assert from "node:assert/strict";
import { cell, num, money, pct } from "../src/markdown.js";
import { parseTag, buildTag, suggestedNames } from "../src/metaNaming.js";

test("a pipe in a name does not break the table", () => {
  assert.equal(cell("AD | General | Video"), "AD \\| General \\| Video");
});

test("newlines are flattened, not left to split the row", () => {
  assert.equal(cell("Line one\nLine two"), "Line one Line two");
  // CRLF is two characters and must still collapse to one space.
  assert.equal(cell("Line one\r\nLine two"), "Line one Line two");
  assert.equal(cell("  padded  "), "padded");
});

test("nothing renders as an em dash rather than blank or zero", () => {
  assert.equal(cell(null), "—");
  assert.equal(cell(undefined), "—");
  assert.equal(num(null), "—");
  assert.equal(money(undefined), "—");
});

test("money always shows two places so columns line up", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(12.9), "$12.90");
  assert.equal(money(1108.286), "$1,108.29");
});

test("a percentage of nothing is an em dash, not NaN or zero", () => {
  assert.equal(pct(0, 0), "—");
  assert.equal(pct(5, 100), "5.0%");
});

test("the show tag is read out of any position in a name", () => {
  assert.deepEqual(parseTag("DFC | SEMA 2026 [tsf:sema-2026]"), {
    showId: "sema-2026",
    campaignType: null,
  });
  assert.deepEqual(parseTag("[tsf:aapex-2026/booth-traffic] whatever else"), {
    showId: "aapex-2026",
    campaignType: "booth-traffic",
  });
});

test("an untagged name reads as no tag rather than a bad guess", () => {
  assert.equal(parseTag("AS | General Shops"), null);
  assert.equal(parseTag(""), null);
  assert.equal(parseTag(null), null);
});

test("the tag round-trips through build and parse", () => {
  const tag = buildTag("sema-2026", "pre-show");
  assert.deepEqual(parseTag(`Anything ${tag} here`), {
    showId: "sema-2026",
    campaignType: "pre-show",
  });
});

test("suggested names carry a tag the parser accepts", () => {
  const show = { id: "sema-2026", name: "SEMA 2026" };
  const brand = { shortName: "DFC" };
  const lines = suggestedNames(show, brand, [{ id: "booth-traffic", name: "Booth traffic" }]);

  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = parseTag(line.name);
    assert.ok(parsed, `no tag in "${line.name}"`);
    assert.equal(parsed.showId, "sema-2026");
  }
});
