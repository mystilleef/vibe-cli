import { describe, expect, test } from "bun:test";
import {
  extractErrorMessage,
  isEnoent,
  makeErrno,
} from "../src/utils/errors.js";

describe("extractErrorMessage", () => {
  test("extracts message from Error instance", () => {
    expect(extractErrorMessage(new Error("something broke"))).toBe(
      "something broke",
    );
  });

  test("extracts message from TypeError", () => {
    expect(extractErrorMessage(new TypeError("invalid type"))).toBe(
      "invalid type",
    );
  });

  test("extracts message from Error subclass with custom name", () => {
    const err = new Error("custom");
    err.name = "CustomError";
    expect(extractErrorMessage(err)).toBe("custom");
  });

  test("converts non-Error string to string", () => {
    expect(extractErrorMessage("plain string")).toBe("plain string");
  });

  test("converts non-Error number to string", () => {
    expect(extractErrorMessage(42)).toBe("42");
  });

  test("converts null to string", () => {
    expect(extractErrorMessage(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });

  test("converts object without message to string", () => {
    expect(extractErrorMessage({ code: "ENOENT" })).toBe("[object Object]");
  });
});

describe("isEnoent", () => {
  test("returns true for ENOENT ErrnoException", () => {
    const err = new Error("file not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    expect(isEnoent(err)).toBe(true);
  });

  test("returns false for non-ENOENT code", () => {
    const err = new Error("permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    expect(isEnoent(err)).toBe(false);
  });

  test("returns false for Error without code", () => {
    expect(isEnoent(new Error("generic"))).toBe(false);
  });

  test("returns false for non-Error values that have a code property", () => {
    expect(isEnoent("ENOENT")).toBe(false);
    expect(isEnoent(42)).toBe(false);
  });

  test("returns true for any object with code 'ENOENT' (cast is compile-time only)", () => {
    // The `as NodeJS.ErrnoException` cast is compile-time only; at runtime
    // any object with a `.code` of "ENOENT" passes.
    expect(isEnoent({ code: "ENOENT" })).toBe(true);
  });

  test("returns false for plain object with different code", () => {
    expect(isEnoent({ code: "EACCES" })).toBe(false);
  });

  test("throws TypeError for null input", () => {
    expect(() => isEnoent(null)).toThrow(TypeError);
  });

  test("throws TypeError for undefined input", () => {
    expect(() => isEnoent(undefined)).toThrow(TypeError);
  });
});

describe("makeErrno", () => {
  test("creates ErrnoException with given code and message", () => {
    const err = makeErrno("ENOENT", "file not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ENOENT");
    expect(err.message).toBe("file not found");
  });

  test("creates ErrnoException with EACCES code", () => {
    const err = makeErrno("EACCES", "permission denied");
    expect(err.code).toBe("EACCES");
    expect(err.message).toBe("permission denied");
  });

  test("creates ErrnoException with EBUSY code", () => {
    const err = makeErrno("EBUSY", "resource busy");
    expect(err.code).toBe("EBUSY");
    expect(err.message).toBe("resource busy");
  });

  test("creates ErrnoException with EIO code", () => {
    const err = makeErrno("EIO", "i/o error");
    expect(err.code).toBe("EIO");
    expect(err.message).toBe("i/o error");
  });

  test("result passes isEnoent when code is ENOENT", () => {
    const err = makeErrno("ENOENT", "not found");
    expect(isEnoent(err)).toBe(true);
  });

  test("result fails isEnoent for non-ENOENT code", () => {
    expect(isEnoent(makeErrno("EACCES", "denied"))).toBe(false);
  });
});
