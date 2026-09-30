/**
 * Direct coverage of the ENOENT-tolerant stat probes: absence reports
 * `null`, symlinks follow or stay un-followed per probe, dangling symlink
 * targets collapse to `null` only for the following probe, and non-ENOENT
 * faults (ENOTDIR) surface unchanged instead of being swallowed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lstatOrMissing, statOrMissing } from "../src/utils/fsStats.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
  mkdirSync(home.dataRoot, { recursive: true });
});

afterEach(async () => {
  await home.cleanup();
});

function writeRegularFile(name: string): string {
  const filePath = join(home.dataRoot, name);
  writeFileSync(filePath, "content");
  return filePath;
}

function createSymlink(name: string, target: string): string {
  const linkPath = join(home.dataRoot, name);
  symlinkSync(target, linkPath);
  return linkPath;
}

describe("statOrMissing", () => {
  test("reports null for an absent target", async () => {
    await expect(
      statOrMissing(join(home.dataRoot, "absent.db")),
    ).resolves.toBeNull();
  });

  test("reports regular-file stats for an existing file", async () => {
    const stats = await statOrMissing(writeRegularFile("present.db"));

    expect(stats?.isFile()).toBe(true);
  });

  test("follows a symlink to its target stats", async () => {
    const target = writeRegularFile("target.db");
    const stats = await statOrMissing(createSymlink("linked.db", target));

    expect(stats?.isFile()).toBe(true);
    expect(stats?.isSymbolicLink()).toBe(false);
  });

  test("reports a dangling symlink as missing", async () => {
    await expect(
      statOrMissing(
        createSymlink("dangling.db", join(home.dataRoot, "absent-target.db")),
      ),
    ).resolves.toBeNull();
  });

  test("rethrows a non-ENOENT fault with its errno intact", async () => {
    const filePath = writeRegularFile("blocker.db");

    const error = await statOrMissing(join(filePath, "child")).catch(
      (err) => err,
    );

    expect((error as NodeJS.ErrnoException).code).toBe("ENOTDIR");
  });
});

describe("lstatOrMissing", () => {
  test("reports null for an absent target", async () => {
    await expect(
      lstatOrMissing(join(home.dataRoot, "absent.db")),
    ).resolves.toBeNull();
  });

  test("reports regular-file stats for an existing file", async () => {
    const stats = await lstatOrMissing(writeRegularFile("present.db"));

    expect(stats?.isFile()).toBe(true);
  });

  test("reports the symlink itself without following", async () => {
    const target = writeRegularFile("target.db");
    const stats = await lstatOrMissing(createSymlink("linked.db", target));

    expect(stats?.isSymbolicLink()).toBe(true);
  });

  test("reports a dangling symlink as present", async () => {
    const stats = await lstatOrMissing(
      createSymlink("dangling.db", join(home.dataRoot, "absent-target.db")),
    );

    expect(stats?.isSymbolicLink()).toBe(true);
  });

  test("rethrows a non-ENOENT fault with its errno intact", async () => {
    const filePath = writeRegularFile("blocker.db");

    const error = await lstatOrMissing(join(filePath, "child")).catch(
      (err) => err,
    );

    expect((error as NodeJS.ErrnoException).code).toBe("ENOTDIR");
  });
});

describe("stat probe parity", () => {
  test("reports directory stats for an existing directory", async () => {
    const dirPath = join(home.dataRoot, "present-dir");
    mkdirSync(dirPath, { recursive: true });

    const followed = await statOrMissing(dirPath);
    const direct = await lstatOrMissing(dirPath);

    expect(followed?.isDirectory()).toBe(true);
    expect(direct?.isDirectory()).toBe(true);
  });
});
