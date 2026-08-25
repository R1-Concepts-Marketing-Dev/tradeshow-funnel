// Tests for the check that decides whether a request came from this machine.
//
// This is the guard that stops the tool being usable by strangers when someone
// tunnels it without setting a gate. It is the difference between "a colleague
// can see the tool" and "anyone on the internet can write to our HubSpot".
//
// If one of these fails, something is genuinely wrong. Do not relax it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksRemote } from "../src/auth.js";

const request = (headers) => ({ headers });

test("a request to localhost is local", () => {
  assert.equal(looksRemote(request({ host: "localhost:4477" })), false);
  assert.equal(looksRemote(request({ host: "127.0.0.1:4477" })), false);
  assert.equal(looksRemote(request({ host: "localhost" })), false);
});

test("IPv6 loopback is local, bracketed or not", () => {
  assert.equal(looksRemote(request({ host: "[::1]:4477" })), false);
  assert.equal(looksRemote(request({ host: "::1" })), false);
});

test("a missing Host header is treated as local", () => {
  // Nothing on the internet reaches an HTTP/1.1 server without a Host, and
  // treating an absent one as remote would break local health checks.
  assert.equal(looksRemote(request({})), false);
});

test("a Cloudflare quick tunnel hostname is remote", () => {
  assert.equal(looksRemote(request({ host: "quiet-fox-1234.trycloudflare.com" })), true);
});

test("any other hostname is remote", () => {
  assert.equal(looksRemote(request({ host: "tools.r1concepts.com" })), true);
  assert.equal(looksRemote(request({ host: "192.168.1.50:4477" })), true);
});

test("a Cloudflare proxy header alone is enough", () => {
  // Covers the case where cloudflared is told to rewrite Host to localhost.
  assert.equal(looksRemote(request({ host: "localhost", "cf-connecting-ip": "203.0.113.7" })), true);
});

test("a generic proxy header is enough", () => {
  assert.equal(looksRemote(request({ host: "localhost", "x-forwarded-for": "203.0.113.7" })), true);
  assert.equal(looksRemote(request({ host: "localhost", "x-forwarded-host": "example.com" })), true);
});

test("case and port do not matter", () => {
  assert.equal(looksRemote(request({ host: "LOCALHOST:4477" })), false);
  assert.equal(looksRemote(request({ host: "Evil.COM:443" })), true);
});
