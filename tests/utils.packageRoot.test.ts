import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findPackageRoot } from "../src/utils/packageRoot.js";
import { cleanupTempDirs, createTempDir } from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];

beforeEach(async () => {
  tempDirs = [];
});

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

describe("findPackageRoot", () => {
  test("finds package.json in current directory", async () => {
    const dir = await createTempDir(tempDirs);
    await writeFile(join(dir, "package.json"), '{"name": "test"}');

    const result = findPackageRoot(dir);
    expect(result).toBe(realpathSync(dir));
  });

  test("walks up to find package.json in parent directory", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "root"}');

    const subdir = join(root, "sub", "dir");
    await mkdir(subdir, { recursive: true });

    const result = findPackageRoot(subdir);
    expect(result).toBe(realpathSync(root));
  });

  test("walks up multiple levels to find package.json", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "root"}');

    const deep = join(root, "a", "b", "c", "d");
    await mkdir(deep, { recursive: true });

    const result = findPackageRoot(deep);
    expect(result).toBe(realpathSync(root));
  });

  test("returns real startDir when no package.json found up to filesystem root", async () => {
    const dir = await createTempDir(tempDirs);
    const subdir = join(dir, "sub");
    await mkdir(subdir, { recursive: true });

    // No package.json anywhere - should return real startDir
    const result = findPackageRoot(subdir);
    expect(result).toBe(realpathSync(subdir));
  });

  test("handles symlinked directories by resolving to real path", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "root"}');

    const realSub = join(root, "real-sub");
    await mkdir(realSub, { recursive: true });

    const linkRoot = await createTempDir(tempDirs);
    const linkSub = join(linkRoot, "via-link");
    await symlink(realSub, linkSub, "dir");

    const result = findPackageRoot(linkSub);
    expect(result).toBe(realpathSync(root));
  });

  test("works from import.meta.dir context (simulated)", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "test"}');

    const srcDir = join(root, "src", "utils");
    await mkdir(srcDir, { recursive: true });

    const result = findPackageRoot(srcDir);
    expect(result).toBe(realpathSync(root));
  });

  test("returns real path when package root itself is reached via symlink", async () => {
    const realRoot = await createTempDir(tempDirs);
    await writeFile(join(realRoot, "package.json"), '{"name": "real"}');
    const nested = join(realRoot, "src", "utils");
    await mkdir(nested, { recursive: true });

    const linkHome = await createTempDir(tempDirs);
    const linkedRoot = join(linkHome, "pkg-link");
    await symlink(realRoot, linkedRoot, "dir");

    const result = findPackageRoot(join(linkedRoot, "src", "utils"));
    expect(result).toBe(realpathSync(realRoot));
  });

  test("prefers nearest package.json ancestor", async () => {
    const outer = await createTempDir(tempDirs);
    await writeFile(join(outer, "package.json"), '{"name": "outer"}');
    const inner = join(outer, "packages", "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "package.json"), '{"name": "inner"}');
    const deep = join(inner, "src");
    await mkdir(deep, { recursive: true });

    expect(findPackageRoot(deep)).toBe(realpathSync(inner));
  });
});

describe("findPackageRoot layout matrix", () => {
  test("resolves local checkout layout from src/utils", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"vibe-cli"}');
    const start = join(root, "src", "utils");
    await mkdir(start, { recursive: true });

    expect(findPackageRoot(start)).toBe(realpathSync(root));
  });

  test("resolves linked package layout through symlink chain", async () => {
    const realRoot = await createTempDir(tempDirs);
    await writeFile(join(realRoot, "package.json"), '{"name":"vibe-cli"}');
    const realStart = join(realRoot, "src", "utils");
    await mkdir(realStart, { recursive: true });

    const linkHome = await createTempDir(tempDirs);
    const linkedPkg = join(linkHome, "linked-vibe");
    await symlink(realRoot, linkedPkg, "dir");

    expect(findPackageRoot(join(linkedPkg, "src", "utils"))).toBe(
      realpathSync(realRoot),
    );
  });

  test("resolves global-style node_modules package layout", async () => {
    const prefix = await createTempDir(tempDirs);
    const pkgRoot = join(
      prefix,
      "lib",
      "node_modules",
      "@mystilleef",
      "vibe-cli",
    );
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(
      join(pkgRoot, "package.json"),
      '{"name":"@mystilleef/vibe-cli"}',
    );
    const start = join(pkgRoot, "dist");
    await mkdir(start, { recursive: true });

    // Outer package.json must not win over the installed package root.
    await writeFile(join(prefix, "package.json"), '{"name":"prefix-host"}');

    expect(findPackageRoot(start)).toBe(realpathSync(pkgRoot));
  });

  test("resolves packed-extraction package layout", async () => {
    const extractRoot = await createTempDir(tempDirs);
    const pkgRoot = join(extractRoot, "package");
    await mkdir(pkgRoot, { recursive: true });
    await writeFile(join(pkgRoot, "package.json"), '{"name":"vibe-cli"}');
    const start = join(pkgRoot, "dist");
    await mkdir(start, { recursive: true });

    expect(findPackageRoot(start)).toBe(realpathSync(pkgRoot));
  });

  test("resolves linked global-style install through node_modules symlink", async () => {
    const realRoot = await createTempDir(tempDirs);
    await writeFile(
      join(realRoot, "package.json"),
      '{"name":"@mystilleef/vibe-cli"}',
    );
    const realStart = join(realRoot, "dist");
    await mkdir(realStart, { recursive: true });

    const prefix = await createTempDir(tempDirs);
    const nmScope = join(prefix, "lib", "node_modules", "@mystilleef");
    await mkdir(nmScope, { recursive: true });
    const linkedPkg = join(nmScope, "vibe-cli");
    await symlink(realRoot, linkedPkg, "dir");

    expect(findPackageRoot(join(linkedPkg, "dist"))).toBe(
      realpathSync(realRoot),
    );
  });

  test("falls back when startDir realpathSync fails and no package.json exists", async () => {
    // Use a non-existent path as startDir so realpathSync(startDir) throws.
    // The catch sets dir = startDir (raw string), and since there's no
    // package.json anywhere up the path, the while loop reaches the
    // filesystem root and returns the fallback.
    const nonExistentDir = join(
      await createTempDir(tempDirs),
      "does-not-exist",
    );

    const result = findPackageRoot(nonExistentDir);
    // fallback is the raw string passed in, since realpathSync failed
    expect(result).toBe(nonExistentDir);
  });

  test("falls back to raw dir when realpathSync throws on found package root", async () => {
    // Use spyOn to reliably trigger the catch at lines 27-28 regardless
    // of platform-specific chmod behavior.
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name": "test"}');
    const subdir = join(root, "src", "utils");
    await mkdir(subdir, { recursive: true });

    const fsModule = await import("node:fs");
    const originalRealpathSync = fsModule.realpathSync;
    const spy = spyOn(fsModule, "realpathSync");
    spy.mockImplementation(((p: string) => {
      // realpathSync(startDir) must succeed so the walk can proceed.
      // Only fail when resolving the found package root.
      const resolved = originalRealpathSync(p);
      if (resolved === originalRealpathSync(root)) {
        throw new Error("injected realpath failure");
      }
      return resolved;
    }) as typeof fsModule.realpathSync);

    try {
      const result = findPackageRoot(subdir);
      expect(typeof result).toBe("string");
      expect(result).toBe(root);
    } finally {
      spy.mockRestore();
    }
  });
});
