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

// ---------------------------------------------------------------------------
// Transparency
//
// Local writes are allowed in test mode. The deal is that they are always
// visibly a test. These lock that half of the bargain — every surface that
// shows registry data must mark a test entry.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Runs a tsf command against a throwaway registry. */
function tsf(args, { testMode = false, dataDir } = {}) {
  return execFileSync(process.execPath, [path.join(ROOT, "bin", "tsf.js"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TSF_DATA_DIR: dataDir,
      TSF_TEST_MODE: testMode ? "true" : "false",
      TSF_ACTOR: "test-runner",
    },
  });
}

function scratchRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsf-test-"));
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });
  fs.mkdirSync(path.join(dir, "audiences"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shows.json"), "[]");
  return dir;
}

test("a test-mode entry is stamped and a real one is not", () => {
  const dir = scratchRegistry();
  try {
    tsf(["show", "add", "--name", "Probe A", "--start", "2026-01-01", "--end", "2026-01-02"], {
      testMode: true,
      dataDir: dir,
    });
    tsf(["show", "add", "--name", "Probe B", "--start", "2026-01-01", "--end", "2026-01-02"], {
      testMode: false,
      dataDir: dir,
    });

    const log = fs
      .readdirSync(path.join(dir, "history"))
      .flatMap((f) => fs.readFileSync(path.join(dir, "history", f), "utf8").split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const a = log.find((e) => e.showName === "Probe A");
    const b = log.find((e) => e.showName === "Probe B");

    assert.equal(a.testMode, true, "the test run must be stamped");
    assert.equal(b.testMode, undefined, "a real run must carry no stamp at all");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("`tsf history` marks the test entry and only the test entry", () => {
  const dir = scratchRegistry();
  try {
    tsf(["show", "add", "--name", "Probe A", "--start", "2026-01-01", "--end", "2026-01-02"], {
      testMode: true,
      dataDir: dir,
    });
    tsf(["show", "add", "--name", "Probe B", "--start", "2026-01-01", "--end", "2026-01-02"], {
      testMode: false,
      dataDir: dir,
    });

    const out = tsf(["history"], { dataDir: dir });
    const lines = out.split("\n").filter((l) => l.includes("Probe"));

    assert.ok(
      lines.find((l) => l.includes("Probe A")).includes("[TEST]"),
      "the test run must be marked"
    );
    assert.ok(
      !lines.find((l) => l.includes("Probe B")).includes("[TEST]"),
      "a real run must not be marked"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AUDIENCES.md marks a test run everywhere it appears", () => {
  const dir = scratchRegistry();
  try {
    tsf(["show", "add", "--name", "Probe A", "--start", "2026-01-01", "--end", "2026-01-02"], {
      testMode: true,
      dataDir: dir,
    });
    tsf(["show", "add", "--name", "Probe B", "--start", "2026-01-01", "--end", "2026-01-02"], {
      testMode: false,
      dataDir: dir,
    });
    tsf(["report"], { dataDir: dir });

    const report = fs.readFileSync(path.join(dir, "AUDIENCES.md"), "utf8");
    const lines = report.split("\n");

    // "Probe A" appears twice — the shows table and the activity log. Checking
    // only the first would have passed while the other row lied, which is
    // exactly what happened when this test was first written.
    const testRows = lines.filter((l) => l.includes("Probe A"));
    assert.ok(testRows.length >= 2, "expected both the show row and the activity row");
    for (const row of testRows) {
      assert.match(row, /\[TEST/, `not marked as a test: ${row.trim()}`);
    }

    // And the contrast: a real run must carry no marker anywhere.
    for (const row of lines.filter((l) => l.includes("Probe B"))) {
      assert.doesNotMatch(row, /\[TEST/, `wrongly marked as a test: ${row.trim()}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
