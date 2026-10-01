/**
 * Timestamp-label contract shared by backup creation, the retention
 * inventory, and fixtures. Accepted labels must round-trip to the exact
 * instant they name, so normalized or impossible calendar dates are
 * rejected instead of drifting the inventory.
 */
import { describe, expect, test } from "bun:test";
import {
  formatBackupTimestampLabel,
  parseBackupTimestampLabel,
} from "../src/utils/databaseBackup.js";

describe("formatBackupTimestampLabel", () => {
  test("renders . and : as - in ISO instants", () => {
    expect(formatBackupTimestampLabel("2026-01-02T03:04:05.678Z")).toBe(
      "2026-01-02T03-04-05-678Z",
    );
  });

  test("round-trips through the parser at calendar boundaries", () => {
    for (const iso of [
      "0000-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "2024-02-29T12:34:56.789Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      expect(parseBackupTimestampLabel(formatBackupTimestampLabel(iso))).toBe(
        Date.parse(iso),
      );
    }
  });
});

describe("parseBackupTimestampLabel", () => {
  test("parses a valid label into its embedded timestamp", () => {
    expect(parseBackupTimestampLabel("2026-01-02T03-04-05-678Z")).toBe(
      Date.parse("2026-01-02T03:04:05.678Z"),
    );
  });

  test("accepts leap-day and epoch boundaries", () => {
    expect(parseBackupTimestampLabel("2024-02-29T12-34-56-789Z")).toBe(
      Date.parse("2024-02-29T12:34:56.789Z"),
    );
    expect(parseBackupTimestampLabel("1970-01-01T00-00-00-000Z")).toBe(0);
  });

  test.each([
    "2023-02-29T00-00-00-000Z",
    "2023-13-01T00-00-00-000Z",
    "2023-01-32T00-00-00-000Z",
    "2023-01-01T24-00-00-000Z",
    "2023-01-01T12-60-00-000Z",
    "2023-01-01T12-34-60-000Z",
    "2026-01-02T03-04-05-678",
    "2026-01-02T03:04:05.678Z",
    "2026-01-02T03-04-05-67Z",
    "2026-1-02T03-04-05-678Z",
    "2026-01-02t03-04-05-678z",
    "2026-01-02T03-04-05-678Z.db",
    "garbage",
    "",
  ])("rejects label %j that cannot round-trip", (label) => {
    expect(parseBackupTimestampLabel(label)).toBeNull();
  });
});
