// Tests for the ad-platform file formats.
//
// The failure these guard against is not a crash. It is an upload that Google
// or Meta accepts happily and then matches 3% of, because the country column
// said "United States" instead of "US" or a phone was missing its country code.
// Nobody notices for a month.
//
// The expected values here come from each platform's published spec, checked
// 2026-08-26. If a platform changes its rules, change the test and the table in
// src/adPlatforms.js together.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRows,
  countryCode,
  e164,
  googleEmail,
  metaCity,
  metaName,
  plainEmail,
  postalCode,
  sha256,
  stateCode,
  toCsv,
  PLATFORMS,
} from "../src/adPlatforms.js";

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

test("email is lowercased and trimmed", () => {
  assert.equal(plainEmail("  Dana@BrakeWorld.com "), "dana@brakeworld.com");
});

test("Google strips dots from gmail addresses, and only gmail", () => {
  assert.equal(googleEmail("bob.smith@gmail.com"), "bobsmith@gmail.com");
  assert.equal(googleEmail("bob.smith@googlemail.com"), "bobsmith@googlemail.com");
  // A dot is significant everywhere else — removing it would break the match.
  assert.equal(googleEmail("bob.smith@brakeworld.com"), "bob.smith@brakeworld.com");
});

test("US phones become E.164 with or without the country code", () => {
  assert.equal(e164("(702) 555-0184"), "+17025550184");
  assert.equal(e164("702.555.0184"), "+17025550184");
  assert.equal(e164("1-702-555-0184"), "+17025550184");
  assert.equal(e164("+1 702 555 0184"), "+17025550184");
});

test("an unusable phone becomes empty rather than a guess", () => {
  // Seven digits could be a local number in any country. Guessing +1 would
  // put someone else's phone in the file.
  assert.equal(e164("555-0184"), "");
  assert.equal(e164("ext. 4471"), "");
  assert.equal(e164(""), "");
  assert.equal(e164("n/a"), "");
});

test("an already-international number keeps its own country code", () => {
  assert.equal(e164("+44 20 7946 0958"), "+442079460958");
});

test("Meta names are stripped to a-z", () => {
  assert.equal(metaName("O'Brien"), "obrien");
  assert.equal(metaName("Jean-Luc"), "jeanluc");
  assert.equal(metaName("José"), "jose");
  assert.equal(metaName("  Dana  "), "dana");
});

test("Meta city drops spaces and punctuation", () => {
  assert.equal(metaCity("Las Vegas"), "lasvegas");
  assert.equal(metaCity("St. Louis"), "stlouis");
});

test("country becomes an ISO alpha-2 code", () => {
  assert.equal(countryCode("United States"), "US");
  assert.equal(countryCode("USA"), "US");
  assert.equal(countryCode("U.S.A."), "US");
  assert.equal(countryCode("us"), "US");
  assert.equal(countryCode("Canada"), "CA");
});

test("an unrecognisable country is left empty, not passed through", () => {
  // "North America" in the country column would be rejected or ignored;
  // an empty cell at least does not poison the row.
  assert.equal(countryCode("North America"), "");
  assert.equal(countryCode(""), "");
});

test("US zips are cut to five digits, others are not", () => {
  assert.equal(postalCode("89014-2231", { style: "us5", country: "US" }), "89014");
  assert.equal(postalCode("89014", { style: "us5", country: "US" }), "89014");
  // Leading zeros are real. 01234 is Massachusetts.
  assert.equal(postalCode("01234", { style: "us5", country: "US" }), "01234");
  // A Canadian code truncated to five characters is meaningless.
  assert.equal(postalCode("K1A 0B1", { style: "us5", country: "CA" }), "K1A 0B1");
});

test("state names become two-letter codes", () => {
  assert.equal(stateCode("Nevada"), "nv");
  assert.equal(stateCode("NV"), "nv");
  assert.equal(stateCode("N.V."), "nv");
  assert.equal(stateCode("Nowhere"), "");
});

test("sha256 matches the standard test vector", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hashing an empty value gives an empty cell, not a hash of nothing", () => {
  // A hash of "" is a real 64-character string, and a column full of the same
  // one tells the platform that thousands of people share an identifier.
  assert.equal(sha256(""), "");
  assert.equal(sha256(null), "");
});

// ---------------------------------------------------------------------------
// Whole files
// ---------------------------------------------------------------------------

const CONTACT = {
  email: "Dana.Whitfield@BrakeWorld.com",
  phone: "(702) 555-0184",
  firstName: "Dana",
  lastName: "O'Brien",
  company: "Whitfield Brake, Inc.",
  jobTitle: "Owner",
  city: "Las Vegas",
  state: "Nevada",
  zip: "89014-2231",
  country: "United States",
};

test("Google's file uses Google's headers and rules", () => {
  const { headers, rows } = buildRows([CONTACT], "google-ads");
  assert.deepEqual(headers, ["Email", "Phone", "First Name", "Last Name", "Country", "Zip"]);
  assert.deepEqual(rows[0], [
    "dana.whitfield@brakeworld.com",
    "+17025550184",
    "dana",
    "o'brien", // Google does not ask for punctuation to be stripped
    "US", // uppercase
    "89014",
  ]);
});

