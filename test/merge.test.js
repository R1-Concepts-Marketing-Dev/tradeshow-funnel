// Tests for duplicate matching and field precedence.
//
// A wrong merge is the most expensive mistake this tool can make — it is hard
// to spot and hard to undo — so these are worth keeping thorough.

import test from "node:test";
import assert from "node:assert/strict";
import { groupContacts, mergeGroup, splitList } from "../src/merge.js";

const contact = (overrides) => ({
  email: "", phone: "", firstName: "", lastName: "", company: "",
  companyDomain: "", jobTitle: "", ...overrides,
});

test("same email is one person", () => {
  const { groups } = groupContacts([
    contact({ email: "a@shop.com", firstName: "Al" }),
    contact({ email: "a@shop.com", lastName: "Smith" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].contacts.length, 2);
});

test("same phone is one person even with different emails", () => {
  // Real case: the roster has their work address, the tablet has a personal one.
  const { groups } = groupContacts([
    contact({ email: "a@shop.com", phone: "+15551234567" }),
    contact({ email: "personal@gmail.com", phone: "+15551234567" }),
  ]);
  assert.equal(groups.length, 1);
});

test("different people stay separate", () => {
  const { groups } = groupContacts([
    contact({ email: "a@shop.com" }),
    contact({ email: "b@shop.com" }),
  ]);
  assert.equal(groups.length, 2);
});

test("name plus company goes to review, never auto-merges", () => {
  const { groups, review } = groupContacts([
    contact({ email: "j.smith@brakeworld.com", lastName: "Smith", companyDomain: "brakeworld.com" }),
    contact({ email: "john.s@brakeworld.com", lastName: "Smith", companyDomain: "brakeworld.com" }),
  ]);
  // Two separate groups plus a flag for a human — not a silent merge.
  assert.equal(groups.length, 2);
  assert.equal(review.length, 1);
  assert.match(review[0].reason, /confirm before merging/);
});

test("a flagged contact is still written, never dropped", () => {
  const { groups, review } = groupContacts([
    contact({ email: "j.smith@brakeworld.com", lastName: "Smith", companyDomain: "brakeworld.com" }),
    contact({ email: "john.s@brakeworld.com", lastName: "Smith", companyDomain: "brakeworld.com" }),
  ]);
  const emails = groups.flatMap((group) => group.contacts.map((c) => c.email)).sort();
  assert.deepEqual(emails, ["j.smith@brakeworld.com", "john.s@brakeworld.com"]);
  assert.equal(review.length, 1);
});

test("two people at gmail with the same surname do not merge", () => {
  // companyDomain returns "" for free mail, so the name+company pass cannot fire.
  const { groups, review } = groupContacts([
    contact({ email: "j.smith@gmail.com", lastName: "Smith", companyDomain: "" }),
    contact({ email: "a.smith@gmail.com", lastName: "Smith", companyDomain: "" }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(review.length, 0);
});

test("tablet wins on phone, roster wins on job title", () => {
  const merged = mergeGroup([
    contact({ email: "a@shop.com", phone: "+15550000001", jobTitle: "Guy", ts_sources: "booth_tablet" }),
    contact({ email: "a@shop.com", phone: "+15550000002", jobTitle: "Parts Manager", ts_sources: "roster_pre" }),
  ]);
  assert.equal(merged.phone, "+15550000001");
  assert.equal(merged.jobTitle, "Parts Manager");
});

test("sources and events append rather than replace", () => {
  const merged = mergeGroup(
    [contact({ email: "a@shop.com", ts_sources: "booth_tablet", ts_events_attended: "sema-2026" })],
    { ts_sources: "roster_pre", ts_events_attended: "aapex-2025" }
  );
  assert.deepEqual(splitList(merged.ts_sources).sort(), ["booth_tablet", "roster_pre"]);
  assert.deepEqual(splitList(merged.ts_events_attended).sort(), ["aapex-2025", "sema-2026"]);
});

test("earliest consent timestamp wins and is never overwritten", () => {
  const merged = mergeGroup(
    [contact({ email: "a@shop.com", ts_consent_at: "2026-11-04T10:00:00Z" })],
    { ts_consent_at: "2025-03-12T09:00:00Z" }
  );
  assert.equal(merged.ts_consent_at, "2025-03-12T09:00:00Z");
});

test("an existing HubSpot value is not clobbered by a blank", () => {
  const merged = mergeGroup(
    [contact({ email: "a@shop.com", company: "" })],
    { company: "Brake World LLC" }
  );
  assert.equal(merged.company, "Brake World LLC");
});
