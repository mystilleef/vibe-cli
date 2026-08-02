import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import {
  getPathAncestorsAndSelf,
  handleSymlinkStatError,
  type RejectSymlinkOptions,
  rejectSymlinkPathComponents,
  rejectSymlinkPathComponentsSync,
  throwIfSymlink,
} from "../src/utils/pathValidation";

// ── Error class for testing ──────────────────────────────────────────
class TestSymlinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestSymlinkError";
  }
}

function makeOpts(
  overrides: Partial<RejectSymlinkOptions> = {},
): RejectSymlinkOptions {
  return {
    destPath: `${sep}dest${sep}path`,
    targetRoot: `${sep}target${sep}root`,
    errorClass: TestSymlinkError,
    ...overrides,
  };
}

// ── getPathAncestorsAndSelf ──────────────────────────────────────────

describe("getPathAncestorsAndSelf", () => {
  test("returns root only when absPath is root", () => {
    const result = getPathAncestorsAndSelf("/");
    expect(result).toEqual(["/"]);
  });

  test("returns all ancestors for a multi-segment path", () => {
    const result = getPathAncestorsAndSelf(
      ["", "home", "user", "projects", "vibe-cli"].join(sep),
    );
    expect(result).toEqual([
      `${sep}home`,
      sep + ["home", "user"].join(sep),
      sep + ["home", "user", "projects"].join(sep),
      sep + ["home", "user", "projects", "vibe-cli"].join(sep),
    ]);
  });

  test("returns single ancestor for one-segment path", () => {
    const result = getPathAncestorsAndSelf(`${sep}home`);
    expect(result).toEqual([`${sep}home`]);
  });

  test("filters empty segments from relative path", () => {
    // path with trailing separator: /home/user/
    const result = getPathAncestorsAndSelf(
      sep + ["home", "user", ""].join(sep),
    );
    expect(result).toEqual([`${sep}home`, sep + ["home", "user"].join(sep)]);
  });
});

// ── throwIfSymlink ───────────────────────────────────────────────────

describe("throwIfSymlink", () => {
  test("returns without throw when component is not a symlink", () => {
    const opts = makeOpts();
    // Should not throw
    throwIfSymlink(`${sep}some${sep}path`, false, opts);
  });

  test("throws with destPath message when component equals destPath", () => {
    const opts = makeOpts();
    expect(() => throwIfSymlink(opts.destPath, true, opts)).toThrow(
      "Destination is a symlink",
    );
  });

  test("throws with targetRoot message when component equals targetRoot", () => {
    const opts = makeOpts();
    expect(() => throwIfSymlink(opts.targetRoot, true, opts)).toThrow(
      "Target directory is a symlink",
    );
  });

  test("throws generic component symlink message for non-root/non-dest component", () => {
    const opts = makeOpts();
    const component = `${sep}some${sep}middle${sep}dir`;
    expect(() => throwIfSymlink(component, true, opts)).toThrow(
      `Target directory component '${component}' is a symlink`,
    );
  });
});

// ── handleSymlinkStatError ───────────────────────────────────────────

describe("handleSymlinkStatError", () => {
  test("rethrows when error is already an instance of errorClass", () => {
    const opts = makeOpts();
    const existing = new TestSymlinkError("already thrown");
    expect(() => handleSymlinkStatError(existing, `${sep}some`, opts)).toThrow(
      "already thrown",
    );
  });

  test("returns true for ENOENT error code", () => {
    const opts = makeOpts();
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(handleSymlinkStatError(err, `${sep}some`, opts)).toBe(true);
  });

  test("returns true for ENOTDIR error code", () => {
    const opts = makeOpts();
    const err = Object.assign(new Error("not a directory"), {
      code: "ENOTDIR",
    });
    expect(handleSymlinkStatError(err, `${sep}some`, opts)).toBe(true);
  });

  test("uses formatError when provided for non-recoverable stat error", () => {
    const opts = makeOpts({
      formatError: (component, targetRoot) =>
        `custom: ${component} under ${targetRoot}`,
    });
    const err = Object.assign(new Error("perm denied"), { code: "EACCES" });
    expect(() => handleSymlinkStatError(err, `${sep}some`, opts)).toThrow(
      `custom: ${sep}some under ${opts.targetRoot}`,
    );
  });

  test("throws targetRoot error when component is targetRoot and no formatError", () => {
    const opts = makeOpts();
    const err = Object.assign(new Error("stat failed"), { code: "EACCES" });
    expect(() => handleSymlinkStatError(err, opts.targetRoot, opts)).toThrow(
      `Failed to stat target directory: ${opts.targetRoot}`,
    );
  });

  test("throws destPath error when component is destPath and no formatError", () => {
    const opts = makeOpts();
    const err = Object.assign(new Error("stat failed"), { code: "EACCES" });
    expect(() => handleSymlinkStatError(err, opts.destPath, opts)).toThrow(
      `Failed to stat guide destination: ${opts.destPath}`,
    );
  });

  test("throws generic path error for unknown component without formatError", () => {
    const opts = makeOpts();
    const component = `${sep}middle`;
    const err = Object.assign(new Error("stat failed"), { code: "EACCES" });
    expect(() => handleSymlinkStatError(err, component, opts)).toThrow(
      `Failed to stat target path '${component}'`,
    );
  });

  test("throws generic path error when error has no code and no formatError", () => {
    const opts = makeOpts();
    const component = `${sep}middle`;
    const err = new Error("bare error");
    expect(() => handleSymlinkStatError(err, component, opts)).toThrow(
      `Failed to stat target path '${component}'`,
    );
  });
});

