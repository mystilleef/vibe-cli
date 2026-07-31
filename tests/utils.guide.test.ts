import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GuideSourceError,
  GuideTargetError,
  inspectGuide,
  readGuideSourceBuffer,
  resolveGuideSource,
  resolveGuideTarget,
} from "../src/utils/guide.js";
import { cleanupTempDirs, createTempDir } from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];

beforeEach(async () => {
  tempDirs = [];
});

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

describe("resolveGuideSource", () => {
  test("resolves guide from checkout layout (src/utils anchor)", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Test Guide\n");

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    const result = resolveGuideSource(srcUtils);
    expect(result).toBe(join(root, "docs", "vibe-guide.md"));
  });

  test("resolves guide from extracted-package layout (dist anchor)", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Extracted Guide\n");

    const distDir = join(root, "dist");
    await mkdir(distDir, { recursive: true });

    const result = resolveGuideSource(distDir);
    expect(result).toBe(join(root, "docs", "vibe-guide.md"));
  });

  test("resolves guide from package root directly", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Root Guide\n");

    const result = resolveGuideSource(root);
    expect(result).toBe(join(root, "docs", "vibe-guide.md"));
  });

  test("resolves guide using default import.meta.dir anchor", () => {
    const result = resolveGuideSource();
    expect(result).toContain("docs/vibe-guide.md");
  });

  test("throws GuideSourceError when guide file is missing", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    // No docs/ directory or vibe-guide.md

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    expect(() => resolveGuideSource(srcUtils)).toThrow(GuideSourceError);
    expect(() => resolveGuideSource(srcUtils)).toThrow(/not found/);
  });

  test("resolves guide when guide path is a symlink pointing to a regular file", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    const realGuide = join(root, "real-guide.md");
    await writeFile(realGuide, "# Real Guide\n");
    await symlink(realGuide, join(docsDir, "vibe-guide.md"));

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    const result = resolveGuideSource(srcUtils);
    expect(result).toBe(join(docsDir, "vibe-guide.md"));
  });

  test("throws GuideSourceError when guide path is a broken symlink", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    const missingTarget = join(root, "non-existent.md");
    await symlink(missingTarget, join(docsDir, "vibe-guide.md"));

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    expect(() => resolveGuideSource(srcUtils)).toThrow(GuideSourceError);
    expect(() => resolveGuideSource(srcUtils)).toThrow(/not found/);
  });

  test("throws GuideSourceError when guide path is a symlink pointing to a directory", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });

    const targetDir = join(root, "guide-dir");
    await mkdir(targetDir, { recursive: true });
    await symlink(targetDir, join(docsDir, "vibe-guide.md"));

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    expect(() => resolveGuideSource(srcUtils)).toThrow(GuideSourceError);
    expect(() => resolveGuideSource(srcUtils)).toThrow(/not a regular file/);
  });

  test("throws GuideSourceError when guide path exists but is not a file", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(join(docsDir, "vibe-guide.md"), { recursive: true }); // directory, not file

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    expect(() => resolveGuideSource(srcUtils)).toThrow(GuideSourceError);
    expect(() => resolveGuideSource(srcUtils)).toThrow(/not a regular file/);
  });

  test("throws GuideSourceError when docs directory is missing", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    // No docs/ directory at all

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    expect(() => resolveGuideSource(srcUtils)).toThrow(GuideSourceError);
    expect(() => resolveGuideSource(srcUtils)).toThrow(/not found/);
  });

  test("throws GuideSourceError when statSync fails accessing guide source", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    const guidePath = join(docsDir, "vibe-guide.md");
    await writeFile(guidePath, "# Guide\n");

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    const fsModule = await import("node:fs");
    const originalStatSync = fsModule.statSync;
    const spy = spyOn(fsModule, "statSync");
    spy.mockImplementation(((p: string) => {
      if (p === guidePath) {
        throw new Error("EACCES: permission denied");
      }
      return originalStatSync(p);
    }) as typeof fsModule.statSync);

    try {
      expect(() => resolveGuideSource(srcUtils)).toThrow(GuideSourceError);
      expect(() => resolveGuideSource(srcUtils)).toThrow(/inaccessible/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("readGuideSourceBuffer", () => {
  test("reads raw guide source bytes without UTF-8 decoding loss", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    const rawBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x80, 0xff]);
    await writeFile(join(docsDir, "vibe-guide.md"), rawBytes);

    const srcUtils = join(root, "src", "utils");
    await mkdir(srcUtils, { recursive: true });

    const result = readGuideSourceBuffer(srcUtils);
    expect(result).toEqual(rawBytes);
  });
});

