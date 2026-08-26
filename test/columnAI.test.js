// Tests for the masking that makes sending columns to Claude safe.
//
// These are the important tests in this repo. Everything else here is about
// getting a number right; this is about a real person's email address not
// leaving the building. If one of these fails, do not "fix" it by loosening
// the assertion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mask, profileColumns, toMapping } from "../src/columnAI.js";

test("an email is masked down to its shape", () => {
  const masked = mask("dana.whitfield@brakeworld.com");
  assert.equal(masked, "d***@b***.com");
  assert.ok(!masked.includes("whitfield"));
  assert.ok(!masked.includes("brakeworld"));
});

test("a subdomain email keeps only the tail", () => {
  assert.equal(mask("jo@mail.corp.co.uk"), "j***@m***.corp.co.uk");
});

test("a phone number keeps only its length and last two digits", () => {
  assert.equal(mask("(702) 555-0184"), "########84");
  assert.equal(mask("+1 702 555 0184"), "#########84"); // 11 digits, so 9 hidden
});

test("a name is reduced to initials and lengths", () => {
  const masked = mask("Dana Whitfield");
  assert.equal(masked, "D*** W****");
  assert.ok(!/anaidhitfiel/i.test(masked.replace(/\*/g, "")));
});

test("a long free-text value cannot smuggle a whole value through", () => {
  const masked = mask("Whitfield Brake & Alignment of Southern Nevada LLC");
  // At most four words survive, each as one letter plus up to four stars.
  assert.ok(masked.split(" ").length <= 4);
  assert.ok(!masked.includes("Nevada"));
});

test("a URL is not sent at all", () => {
  assert.equal(mask("https://brakeworld.com/dana?ref=sema"), "https://***");
});

test("empty stays empty rather than becoming a star", () => {
  assert.equal(mask(""), "");
  assert.equal(mask(null), "");
  assert.equal(mask(undefined), "");
});

test("nothing recognisable survives profiling a table", () => {
  const rows = [
    { "Badge Email": "dana.whitfield@brakeworld.com", Cell: "702-555-0184", Shop: "Whitfield Brake" },
    { "Badge Email": "marco@apexauto.net", Cell: "702-555-0199", Shop: "Apex Auto" },
  ];
  const profile = profileColumns(["Badge Email", "Cell", "Shop"], rows);
  const sent = JSON.stringify(profile);

  for (const secret of ["whitfield", "brakeworld", "5550184", "555-0184", "marco", "apexauto"]) {
    assert.ok(!sent.toLowerCase().includes(secret), `"${secret}" leaked into the payload`);
  }
});

test("profiling still describes the columns well enough to map them", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    "Badge Email": `person${i}@shop${i}.com`,
    Cell: `70255501${String(i).padStart(2, "0")}`,
    Notes: i % 4 === 0 ? "vip" : "",
  }));
  const [email, cell, notes] = profileColumns(["Badge Email", "Cell", "Notes"], rows);

  assert.equal(email.looksLike.email, 100);
  assert.equal(cell.looksLike.phoneish, 100);
  // The mostly-empty column is visibly mostly empty, which is the signal that
  // stops it being mapped to something it is not.
  assert.equal(notes.filledPercent, 25);
});

test("only three examples per column ever leave", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ Email: `p${i}@x.com` }));
  const [column] = profileColumns(["Email"], rows);
  assert.equal(column.examples.length, 3);
});

// ---------------------------------------------------------------------------
// Turning Claude's answer into a mapping we will actually import with
// ---------------------------------------------------------------------------

test("a header Claude invented is discarded, not mapped to nothing", () => {
  // The failure this prevents: email maps to a column that does not exist, the
  // import runs, every row is rejected for having no email, and the counts look
  // plausible enough that nobody checks.
  const mapping = toMapping(
    [
      { field: "email", header: "Badge Email" },
      { field: "phone", header: "Mobile Number" }, // not in the file
    ],
    ["Badge Email", "Cell"]
  );
  assert.deepEqual(mapping, { email: "Badge Email" });
});

test("one column cannot feed two fields", () => {
  const mapping = toMapping(
    [
      { field: "email", header: "Contact" },
      { field: "phone", header: "Contact" },
    ],
    ["Contact"]
  );
  assert.deepEqual(mapping, { email: "Contact" });
});

test("the first claim on a field wins", () => {
  const mapping = toMapping(
    [
      { field: "email", header: "Work Email" },
      { field: "email", header: "Personal Email" },
    ],
    ["Work Email", "Personal Email"]
  );
  assert.deepEqual(mapping, { email: "Work Email" });
});

test("malformed entries are skipped rather than throwing", () => {
  const mapping = toMapping(
    [null, {}, { field: "email" }, { header: "Cell" }, { field: "phone", header: "Cell" }],
    ["Cell"]
  );
  assert.deepEqual(mapping, { phone: "Cell" });
});

test("no answer at all gives an empty mapping, not a crash", () => {
  assert.deepEqual(toMapping(undefined, ["Email"]), {});
  assert.deepEqual(toMapping([], ["Email"]), {});
});
