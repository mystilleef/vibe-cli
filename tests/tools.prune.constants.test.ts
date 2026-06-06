import { expect, test } from "bun:test";
import {
  DEFAULT_PRUNE_AGE_DAYS,
  DEFAULT_PRUNE_OVERLAP_THRESHOLD,
} from "../src/tools/prune";

test("DEFAULT_PRUNE_AGE_DAYS is 90", () => {
  expect(DEFAULT_PRUNE_AGE_DAYS).toBe(90);
});

test("DEFAULT_PRUNE_OVERLAP_THRESHOLD is 0.6", () => {
  expect(DEFAULT_PRUNE_OVERLAP_THRESHOLD).toBe(0.6);
});
