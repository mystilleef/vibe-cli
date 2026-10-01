/**
 * Strict parsing contract for `--keep-backups`. Only plain decimal digits
 * resolving to a positive safely representable integer pass; every form
 * `Number` would silently accept (signs, whitespace, exponents, fractions)
 * is rejected before any storage access.
 */
import { describe, expect, test } from "bun:test";
import { resolveDoctorKeepBackups } from "../src/tools/doctor.js";

describe("resolveDoctorKeepBackups", () => {
  test("defaults an omitted value to five backups", () => {
    expect(resolveDoctorKeepBackups(undefined)).toBe(5);
  });

  test.each([
    ["1", 1],
    ["5", 5],
    ["007", 7],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("accepts plain digit string %j as %d", (supplied, expected) => {
    expect(resolveDoctorKeepBackups(supplied)).toBe(expected);
  });

  test.each([
    "0",
    "-1",
    "+5",
    " 5",
    "5 ",
    "",
    "3.5",
    "1e3",
    "0x10",
    "Infinity",
    "NaN",
    "9007199254740992",
    "99999999999999999999",
  ])("rejects malformed value %j", (supplied) => {
    expect(() => resolveDoctorKeepBackups(supplied)).toThrow(
      "--keep-backups must be a positive safely representable integer",
    );
  });
});
