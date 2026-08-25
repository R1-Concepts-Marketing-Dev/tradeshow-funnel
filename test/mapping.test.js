// Tests for column guessing and for reading messy files.
//
// A missed email column is the worst silent failure in this tool: the file
// imports, the counts look plausible, and the audience is empty. These tests
// exist because that already happened once during the build.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guessMapping } from "../src/ingest.js";
import { readTableFile, isSupported } from "../src/readfile.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("exact header names map", () => {
  const m = guessMapping(["Email", "First Name", "Last Name", "Company", "Phone"]);
  assert.equal(m.email, "Email");
  assert.equal(m.firstName, "First Name");
  assert.equal(m.company, "Company");
});

test("headers that merely contain the word still map", () => {
  // The real regression: "Badge Email" imported as no email at all.
  const m = guessMapping(["Badge Email", "Given Name", "Family Name", "Organization", "Cell"]);
  assert.equal(m.email, "Badge Email");
  assert.equal(m.firstName, "Given Name");
  assert.equal(m.lastName, "Family Name");
  assert.equal(m.company, "Organization");
  assert.equal(m.phone, "Cell");
});

test("an opt-out column is never mistaken for the email column", () => {
  const m = guessMapping(["Email Opt Out", "Registrant Email"]);
  assert.equal(m.email, "Registrant Email");
});

test("consent and unsubscribe columns are left alone", () => {
  const m = guessMapping(["Email Consent", "Unsubscribed From Email"]);
  assert.equal(m.email, undefined);
});

test("the plainest header wins when several could match", () => {
  const m = guessMapping(["Email Address Confirmed At", "Email", "Secondary Email"]);
  assert.equal(m.email, "Email");
});

test("one header is never mapped to two fields", () => {
  const m = guessMapping(["Contact", "Company Name"]);
  const used = Object.values(m);
  assert.equal(used.length, new Set(used).size);
});

test("a saved profile beats the guess", () => {
  const m = guessMapping(["Email", "Weird Column"], { email: "Weird Column" });
  assert.equal(m.email, "Weird Column");
});

test("reads a workbook, picks the right sheet, skips the junk rows", () => {
  // The fixture has three sheets and four rows of letterhead above the header,
  // which is what organizer exports actually look like.
  const t = readTableFile(path.join(fixtures, "ugly-roster.xlsx"));
  assert.equal(t.sheetName, "Lead Detail");
  assert.equal(t.headerIndex, 4);
  assert.deepEqual(t.headers, ["Attendee Email", "First Name", "Last Name", "Company", "Mobile"]);
  assert.equal(t.rows.length, 4); // the blank row in the middle is dropped
  assert.equal(t.rows[0]["Attendee Email"], "a.rivera@torqueautoworks.com");
});

test("a phone number keeps its leading zero", () => {
  // Excel would happily turn 0455... into a number and eat the zero.
  const t = readTableFile(path.join(fixtures, "ugly-roster.xlsx"));
  assert.equal(typeof t.rows[0].Mobile, "string");
});

test("supported extensions cover what organizers send", () => {
  assert.ok(isSupported("roster.xlsx"));
  assert.ok(isSupported("roster.CSV"));
  assert.ok(!isSupported("roster.pdf"));
});
