import test from "node:test";
import assert from "node:assert/strict";

import { findNextRun, matchesCron, parseCron } from "../src/lib/cron.js";

test("parseCron accepts standard five-field expressions", () => {
  const parsed = parseCron("*/15 9-17 * * 1-5");
  assert.equal(parsed.length, 5);
});

test("matchesCron matches expected times", () => {
  const date = new Date("2026-03-30T09:30:00");
  assert.equal(matchesCron("30 9 * * 1", date), true);
  assert.equal(matchesCron("0 9 * * 1", date), false);
});

test("findNextRun finds the next matching minute", () => {
  const fromDate = new Date("2026-03-30T09:01:00");
  const nextRun = new Date(findNextRun("*/20 * * * *", fromDate));
  assert.equal(matchesCron("*/20 * * * *", nextRun), true);
  assert.equal(nextRun > fromDate, true);
});
