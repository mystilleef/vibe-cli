/**
 * Direct coverage of the shared path-resolution contract: safe home lookup,
 * tilde expansion, default fallbacks, and typed home-failure wrapping.
 * Installer layers exercise these helpers through `resolveGuideTarget`,
 * `resolveTargetRoot`, and the settings installer; these tests pin the
 * boundary cases — empty targets, bare and extended tildes, and home
 * unavailability — at the source of the policy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  expandTildePath,
  getSafeHomedir,
  resolveTargetPath,
} from "../src/utils/paths.js";
import { withMutatedEnv, withUnavailableHome } from "./helpers/envFixtures.js";
import { cleanupTempDirs, createTempDir } from "./helpers/skillsTestUtils.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempRoots.splice(0));
});

class TestPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestPathError";
  }
}

describe("getSafeHomedir", () => {
  test("prefers the HOME environment variable", () =>
    withMutatedEnv({ HOME: "/fake/home" }, async () => {
      expect(getSafeHomedir()).toBe("/fake/home");
    }));

  test("falls back to os.homedir when HOME is unset", async () => {
    const { homedir } = await import("node:os");
    await withMutatedEnv({ HOME: undefined }, async () => {
      expect(getSafeHomedir()).toBe(homedir());
    });
  });

  test("throws when HOME is unset and homedir returns empty", () =>
    withUnavailableHome(async () => {
      expect(() => getSafeHomedir()).toThrow(
        /Unable to determine home directory/,
      );
    }));
});

interface TildeCase {
  name: string;
  target: string | undefined;
  defaultTo?: string;
  /** Subdirectory of the fake HOME the test installs. */
  home: string;
  expected: (home: string) => string;
}

/** Cases both target resolvers must hold: default-free path semantics. */
const SHARED_TARGET_CASES: TildeCase[] = [
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
    expected: (home) => resolve(home),
  },
];

const EXPAND_CASES: TildeCase[] = [
  ...SHARED_TARGET_CASES,
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
      const fakeRoot =
        home === ""
          ? undefined
          : await createTempDir(tempRoots, "vibe-cli-paths-");
      const fakeHome = fakeRoot === undefined ? "" : join(fakeRoot, home);
      await withMutatedEnv(
        fakeRoot === undefined ? {} : { HOME: fakeHome },
        async () => {
          expect(expandTildePath(target, defaultTo)).toBe(expected(fakeHome));
        },
      );
    },
  );

  test("throws when a tilde target has no available home directory", () =>
    withUnavailableHome(async () => {
      expect(() => expandTildePath("~")).toThrow(
        /Unable to determine home directory/,
      );
      expect(() => expandTildePath("~/sub")).toThrow(
        /Unable to determine home directory/,
      );
    }));
});

describe("resolveTargetPath", () => {
  test.each(SHARED_TARGET_CASES)(
    "$name",
    async ({ target, home, expected }) => {
      const fakeRoot =
        home === ""
          ? undefined
          : await createTempDir(tempRoots, "vibe-cli-paths-");
      const fakeHome = fakeRoot === undefined ? "" : join(fakeRoot, home);
      await withMutatedEnv(
        fakeRoot === undefined ? {} : { HOME: fakeHome },
        async () => {
          expect(resolveTargetPath(target, TestPathError)).toBe(
            expected(fakeHome),
          );
        },
      );
    },
  );

  test("wraps home unavailability in the caller error class", () =>
    withUnavailableHome(async () => {
      expect(() => resolveTargetPath("~", TestPathError)).toThrow(
        TestPathError,
      );
      expect(() => resolveTargetPath("~", TestPathError)).toThrow(
        /Unable to determine home directory/,
      );
    }));
});
