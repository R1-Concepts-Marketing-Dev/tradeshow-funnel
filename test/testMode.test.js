// Tests for the classifier that decides what test mode refuses.
//
// The dangerous direction is a write mistaken for a read: that writes to the
// live portal while someone believes nothing can. The allowlist exists so the
// default for anything unrecognised is "refuse".

import { test } from "node:test";
import assert from "node:assert/strict";
import { isWrite } from "../src/hubspot.js";

test("GET is never a write", () => {
  assert.equal(isWrite("GET", "/crm/v3/lists/12"), false);
  assert.equal(isWrite("GET", "/marketing/v3/forms?limit=100"), false);
});

test("the POSTs that only read are recognised", () => {
  // Blocking these would break every preview and every export.
  assert.equal(isWrite("POST", "/crm/v3/objects/contacts/search"), false);
  assert.equal(isWrite("POST", "/crm/v3/objects/contacts/batch/read"), false);
  assert.equal(isWrite("POST", "/crm/v3/lists/search"), false);
});

test("the POSTs that change things are writes", () => {
  assert.equal(isWrite("POST", "/crm/v3/objects/contacts/batch/upsert"), true);
  assert.equal(isWrite("POST", "/crm/v3/lists"), true);
  assert.equal(isWrite("POST", "/crm/v3/lists/12/memberships/add"), true);
  assert.equal(isWrite("POST", "/crm/v3/properties/contacts"), true);
});

test("PATCH, PUT and DELETE are always writes", () => {
  assert.equal(isWrite("PATCH", "/crm/v3/properties/contacts/ts_events_attended"), true);
  assert.equal(isWrite("PUT", "/anything"), true);
  assert.equal(isWrite("DELETE", "/anything"), true);
});

test("an endpoint nobody has classified is treated as a write", () => {
  // The whole point of an allowlist. A new endpoint is refused in test mode
  // until a person has looked at it, rather than silently permitted.
  assert.equal(isWrite("POST", "/crm/v3/objects/contacts/merge"), true);
  assert.equal(isWrite("POST", "/crm/v4/something-invented-later"), true);
});

test("a write path that merely contains the word search is still a write", () => {
  // "/lists/search" reads; "/lists/search-index/rebuild" would not.
  assert.equal(isWrite("POST", "/crm/v3/lists/search-index/rebuild"), true);
});