// ── rejectSymlinkPathComponents (async) ──────────────────────────────

describe("rejectSymlinkPathComponents (async)", () => {
  test("completes without throw for empty pathComponents", async () => {
    await rejectSymlinkPathComponents(
      [],
      async () => {
        throw new Error("should not be called");
      },
      makeOpts(),
    );
  });

  test("completes when no component is a symlink", async () => {
    const components = ["/a", "/a/b", "/a/b/c"];
    const statFn = async (_c: string) => ({
      isSymbolicLink: () => false,
    });
    await rejectSymlinkPathComponents(components, statFn, makeOpts());
  });

  test("throws when a component is a symlink", async () => {
    const opts = makeOpts();
    const components = [opts.destPath];
    const statFn = async (_c: string) => ({
      isSymbolicLink: () => true,
    });
    await expect(
      rejectSymlinkPathComponents(components, statFn, opts),
    ).rejects.toThrow("Destination is a symlink");
  });

  test("breaks on ENOENT and does not throw", async () => {
    const calls: string[] = [];
    const components = ["/a", "/a/b", "/a/b/c"];
    const statFn = async (c: string) => {
      calls.push(c);
      if (c === "/a/b") {
        const err = Object.assign(new Error("not found"), { code: "ENOENT" });
        throw err;
      }
      return { isSymbolicLink: () => false };
    };
    await rejectSymlinkPathComponents(components, statFn, makeOpts());
    expect(calls).toEqual(["/a", "/a/b"]);
  });

  test("throws on non-recoverable stat error", async () => {
    const opts = makeOpts();
    const components = ["/a"];
    const statFn = async (_c: string) => {
      const err = Object.assign(new Error("perm denied"), { code: "EACCES" });
      throw err;
    };
    await expect(
      rejectSymlinkPathComponents(components, statFn, opts),
    ).rejects.toThrow("Failed to stat target path");
  });

  test("rethrows errorClass instances from statFn immediately", async () => {
    const opts = makeOpts();
    const components = ["/a"];
    const statFn = async (_c: string) => {
      throw new TestSymlinkError("nested error");
    };
    await expect(
      rejectSymlinkPathComponents(components, statFn, opts),
    ).rejects.toThrow("nested error");
  });
});

// ── rejectSymlinkPathComponentsSync ──────────────────────────────────

describe("rejectSymlinkPathComponentsSync", () => {
  test("completes without throw for empty pathComponents", () => {
    rejectSymlinkPathComponentsSync(
      [],
      () => {
        throw new Error("should not be called");
      },
      makeOpts(),
    );
  });

  test("completes when no component is a symlink", () => {
    const components = ["/a", "/a/b", "/a/b/c"];
    const statFn = (_c: string) => ({
      isSymbolicLink: () => false,
    });
    rejectSymlinkPathComponentsSync(components, statFn, makeOpts());
  });

  test("throws when a component is a symlink", () => {
    const opts = makeOpts();
    const components = [opts.targetRoot];
    const statFn = (_c: string) => ({
      isSymbolicLink: () => true,
    });
    expect(() =>
      rejectSymlinkPathComponentsSync(components, statFn, opts),
    ).toThrow("Target directory is a symlink");
  });

  test("breaks on ENOENT and does not throw", () => {
    const calls: string[] = [];
    const components = ["/a", "/a/b", "/a/b/c"];
    const statFn = (c: string) => {
      calls.push(c);
      if (c === "/a/b") {
        const err = Object.assign(new Error("not found"), { code: "ENOENT" });
        throw err;
      }
      return { isSymbolicLink: () => false };
    };
    rejectSymlinkPathComponentsSync(components, statFn, makeOpts());
    expect(calls).toEqual(["/a", "/a/b"]);
  });

  test("throws on non-recoverable stat error", () => {
    const opts = makeOpts();
    const components = ["/a"];
    const statFn = (_c: string) => {
      const err = Object.assign(new Error("perm denied"), { code: "EACCES" });
      throw err;
    };
    expect(() =>
      rejectSymlinkPathComponentsSync(components, statFn, opts),
    ).toThrow("Failed to stat target path");
  });

  test("rethrows errorClass instances from statFn immediately", () => {
    const opts = makeOpts();
    const components = ["/a"];
    const statFn = (_c: string) => {
      throw new TestSymlinkError("nested sync error");
    };
    expect(() =>
      rejectSymlinkPathComponentsSync(components, statFn, opts),
    ).toThrow("nested sync error");
  });

  test("throws generic component symlink for middle component", () => {
    const opts = makeOpts();
    const middleComponent = `${sep}middle`;
    const components = [middleComponent];
    const statFn = (_c: string) => ({
      isSymbolicLink: () => true,
    });
    expect(() =>
      rejectSymlinkPathComponentsSync(components, statFn, opts),
    ).toThrow(`Target directory component '${middleComponent}' is a symlink`);
  });
});