describe("resolveGuideSource layout matrix", () => {
  test("resolves from nested src subdirectory", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Guide\n");

    const deepSrc = join(root, "src", "utils", "internal");
    await mkdir(deepSrc, { recursive: true });

    expect(resolveGuideSource(deepSrc)).toBe(
      join(root, "docs", "vibe-guide.md"),
    );
  });

  test("resolves from global node_modules layout", async () => {
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
    const docsDir = join(pkgRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Global Guide\n");

    const distDir = join(pkgRoot, "dist");
    await mkdir(distDir, { recursive: true });

    expect(resolveGuideSource(distDir)).toBe(
      join(pkgRoot, "docs", "vibe-guide.md"),
    );
  });

  test("resolves from linked package layout through symlink chain", async () => {
    const realRoot = await createTempDir(tempDirs);
    await writeFile(
      join(realRoot, "package.json"),
      '{"name":"@mystilleef/vibe-cli"}',
    );
    const docsDir = join(realRoot, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Linked Guide\n");

    const linkHome = await createTempDir(tempDirs);
    const linkedPkg = join(linkHome, "linked-vibe");
    await symlink(realRoot, linkedPkg, "dir");

    const realStart = join(linkedPkg, "src", "utils");
    await mkdir(join(realRoot, "src", "utils"), { recursive: true });

    expect(resolveGuideSource(realStart)).toBe(
      join(realRoot, "docs", "vibe-guide.md"),
    );
  });

  test("prefers nearest package.json ancestor", async () => {
    const outer = await createTempDir(tempDirs);
    await writeFile(join(outer, "package.json"), '{"name":"outer"}');
    const outerDocs = join(outer, "docs");
    await mkdir(outerDocs, { recursive: true });
    await writeFile(join(outerDocs, "vibe-guide.md"), "# Outer Guide\n");

    const inner = join(outer, "packages", "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "package.json"), '{"name":"inner"}');
    const innerDocs = join(inner, "docs");
    await mkdir(innerDocs, { recursive: true });
    await writeFile(join(innerDocs, "vibe-guide.md"), "# Inner Guide\n");

    const deep = join(inner, "src");
    await mkdir(deep, { recursive: true });

    expect(resolveGuideSource(deep)).toBe(join(inner, "docs", "vibe-guide.md"));
  });
});

describe("inspectGuide", () => {
  test("returns status 'missing' when destination file does not exist", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);

    const result = inspectGuide(targetDir, root);
    expect(result.status).toBe("missing");
    expect(result.target).toBe(targetDir);
  });

  test("returns status 'identical' when destination file matches source", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    const content = "# Matching Guide\n";
    await writeFile(join(docsDir, "vibe-guide.md"), content);

    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);

    const result = inspectGuide(targetDir, root);
    expect(result.status).toBe("identical");
  });

  test("returns status 'outdated' when destination file differs from source", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# New Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old Target Guide\n");

    const result = inspectGuide(targetDir, root);
    expect(result.status).toBe("outdated");
  });

  test("throws GuideTargetError when destination is a symlink", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    const realFile = join(targetDir, "real.md");
    await writeFile(realFile, "# Real\n");
    await symlink(realFile, join(targetDir, "vibe-guide.md"));

    expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
    expect(() => inspectGuide(targetDir, root)).toThrow(/symlink/);
  });

  test("throws GuideTargetError when target root is a symlink", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const realTargetDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkTargetDir = join(parentDir, "symlinked-target");
    await symlink(realTargetDir, symlinkTargetDir, "dir");

    expect(() => inspectGuide(symlinkTargetDir, root)).toThrow(
      GuideTargetError,
    );
    expect(() => inspectGuide(symlinkTargetDir, root)).toThrow(/symlink/i);
  });

  test("throws GuideTargetError when destination is not a regular file", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    await mkdir(join(targetDir, "vibe-guide.md"), { recursive: true });

    expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
    expect(() => inspectGuide(targetDir, root)).toThrow(/not a regular file/);
  });

  test("throws GuideSourceError when source read fault occurs during hash check", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    const sourcePath = join(docsDir, "vibe-guide.md");
    await writeFile(sourcePath, "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Target Guide\n");

    const fsModule = await import("node:fs");
    const originalReadFileSync = fsModule.readFileSync;
    const spy = spyOn(fsModule, "readFileSync");
    spy.mockImplementation(((
      p: Parameters<typeof fsModule.readFileSync>[0],
      options: Parameters<typeof fsModule.readFileSync>[1],
    ) => {
      if (p === sourcePath) {
        throw new Error("EACCES: permission denied");
      }
      return originalReadFileSync(p, options);
    }) as typeof fsModule.readFileSync);

    try {
      expect(() => inspectGuide(targetDir, root)).toThrow(GuideSourceError);
      expect(() => inspectGuide(targetDir, root)).toThrow(
        /Failed to read guide source/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws GuideTargetError when destination read fault occurs during hash check", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    const destPath = join(targetDir, "vibe-guide.md");
    await writeFile(destPath, "# Target Guide\n");

    const fsModule = await import("node:fs");
    const originalReadFileSync = fsModule.readFileSync;
    const spy = spyOn(fsModule, "readFileSync");
    spy.mockImplementation(((
      p: Parameters<typeof fsModule.readFileSync>[0],
      options: Parameters<typeof fsModule.readFileSync>[1],
    ) => {
      if (p === destPath) {
        throw new Error("EACCES: permission denied");
      }
      return originalReadFileSync(p, options);
    }) as typeof fsModule.readFileSync);

    try {
      expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
      expect(() => inspectGuide(targetDir, root)).toThrow(
        /Failed to read guide destination/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws GuideTargetError when target path traverses an intermediate symlink directory", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const realDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkDir = join(parentDir, "symlinked-dir");
    await symlink(realDir, symlinkDir, "dir");

    const targetWithSymlinkAncestor = join(symlinkDir, "nested");

    expect(() => inspectGuide(targetWithSymlinkAncestor, root)).toThrow(
      GuideTargetError,
    );
    expect(() => inspectGuide(targetWithSymlinkAncestor, root)).toThrow(
      /symlink/i,
    );
  });

  test("throws GuideTargetError when lstatSync on targetRoot fails with non-ENOENT/non-ENOTDIR code", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = join(root, "target");
    await mkdir(targetDir, { recursive: true });

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: Parameters<typeof fsModule.lstatSync>[0]) => {
      if (
        p === targetDir ||
        (typeof p === "string" && p.startsWith(`${targetDir}/`))
      ) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
      expect(() => inspectGuide(targetDir, root)).toThrow(
        /Failed to stat target directory/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws GuideTargetError when lstatSync on destPath fails with non-ENOENT code", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    // Create the dest path as a directory so lstat succeeds but the second lstat on destPath fails
    const destPath = join(targetDir, "vibe-guide.md");
    await mkdir(destPath);

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    let callCount = 0;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: Parameters<typeof fsModule.lstatSync>[0]) => {
      if (typeof p === "string" && p === destPath) {
        callCount++;
        if (callCount >= 2) {
          const err = new Error("EIO: I/O error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws GuideTargetError when lstatSync on an intermediate path fails with non-ENOENT/non-ENOTDIR", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    const intermediatePath = join(targetDir, "subdir");
    await mkdir(intermediatePath);

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: Parameters<typeof fsModule.lstatSync>[0]) => {
      if (p === intermediatePath) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      // Target a path that goes through intermediatePath
      const deepTarget = join(intermediatePath, "deeper");
      expect(() => inspectGuide(deepTarget, root)).toThrow(GuideTargetError);
      expect(() => inspectGuide(deepTarget, root)).toThrow(
        /Failed to stat target path '.*subdir'/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws GuideTargetError when destPath lstatSync fails with non-ENOENT code", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);

    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: Parameters<typeof fsModule.lstatSync>[0]) => {
      if (typeof p === "string" && p.endsWith("vibe-guide.md")) {
        const err = new Error("EIO: I/O error") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
      expect(() => inspectGuide(targetDir, root)).toThrow(
        /Failed to stat guide destination/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws GuideTargetError when hashFile destination read fails with non-GuideTargetError", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    const destPath = join(targetDir, "vibe-guide.md");
    await writeFile(destPath, "# Target Guide\n");

    const fsModule = await import("node:fs");
    const originalReadFileSync = fsModule.readFileSync;
    const spy = spyOn(fsModule, "readFileSync");
    let readCount = 0;
    spy.mockImplementation(((
      p: Parameters<typeof fsModule.readFileSync>[0],
      options: Parameters<typeof fsModule.readFileSync>[1],
    ) => {
      // First read is source, second is destination — fail on destination
      if (typeof p === "string" && p === destPath && readCount > 0) {
        throw new Error("EACCES: permission denied");
      }
      readCount++;
      return originalReadFileSync(p, options);
    }) as typeof fsModule.readFileSync);

    try {
      expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
      expect(() => inspectGuide(targetDir, root)).toThrow(
        /Failed to read guide destination/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("throws GuideTargetError when destPath appears as symlink after pathComponents loop (TOCTOU race)", async () => {
    const root = await createTempDir(tempDirs);
    await writeFile(join(root, "package.json"), '{"name":"test"}');
    const docsDir = join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "vibe-guide.md"), "# Source Guide\n");

    const targetDir = await createTempDir(tempDirs);
    const destPath = join(targetDir, "vibe-guide.md");

    // Mock lstatSync: fail with ENOENT in the pathComponents loop,
    // then succeed as symlink in the separate lstatSync after the loop.
    const fsModule = await import("node:fs");
    const originalLstatSync = fsModule.lstatSync;
    let callCount = 0;
    const spy = spyOn(fsModule, "lstatSync");
    spy.mockImplementation(((p: Parameters<typeof fsModule.lstatSync>[0]) => {
      if (typeof p === "string" && p === destPath) {
        callCount++;
        if (callCount === 1) {
          const err = new Error(
            "ENOENT: no such file or directory",
          ) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        // Second call: return a symlink stat
        const stats = originalLstatSync(p);
        // Override isSymbolicLink to return true
        return Object.create(stats, {
          isSymbolicLink: { value: () => true },
        }) as typeof stats;
      }
      return originalLstatSync(p);
    }) as typeof fsModule.lstatSync);

    try {
      // Create the destPath as a symlink (the mock will override its behavior)
      const realFile = join(targetDir, "real.md");
      await writeFile(realFile, "# Real\n");
      await symlink(realFile, destPath);

      expect(() => inspectGuide(targetDir, root)).toThrow(GuideTargetError);
      expect(() => inspectGuide(targetDir, root)).toThrow(/symlink/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getSafeHomedir via resolveGuideTarget", () => {
  test("resolveGuideTarget throws when HOME is empty and homedir() returns empty", async () => {
    const originalHome = process.env["HOME"];
    delete process.env["HOME"];

    const osModule = await import("node:os");
    const spy = spyOn(osModule, "homedir");
    spy.mockImplementation(() => "");

    try {
      expect(() => resolveGuideTarget("~")).toThrow(GuideTargetError);
      expect(() => resolveGuideTarget("~")).toThrow(
        /Unable to determine home directory/,
      );
    } finally {
      spy.mockRestore();
      if (originalHome !== undefined) {
        process.env["HOME"] = originalHome;
      }
    }
  });

  test("resolveGuideTarget with tilde-prefixed path resolves correctly", () => {
    const result = resolveGuideTarget("~/projects/test");
    expect(result).toContain("projects/test");
    expect(result.startsWith("/")).toBe(true);
  });

  test("resolveGuideTarget with undefined returns cwd", () => {
    const result = resolveGuideTarget();
    expect(result).toBe(process.cwd());
  });

  test("resolveGuideTarget with empty string returns cwd", () => {
    const result = resolveGuideTarget("");
    expect(result).toBe(process.cwd());
  });
});
