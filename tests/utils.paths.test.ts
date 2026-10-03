/**
 * Direct coverage of the shared path-resolution contract: safe home lookup,
 * tilde expansion, default fallbacks, and typed home-failure wrapping.
 * Installer layers exercise these helpers through `resolveGuideTarget`,
 * `resolveTargetRoot`, and the settings installer; these tests pin the
 * boundary cases — empty targets, bare and extended tildes, and home
 * unavailability — at the source of the policy.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expandTildePath,
  getSafeHomedir,
  resolveTargetPath,
} from "../src/utils/paths.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-cli-paths-"));
  tempRoots.push(root);
  return root;
}

class TestPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestPathError";
  }
}

describe("getSafeHomedir", () => {
  test("prefers the HOME environment variable", () => {
    const originalHome = process.env["HOME"];
    process.env["HOME"] = "/fake/home";
    try {
      expect(getSafeHomedir()).toBe("/fake/home");
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    }
  });

  test("falls back to os.homedir when HOME is unset", async () => {
    const originalHome = process.env["HOME"];
    delete process.env["HOME"];
    try {
      const { homedir } = await import("node:os");
      expect(getSafeHomedir()).toBe(homedir());
    } finally {
      if (originalHome !== undefined) process.env["HOME"] = originalHome;
    }
  });

  test("throws when HOME is unset and homedir returns empty", async () => {
    const originalHome = process.env["HOME"];
    delete process.env["HOME"];
    const osModule = await import("node:os");
    const spy = spyOn(osModule, "homedir");
    spy.mockReturnValue("");
    try {
      expect(() => getSafeHomedir()).toThrow(
        /Unable to determine home directory/,
      );
    } finally {
      spy.mockRestore();
      if (originalHome !== undefined) process.env["HOME"] = originalHome;
    }
  });
});

interface TildeCase {
  name: string;
  target: string | undefined;
  defaultTo?: string;
  /** Subdirectory of the fake HOME the test installs. */
  home: string;
  expected: (home: string) => string;
}

const EXPAND_CASES: TildeCase[] = [
  {
    name: "undefined target resolves to the working directory",
    target: undefined,
    home: "",
    expected: () => resolve(process.cwd()),
  },
  {
    name: "empty target resolves to the working directory",
    target: "",
    home: "",
    expected: () => resolve(process.cwd()),
  },
  {
    name: "empty target falls back to the default",
    target: "",
    defaultTo: "/explicit/default",
    home: "",
    expected: () => resolve("/explicit/default"),
  },
  {
    name: "undefined target falls back to the default",
    target: undefined,
    defaultTo: "/explicit/default",
    home: "",
    expected: () => resolve("/explicit/default"),
  },
  {
    name: "relative path resolves against the working directory",
    target: "relative/path",
    home: "",
    expected: () => resolve(join(process.cwd(), "relative/path")),
  },
  {
    name: "absolute path passes through resolved",
    target: "/absolute/path",
    home: "",
    expected: () => resolve("/absolute/path"),
  },
  {
    name: "bare tilde expands to the home directory",
    target: "~",
    home: "home-dir",
    expected: (home) => resolve(home),
  },
  {
    name: "tilde-prefixed path expands beneath the home directory",
    target: "~/sub/dir",
    home: "home-dir",
    expected: (home) => resolve(join(home, "sub", "dir")),
  },
  {
    name: "tilde word expands beneath the home directory",
    target: "~user",
    home: "home-dir",
    expected: (home) => resolve(join(home, "user")),
  },
];

describe("expandTildePath", () => {
  test.each(EXPAND_CASES)(
    "$name",
    async ({ target, defaultTo, home, expected }) => {
      const originalHome = process.env["HOME"];
      const fakeRoot = home === "" ? undefined : await createTempRoot();
      const fakeHome = fakeRoot === undefined ? "" : join(fakeRoot, home);
      if (fakeRoot !== undefined) {
        process.env["HOME"] = fakeHome;
      }
      try {
        expect(expandTildePath(target, defaultTo)).toBe(expected(fakeHome));
      } finally {
        if (originalHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = originalHome;
      }
    },
  );

  test("throws when a tilde target has no available home directory", async () => {
    const originalHome = process.env["HOME"];
    delete process.env["HOME"];
    const osModule = await import("node:os");
    const spy = spyOn(osModule, "homedir");
    spy.mockReturnValue("");
    try {
      expect(() => expandTildePath("~")).toThrow(
        /Unable to determine home directory/,
      );
      expect(() => expandTildePath("~/sub")).toThrow(
        /Unable to determine home directory/,
      );
    } finally {
      spy.mockRestore();
      if (originalHome !== undefined) process.env["HOME"] = originalHome;
    }
  });
});

describe("resolveTargetPath", () => {
  test.each([
    {
      name: "undefined target resolves to the working directory",
      target: undefined,
      home: "",
      expected: () => resolve(process.cwd()),
    },
    {
      name: "relative path resolves against the working directory",
      target: "relative/path",
      home: "",
      expected: () => resolve(join(process.cwd(), "relative/path")),
    },
    {
      name: "absolute path passes through resolved",
      target: "/absolute/path",
      home: "",
      expected: () => resolve("/absolute/path"),
    },
    {
      name: "bare tilde expands to the home directory",
      target: "~",
      home: "home-dir",
      expected: (home: string) => resolve(home),
    },
  ])("$name", async ({ target, home, expected }) => {
    const originalHome = process.env["HOME"];
    const fakeRoot = home === "" ? undefined : await createTempRoot();
    const fakeHome = fakeRoot === undefined ? "" : join(fakeRoot, home);
    if (fakeRoot !== undefined) {
      process.env["HOME"] = fakeHome;
    }
    try {
      expect(resolveTargetPath(target, TestPathError)).toBe(expected(fakeHome));
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    }
  });

  test("wraps home unavailability in the caller error class", async () => {
    const originalHome = process.env["HOME"];
    delete process.env["HOME"];
    const osModule = await import("node:os");
    const spy = spyOn(osModule, "homedir");
    spy.mockReturnValue("");
    try {
      expect(() => resolveTargetPath("~", TestPathError)).toThrow(
        TestPathError,
      );
      expect(() => resolveTargetPath("~", TestPathError)).toThrow(
        /Unable to determine home directory/,
      );
    } finally {
      spy.mockRestore();
      if (originalHome !== undefined) process.env["HOME"] = originalHome;
    }
  });
});
