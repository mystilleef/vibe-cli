/**
 * Direct coverage of the recorded-path safety contract: containment by path
 * segments (never string prefixes), role suffix shape, component walking,
 * and verdict classification. The diagnostics and purge layers exercise
 * these checks through `doctorStorage.ts`; these tests pin the boundary
 * cases — the containment-equal branch, missing verdicts, and lstat fault
 * classification — at the source of the policy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ARTIFACT_PATH_ROLE,
  BACKUP_PATH_ROLE,
  checkContainedPath,
  isWithinRoot,
  verifyRecordedPath,
} from "../src/utils/doctorPaths.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
  mkdirSync(home.dataRoot, { recursive: true });
});

afterEach(async () => {
  await home.cleanup();
});

describe("isWithinRoot", () => {
  test("accepts a strictly contained descendant", () => {
    expect(isWithinRoot(join(home.dataRoot, "a", "b"), home.dataRoot)).toBe(
      true,
    );
  });

  test("rejects a candidate equal to the root", () => {
    expect(isWithinRoot(home.dataRoot, home.dataRoot)).toBe(false);
  });

  test("rejects a parent of the root", () => {
    expect(isWithinRoot(dirname(home.dataRoot), home.dataRoot)).toBe(false);
  });

  test("rejects a sibling sharing the string prefix", () => {
    const sibling = join(dirname(home.dataRoot), `${home.dataRoot}-sibling`);

    expect(isWithinRoot(sibling, home.dataRoot)).toBe(false);
  });

  test("rejects an absolute path outside the root", () => {
    expect(
      isWithinRoot(join(dirname(home.dataRoot), "other"), home.dataRoot),
    ).toBe(false);
  });
});

describe("verifyRecordedPath", () => {
  test("accepts a contained regular file with the required .bak suffix", async () => {
    const filePath = join(home.dataRoot, "one.json.bak");
    writeFileSync(filePath, "{}");

    await expect(
      verifyRecordedPath(filePath, home.dataRoot, BACKUP_PATH_ROLE),
    ).resolves.toEqual({ status: "safe" });
  });

  test("rejects a contained regular file without the required .bak suffix", async () => {
    const filePath = join(home.dataRoot, "one.json");
    writeFileSync(filePath, "{}");

    await expect(
      verifyRecordedPath(filePath, home.dataRoot, BACKUP_PATH_ROLE),
    ).resolves.toEqual({
      status: "rejected",
      message: "recorded backup path does not have a .bak suffix",
    });
  });

  test("accepts a non-.bak leaf under a role without the suffix requirement", async () => {
    const filePath = join(home.dataRoot, "artifact.txt");
    writeFileSync(filePath, "{}");

    await expect(
      verifyRecordedPath(filePath, home.dataRoot, ARTIFACT_PATH_ROLE),
    ).resolves.toEqual({ status: "safe" });
  });

  test("reports a missing leaf as missing", async () => {
    await expect(
      verifyRecordedPath(
        join(home.dataRoot, "absent.json.bak"),
        home.dataRoot,
        BACKUP_PATH_ROLE,
      ),
    ).resolves.toEqual({ status: "missing" });
  });

  test("rejects a path escaping the data root", async () => {
    const outside = join(dirname(home.dataRoot), "one.json.bak");

    await expect(
      verifyRecordedPath(outside, home.dataRoot, BACKUP_PATH_ROLE),
    ).resolves.toEqual({
      status: "rejected",
      message: "recorded backup path escapes the data root",
    });
  });

  test("rejects a directory leaf as not a regular file", async () => {
    const dirPath = join(home.dataRoot, "one.json.bak");
    mkdirSync(dirPath, { recursive: true });

    await expect(
      verifyRecordedPath(dirPath, home.dataRoot, BACKUP_PATH_ROLE),
    ).resolves.toEqual({
      status: "rejected",
      message: "recorded backup path is not a regular file",
    });
  });

  test("rejects a file component in the middle of the path", async () => {
    const blocker = join(home.dataRoot, "blocker");
    writeFileSync(blocker, "{}");

    await expect(
      verifyRecordedPath(
        join(blocker, "child.json.bak"),
        home.dataRoot,
        BACKUP_PATH_ROLE,
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: `path component is not a directory: ${blocker}`,
    });
  });

  test("rejects a symlink component below the data root", async () => {
    const realDir = join(home.dataRoot, "real");
    mkdirSync(realDir, { recursive: true });
    const linkPath = join(home.dataRoot, "linked");
    symlinkSync(realDir, linkPath);

    await expect(
      verifyRecordedPath(
        join(linkPath, "one.json.bak"),
        home.dataRoot,
        BACKUP_PATH_ROLE,
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: `path component is a symlink: ${linkPath}`,
    });
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "classifies an lstat permission fault as an error verdict",
    async () => {
      const locked = join(home.dataRoot, "locked");
      mkdirSync(locked, { recursive: true });
      const filePath = join(locked, "one.json.bak");
      writeFileSync(filePath, "{}");
      chmodSync(locked, 0o000);

      try {
        const verdict = await verifyRecordedPath(
          filePath,
          home.dataRoot,
          BACKUP_PATH_ROLE,
        );

        expect(verdict.status).toBe("error");
        if (verdict.status === "error") {
          expect(verdict.message).toMatch(/EACCES|permission/i);
        }
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe("checkContainedPath", () => {
  test("reports missing when an intermediate component does not exist", async () => {
    const path = join(home.dataRoot, "absent-dir", "leaf.json.bak");

    await expect(checkContainedPath(path, home.dataRoot)).resolves.toEqual({
      status: "missing",
    });
  });

  test("treats the data root itself as safe containment", async () => {
    await expect(
      checkContainedPath(home.dataRoot, home.dataRoot),
    ).resolves.toEqual({ status: "safe", isFile: false });
  });

  test("returns safe for a path outside the data root, deferring containment to callers", async () => {
    const sibling = join(dirname(home.dataRoot), "outside");
    mkdirSync(sibling, { recursive: true });

    await expect(checkContainedPath(sibling, home.dataRoot)).resolves.toEqual({
      status: "safe",
      isFile: false,
    });
  });
});
