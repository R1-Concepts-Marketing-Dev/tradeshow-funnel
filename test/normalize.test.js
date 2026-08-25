// Tests for the pure cleaning functions. These need no network and no HubSpot
// credentials, so they are the fastest way to check a change is safe.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmail,
  normalizePhone,
  normalizeName,
  companyDomain,
  isRoleInbox,
  normalizeRow,
} from "../src/normalize.js";

test("normalizeEmail lowercases and strips whitespace", () => {
  assert.equal(normalizeEmail("  JOHN.Smith@Brakeworld.COM "), "john.smith@brakeworld.com");
  assert.equal(normalizeEmail("a b@c.com"), "ab@c.com");
});

test("normalizeEmail rejects things that are not emails", () => {
  assert.equal(normalizeEmail("notanemail"), "");
  assert.equal(normalizeEmail("no@domain"), "");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(null), "");
});

test("isRoleInbox catches company addresses", () => {
  assert.equal(isRoleInbox("info@brakeworld.com"), true);
  assert.equal(isRoleInbox("sales@brakeworld.com"), true);
  assert.equal(isRoleInbox("john.smith@brakeworld.com"), false);
});

test("normalizePhone produces E.164 for US numbers", () => {
  assert.equal(normalizePhone("(555) 213-4477"), "+15552134477");
  assert.equal(normalizePhone("555-213-4477"), "+15552134477");
  assert.equal(normalizePhone("+1 555 213 4477"), "+15552134477");
  assert.equal(normalizePhone("15552134477"), "+15552134477");
});

test("normalizePhone returns empty rather than guessing", () => {
  // A wrong number lowers ad match rate, so we would rather have none.
  assert.equal(normalizePhone("123"), "");
  assert.equal(normalizePhone("ext. 4477"), "");
  assert.equal(normalizePhone(""), "");
});

test("normalizeName title-cases through hyphens and apostrophes", () => {
  assert.equal(normalizeName("  jOHN   o'BRIEN "), "John O'Brien");
  assert.equal(normalizeName("mary-jane watson"), "Mary-Jane Watson");
});

test("companyDomain ignores free mail hosts", () => {
  // Two people at gmail.com are not colleagues — returning a domain here
  // would cause false merges in the name+company pass.
  assert.equal(companyDomain("d.oconnor@gmail.com"), "");
  assert.equal(companyDomain("maria@fleetlineservice.com"), "fleetlineservice.com");
  assert.equal(companyDomain("https://www.brakeworld.com/about"), "brakeworld.com");
});

test("normalizeRow rejects rows with no usable identifier", () => {
  const result = normalizeRow({ firstName: "Bob", email: "notanemail" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no usable email or phone/);
});

test("normalizeRow rejects role inboxes", () => {
  const result = normalizeRow({ email: "info@brakeworld.com" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /role inbox/);
});

test("normalizeRow keeps a row that has only a phone", () => {
  const result = normalizeRow({ phone: "5558887777", firstName: "cathy" });
  assert.equal(result.ok, true);
  assert.equal(result.contact.phone, "+15558887777");
  assert.equal(result.contact.firstName, "Cathy");
});