test("Meta's file uses Meta's headers and rules", () => {
  const { headers, rows } = buildRows([CONTACT], "meta");
  assert.deepEqual(headers, ["email", "phone", "fn", "ln", "ct", "st", "zip", "country"]);
  assert.deepEqual(rows[0], [
    "dana.whitfield@brakeworld.com",
    "+17025550184",
    "dana",
    "obrien", // stripped, unlike Google
    "lasvegas",
    "nv",
    "89014",
    "us", // lowercase, unlike Google
  ]);
});

test("the two platforms really do disagree about country case", () => {
  // This is the exact class of mistake the table exists to prevent, so it is
  // asserted directly rather than left implied by the two tests above.
  const google = buildRows([CONTACT], "google-ads").rows[0];
  const meta = buildRows([CONTACT], "meta").rows[0];
  assert.equal(google[4], "US");
  assert.equal(meta[7], "us");
});

test("hashing covers the right columns and leaves the rest alone", () => {
  const { headers, rows } = buildRows([CONTACT], "google-ads", { hash: true });
  const at = (name) => rows[0][headers.indexOf(name)];

  assert.match(at("Email"), /^[a-f0-9]{64}$/);
  assert.match(at("Phone"), /^[a-f0-9]{64}$/);
  assert.match(at("First Name"), /^[a-f0-9]{64}$/);
  // Google is explicit: country and zip are matched in the clear.
  assert.equal(at("Country"), "US");
  assert.equal(at("Zip"), "89014");
});

test("the hash is of the normalised value, not the raw one", () => {
  // Hashing before normalising is the classic way to get a 0% match rate.
  const { rows } = buildRows([CONTACT], "google-ads", { hash: true });
  assert.equal(rows[0][0], sha256("dana.whitfield@brakeworld.com"));
  assert.notEqual(rows[0][0], sha256("Dana.Whitfield@BrakeWorld.com"));
});

test("Meta hashes city, state, zip and country too", () => {
  const { headers, rows } = buildRows([CONTACT], "meta", { hash: true });
  for (const column of ["ct", "st", "zip", "country"]) {
    assert.match(rows[0][headers.indexOf(column)], /^[a-f0-9]{64}$/, `${column} should be hashed`);
  }
});

test("a contact with no usable identifier is left out and counted", () => {
  const { rows, skipped } = buildRows(
    [{ firstName: "Nobody", lastName: "Here", city: "Reno" }],
    "google-ads"
  );
  assert.equal(rows.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no /);
});

test("a phone-only contact is fine for Google and Meta", () => {
  assert.equal(buildRows([{ phone: "702-555-0184" }], "google-ads").rows.length, 1);
  assert.equal(buildRows([{ phone: "702-555-0184" }], "meta").rows.length, 1);
});

test("a phone-only contact is not fine for LinkedIn, which matches on email", () => {
  const { rows, skipped } = buildRows([{ phone: "702-555-0184" }], "linkedin");
  assert.equal(rows.length, 0);
  assert.equal(skipped.length, 1);
});

test("the same person across two shows appears once", () => {
  const { rows, skipped } = buildRows(
    [CONTACT, { ...CONTACT, email: "DANA.WHITFIELD@brakeworld.com" }],
    "google-ads"
  );
  assert.equal(rows.length, 1);
  assert.equal(skipped[0].reason, "already in this file");
});

test("every platform declares a floor and produces its own headers", () => {
  for (const [id, platform] of Object.entries(PLATFORMS)) {
    assert.ok(platform.minRows > 0, `${id} needs a minRows`);
    assert.ok(platform.columns.length > 0, `${id} needs columns`);
    assert.ok(platform.identifiers.length > 0, `${id} needs identifiers`);
    const { headers } = buildRows([CONTACT], id);
    assert.equal(headers.length, platform.columns.length);
  }
});

test("an unknown platform fails loudly and lists the real ones", () => {
  assert.throws(() => buildRows([CONTACT], "snapchat"), /snapchat.*google-ads/s);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test("commas and quotes in a company name do not break the file", () => {
  const csv = toCsv(["a", "b"], [["Whitfield Brake, Inc.", 'He said "hi"']]);
  assert.equal(csv, 'a,b\r\n"Whitfield Brake, Inc.","He said ""hi"""\r\n');
});

test("the file ends with a newline and uses CRLF", () => {
  const csv = toCsv(["Email"], [["a@b.com"]]);
  assert.equal(csv, "Email\r\na@b.com\r\n");
});

test("a US zip that lost its leading zero gets it back", () => {
  // Not hypothetical: 14% of the zips in the live HubSpot portal are stored
  // like this, having been through a spreadsheet that treated them as numbers.
  // A US zip is always five digits, so padding is safe.
  assert.equal(postalCode("8052", { style: "us5", country: "US" }), "08052");
  assert.equal(postalCode("2151", { style: "us5", country: "US" }), "02151");
  assert.equal(postalCode("501", { style: "us5", country: "US" }), "00501");
});

test("padding never happens to a non-US postal code", () => {
  // Length carries no guarantee outside the US, so a short code stays short.
  assert.equal(postalCode("1234", { style: "us5", country: "CA" }), "1234");
  assert.equal(postalCode("W1A", { style: "us5", country: "GB" }), "W1A");
});

test("a zip with letters is left alone rather than mangled into digits", () => {
  assert.equal(postalCode("K1A 0B1", { style: "us5", country: "US" }), "K1A 0B1");
});
