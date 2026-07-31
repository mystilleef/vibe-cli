import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  constants,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  GuideInstallError,
  GuideInstallValidationError,
  installGuide,
} from "../src/tools/guideInstaller.js";
import { inspectGuide } from "../src/utils/guide.js";
import {
  cleanupTempDirs,
  createTempDir,
  dirExists,
  fileExists,
} from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];

beforeEach(async () => {
  tempDirs = [];
});

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

/**
 * Create a minimal package root with a docs/vibe-guide.md file.
 */
async function createGuidePackageRoot(
  tracking: string[],
  content: string | Buffer = "# Test Guide\n",
): Promise<string> {
  const root = await createTempDir(tracking);
  await writeFile(join(root, "package.json"), '{"name":"test-package"}');
  const docsDir = join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "vibe-guide.md"), content);
  // Create src/utils for anchor dir
  const srcUtils = join(root, "src", "utils");
  await mkdir(srcUtils, { recursive: true });
  return root;
}

function getAnchorDir(packageRoot: string): string {
  return join(packageRoot, "src", "utils");
}

describe("installGuide - target resolution", () => {
  test("resolves explicit absolute target", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.target).toBe(targetDir);
    expect(result.ok).toBe(true);
  });

  test("resolves cwd target", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);

    const result = await installGuide(".", {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.target).toBe(process.cwd());
    expect(result.ok).toBe(true);
  });

  test("resolves tilde target", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const fakeHome = await createTempDir(tempDirs);
    const originalHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;

    try {
      const result = await installGuide("~", {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.target).toBe(fakeHome);
      expect(result.ok).toBe(true);

      // Nested target with existing parent resolves correctly
      const nestedParent = join(fakeHome, "nested");
      await mkdir(nestedParent);
      const nestedResult = await installGuide("~/nested", {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(nestedResult.target).toBe(nestedParent);
      expect(nestedResult.ok).toBe(true);
    } finally {
      process.env["HOME"] = originalHome;
    }
  });

  test("rejects absent nested target path on dry-run when parent does not exist", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const absentTarget = join(base, "nested", "deep", "target");

    await expect(
      installGuide(absentTarget, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);

    expect(await dirExists(join(base, "nested"))).toBe(false);
    expect(await dirExists(absentTarget)).toBe(false);
  });

  test("rejects absent nested target path on install when parent does not exist", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const absentTarget = join(base, "nested", "deep", "target");

    await expect(
      installGuide(absentTarget, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);

    expect(await dirExists(join(base, "nested"))).toBe(false);
    expect(await dirExists(absentTarget)).toBe(false);
  });

  test("names only vibe-guide.md beneath target", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    // Only vibe-guide.md should exist
    const entries = await readdir(targetDir);
    expect(entries).toEqual(["vibe-guide.md"]);
  });
});

describe("installGuide - tri-state status reports", () => {
  test("reports missing status when destination does not exist", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.status).toBe("missing");
    expect(result.action).toBe("would-install");
  });

  test("reports identical status when destination matches source", async () => {
    const content = "# Test Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.status).toBe("identical");
    expect(result.action).toBe("would-skip");
  });

  test("reports outdated status when destination differs from source", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# New Guide\n");
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old Guide\n");

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.status).toBe("outdated");
    expect(result.action).toBe("would-replace");
  });
});

describe("installGuide - byte-for-byte install", () => {
  test("installs guide to target", async () => {
    const content = "# Vibe Guide\n\nGuide content here.\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("installed");
    expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(true);

    const installed = await readFile(join(targetDir, "vibe-guide.md"), "utf8");
    expect(installed).toBe(content);
  });

  test("copies exact source bytes on install", async () => {
    const content = "# Precise Content\n\nWith exact bytes.\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);

    await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    const installed = await readFile(join(targetDir, "vibe-guide.md"), "utf8");
    expect(installed).toBe(content);
  });

  test("preserves non-UTF8 raw source bytes during installation", async () => {
    const rawBytes = Buffer.from([
      0x23, 0x20, 0x54, 0x65, 0x73, 0x74, 0x0a, 0x80, 0x81, 0xff, 0x0a,
    ]);
    const packageRoot = await createGuidePackageRoot(tempDirs, rawBytes);
    const targetDir = await createTempDir(tempDirs);

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("installed");

    const installedBytes = await readFile(join(targetDir, "vibe-guide.md"));
    expect(installedBytes).toEqual(rawBytes);

    const inspection = inspectGuide(targetDir, getAnchorDir(packageRoot));
    expect(inspection.status).toBe("identical");
  });
});

describe("installGuide - replacement", () => {
  test("replaces outdated guide with source bytes", async () => {
    const newContent = "# Updated Guide\n\nNew content.\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, newContent);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old Guide\n");

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("outdated");
    expect(result.action).toBe("replaced");

    const installed = await readFile(join(targetDir, "vibe-guide.md"), "utf8");
    expect(installed).toBe(newContent);
  });

  test("byte-for-byte match after replacement", async () => {
    const content = "# Exact Guide\n\nPrecise bytes.\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Different\n");

    await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    const installed = await readFile(join(targetDir, "vibe-guide.md"), "utf8");
    expect(installed).toBe(content);

    // Verify idempotency
    const second = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });
    expect(second.status).toBe("identical");
    expect(second.action).toBe("skipped");
  });
});

describe("installGuide - skip identical", () => {
  test("skips installation when destination matches source", async () => {
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("identical");
    expect(result.action).toBe("skipped");
  });
});

describe("installGuide - dry-run no-write", () => {
  test("dry-run plans replace without writing to filesystem", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# New\n");
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old\n");

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("outdated");
    expect(result.action).toBe("would-replace");

    // Original content preserved
    const content = await readFile(join(targetDir, "vibe-guide.md"), "utf8");
    expect(content).toBe("# Old\n");
  });

  test("dry-run plans skip for identical destination", async () => {
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("identical");
    expect(result.action).toBe("would-skip");
  });
});

describe("installGuide - symlink failures", () => {
  test("rejects symlink destination with no-follow check", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const realGuide = await createTempDir(tempDirs);
    await writeFile(join(realGuide, "vibe-guide.md"), "# Real Guide\n");
    await symlink(
      join(realGuide, "vibe-guide.md"),
      join(targetDir, "vibe-guide.md"),
    );

    await expect(
      installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallError);
    await expect(
      installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/symlink/i);
  });

  test("rejects symlink destination on dry-run", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const realGuide = await createTempDir(tempDirs);
    await writeFile(join(realGuide, "vibe-guide.md"), "# Real Guide\n");
    await symlink(
      join(realGuide, "vibe-guide.md"),
      join(targetDir, "vibe-guide.md"),
    );

    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallError);
  });

  test("rejects symlink target root directory with no-follow check", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const realTargetDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkTargetDir = join(parentDir, "symlinked-target");
    await symlink(realTargetDir, symlinkTargetDir, "dir");

    await expect(
      installGuide(symlinkTargetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);
    await expect(
      installGuide(symlinkTargetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/symlink/i);

    expect(await fileExists(join(realTargetDir, "vibe-guide.md"))).toBe(false);
  });

  test("rejects symlink target root directory on dry-run", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const realTargetDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkTargetDir = join(parentDir, "symlinked-target");
    await symlink(realTargetDir, symlinkTargetDir, "dir");

    await expect(
      installGuide(symlinkTargetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);
    await expect(
      installGuide(symlinkTargetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/symlink/i);
  });

  test("rejects target path traversing a symlink ancestor directory on install", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const realDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkDir = join(parentDir, "symlinked-dir");
    await symlink(realDir, symlinkDir, "dir");

    const targetWithSymlinkAncestor = join(symlinkDir, "nested");

    await expect(
      installGuide(targetWithSymlinkAncestor, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallError);

    expect(await fileExists(join(realDir, "nested", "vibe-guide.md"))).toBe(
      false,
    );
  });

  test("rejects target path traversing a symlink ancestor directory on dry-run", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const realDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkDir = join(parentDir, "symlinked-dir");
    await symlink(realDir, symlinkDir, "dir");

    const targetWithSymlinkAncestor = join(symlinkDir, "nested");

    await expect(
      installGuide(targetWithSymlinkAncestor, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallError);
  });
});

describe("installGuide - invalid target failures", () => {
  test("rejects target path that exists as a file", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    // Create a file instead of a directory
    const targetFile = join(base, "target-file");
    await writeFile(targetFile, "not a directory");

    await expect(
      installGuide(targetFile, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallError);
  });

  test("rejects when target parent is not a directory", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    // Create a file to use as parent
    const parentFile = join(base, "not-a-dir");
    await writeFile(parentFile, "file content");
    const targetDir = join(parentFile, "guide");

    await expect(
      installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);
    await expect(
      installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/is not a directory/);
  });
});

describe("installGuide - unwritable target failures", () => {
  test("rejects no write access to target parent", async () => {
    if (process.getuid?.() === 0) {
      // Root bypasses permission checks
      return;
    }
    const packageRoot = await createGuidePackageRoot(tempDirs);
    // Create a parent directory that exists but is read-only
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "readonly-parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "guide");
    // Make parent read-only
    await chmod(parentDir, 0o555);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallValidationError);
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow("No write access");
      expect(await dirExists(targetDir)).toBe(false);
    } finally {
      await chmod(parentDir, 0o755);
    }
  });
});

describe("installGuide - missing source failures", () => {
  test("rejects missing guide source", async () => {
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), '{"name":"test"}');
    // No docs/ directory or vibe-guide.md
    const srcUtils = join(packageRoot, "src", "utils");
    await mkdir(srcUtils, { recursive: true });
    const targetDir = await createTempDir(tempDirs);

    await expect(
      installGuide(targetDir, {
        dryRun: false,
        anchorDir: srcUtils,
      }),
    ).rejects.toThrow(GuideInstallError);
    await expect(
      installGuide(targetDir, {
        dryRun: false,
        anchorDir: srcUtils,
      }),
    ).rejects.toThrow(/Source error/);
  });
});

describe("installGuide - copy fault failures", () => {
  test("surfaces copy failure as GuideInstallError", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    await chmod(targetDir, 0o555);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
    } finally {
      await chmod(targetDir, 0o755);
    }
  });

  test("preserves outdated destination on write fault during replacement", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const destPath = join(targetDir, "vibe-guide.md");

    const oldContent = "# Old Outdated Guide\n";
    await writeFile(destPath, oldContent);

    const fsPromises = await import("node:fs/promises");
    const originalWriteFile = fsPromises.writeFile;
    const spy = spyOn(fsPromises, "writeFile");
    spy.mockImplementation((path, data, options) => {
      if (
        typeof path === "string" &&
        (path.includes(".vibe-guide.tmp") || path.endsWith("vibe-guide.md"))
      ) {
        throw new Error("Disk write error");
      }
      return originalWriteFile(path, data, options);
    });

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);

      const preservedContent = await fsPromises.readFile(destPath, "utf8");
      expect(preservedContent).toBe(oldContent);
    } finally {
      spy.mockRestore();
    }
  });

  test("surfaces rename failure during atomic install as GuideInstallError", async () => {
    const packageRoot = await createGuidePackageRoot(
      tempDirs,
      "# Fresh Guide\n",
    );
    const targetDir = await createTempDir(tempDirs);

    const fsPromises = await import("node:fs/promises");
    const spy = spyOn(fsPromises, "rename");
    spy.mockImplementation(() => {
      throw new Error("EXDEV: cross-device rename");
    });

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(/Failed to install guide/);
      // Temp file cleaned up
      expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("surfaces mkdir failure during install as GuideInstallError", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# Guide\n");
    const base = await createTempDir(tempDirs);

    const fsPromises = await import("node:fs/promises");
    const spy = spyOn(fsPromises, "mkdir");
    spy.mockImplementation((() => {
      throw new Error("EACCES: permission denied");
    }) as typeof fsPromises.mkdir);

    try {
      await expect(
        installGuide(join(base, "target"), {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
      await expect(
        installGuide(join(base, "target"), {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(/Failed to create target/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installGuide - inspection fault failures", () => {
  test("surfaces compareGuideHash GuideSourceError as install error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# Guide\n");
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Target\n");

    const guideModule = await import("../src/utils/guide.js");
    const spy = spyOn(guideModule, "compareGuideHash");
    spy.mockImplementation(() => {
      throw new guideModule.GuideSourceError("Source vanished");
    });

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(/Source error: Source vanished/);
    } finally {
      spy.mockRestore();
    }
  });

  test("surfaces compareGuideHash GuideTargetError as install error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# Guide\n");
    const targetDir = await createTempDir(tempDirs);

    const guideModule = await import("../src/utils/guide.js");
    const spy = spyOn(guideModule, "compareGuideHash");
    spy.mockImplementation(() => {
      throw new guideModule.GuideTargetError("Target unreachable");
    });

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(/Target error: Target unreachable/);
    } finally {
      spy.mockRestore();
    }
  });

  test("surfaces compareGuideHash unexpected error as install error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# Guide\n");
    const targetDir = await createTempDir(tempDirs);

    const guideModule = await import("../src/utils/guide.js");
    const spy = spyOn(guideModule, "compareGuideHash");
    spy.mockImplementation(() => {
      throw new Error("Unexpected runtime error");
    });

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(/Inspection failed: Unexpected runtime error/);
    } finally {
      spy.mockRestore();
    }
  });

  test("surfaces readGuideSourceBuffer unexpected error as install error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# Guide\n");
    const targetDir = await createTempDir(tempDirs);

    const guideModule = await import("../src/utils/guide.js");
    const spy = spyOn(guideModule, "readGuideSourceBuffer");
    spy.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(/Failed to read guide source: EACCES/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installGuide - validateTarget edge cases", () => {
  test("rejects target when lstat on targetRoot fails with EACCES", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const targetDir = join(base, "locked");
    await mkdir(targetDir);
    // Make the directory unreadable to simulate lstat failure
    await chmod(targetDir, 0o000);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
    } finally {
      await chmod(targetDir, 0o755);
    }
  });

  test("rejects when target root is root filesystem and does not exist", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs);

    // /nonexistent-root-xyz should not exist
    await expect(
      installGuide("/nonexistent-root-xyz", {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallError);
  });

  test("rejects when ancestorStat lstat throws non-ENOENT error", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    // Create a parent dir, then make it unreadable to cause lstat failure
    const parentDir = join(base, "parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "target");
    await chmod(parentDir, 0o000);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallError);
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("rejects immediate parent lstat EACCES with validation error from symlink walk", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    // Create a nested path: parent exists, target child doesn't.
    // Then fail lstat on the immediate parent of targetRoot.
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "nonexistent-target");

    const fsPromises = await import("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");

    // Fail lstat on the immediate parent of targetRoot
    spy.mockImplementation(((p: Parameters<typeof fsPromises.lstat>[0]) => {
      if (p === parentDir) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalLstat(p);
    }) as typeof fsPromises.lstat);

    try {
      const error = await installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }).catch((e: unknown) => e);
      // The symlink walk runs before immediate-parent inspection, so a
      // non-ENOENT/non-ENOTDIR lstat fault at the immediate parent is
      // classified as a validation failure by the walk.
      expect(error).toBeInstanceOf(GuideInstallValidationError);
      expect(error).toBeInstanceOf(GuideInstallError);
      expect((error as Error).message).toBe(
        `Failed to inspect target path '${parentDir}': EACCES: permission denied`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects when ancestor above the immediate parent lstat fails with non-ENOENT/non-ENOTDIR error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "nonexistent-target");

    const fsPromises = await import("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");

    // Fail lstat on base — an ancestor above the immediate parent — so
    // the symlink walk classifies it as a validation failure.
    spy.mockImplementation(((p: Parameters<typeof fsPromises.lstat>[0]) => {
      if (typeof p === "string" && p === base) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalLstat(p);
    }) as typeof fsPromises.lstat);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallValidationError);
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow("Failed to inspect target path");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installGuide - existing root preflight", () => {
  test("rejects existing regular-file target root on dry-run", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const targetFile = join(base, "existing-file");
    await writeFile(targetFile, "not a directory");

    await expect(
      installGuide(targetFile, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);
    await expect(
      installGuide(targetFile, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/not a directory/);

    // Target file content preserved
    const content = await readFile(targetFile, "utf8");
    expect(content).toBe("not a directory");
  });

  test("rejects existing regular-file target root on install", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const targetFile = join(base, "existing-file");
    await writeFile(targetFile, "not a directory");

    await expect(
      installGuide(targetFile, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);

    // Target file content preserved (no mutation)
    const content = await readFile(targetFile, "utf8");
    expect(content).toBe("not a directory");
  });

  test("rejects existing non-writable directory target root on dry-run", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    // Mock access to deny write on the target directory — deterministic
    // under root, where chmod-based permission denial is ineffective.
    const fsPromises = await import("node:fs/promises");
    const originalAccess = fsPromises.access;
    const spy = spyOn(fsPromises, "access");
    spy.mockImplementation(((path: string, mode?: number) => {
      if (path === targetDir && mode === constants.W_OK) {
        throw new Error("EACCES: permission denied");
      }
      return originalAccess(path, mode);
    }) as typeof fsPromises.access);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallValidationError);
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(/No write access/);
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects existing non-writable directory target root on install", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    // Mock access to deny write on the target directory — deterministic
    // under root, where chmod-based permission denial is ineffective.
    const fsPromises = await import("node:fs/promises");
    const originalAccess = fsPromises.access;
    const spy = spyOn(fsPromises, "access");
    spy.mockImplementation(((path: string, mode?: number) => {
      if (path === targetDir && mode === constants.W_OK) {
        throw new Error("EACCES: permission denied");
      }
      return originalAccess(path, mode);
    }) as typeof fsPromises.access);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: false,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallValidationError);

      // No guide file created
      expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("retains missing status and would-install for existing writable root", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("would-install");
  });

  test("retains identical status and would-skip for existing writable root", async () => {
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("identical");
    expect(result.action).toBe("would-skip");
  });

  test("retains outdated status and would-replace for existing writable root", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# New\n");
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old\n");

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("outdated");
    expect(result.action).toBe("would-replace");
  });

  test("retains installed action for existing writable root", async () => {
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("installed");
    expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(true);
  });

  test("retains replaced action for existing writable root", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# New\n");
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old\n");

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("outdated");
    expect(result.action).toBe("replaced");
  });

  test("retains skipped action for existing writable root", async () => {
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("identical");
    expect(result.action).toBe("skipped");
  });

  test("rejects existing regular-file root via access mock for deterministic denial", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const targetFile = join(base, "regular-file");
    await writeFile(targetFile, "content");

    // Mock access to deny write on the target file
    const fsPromises = await import("node:fs/promises");
    const originalAccess = fsPromises.access;
    const spy = spyOn(fsPromises, "access");
    spy.mockImplementation(((path: string, mode?: number) => {
      if (path === targetFile && mode === constants.W_OK) {
        throw new Error("EACCES: permission denied");
      }
      return originalAccess(path, mode);
    }) as typeof fsPromises.access);

    try {
      await expect(
        installGuide(targetFile, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallValidationError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installGuide - validateGuideImmediateParent", () => {
  test("rejects missing immediate parent on dry-run without creating any parent chain", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const targetDir = join(base, "nonexistent-parent", "target");

    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);
    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/does not exist/);

    expect(await dirExists(join(base, "nonexistent-parent"))).toBe(false);
    expect(await dirExists(targetDir)).toBe(false);
  });

  test("rejects missing immediate parent on install without creating any parent chain", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const targetDir = join(base, "nonexistent-parent", "target");

    await expect(
      installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);

    expect(await dirExists(join(base, "nonexistent-parent"))).toBe(false);
    expect(await dirExists(targetDir)).toBe(false);
  });

  test("rejects non-directory immediate parent with validation error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const parentFile = join(base, "not-a-directory");
    await writeFile(parentFile, "file content");
    const targetDir = join(parentFile, "target");

    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);
    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/is not a directory/);
  });

  test("rejects unwritable immediate parent with validation error", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "readonly-parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "target");
    await chmod(parentDir, 0o555);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallValidationError);
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow("No write access");
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("rejects immediate parent lstat failure with install error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    // A regular file as an intermediate component makes the immediate
    // parent path uninspectable (ENOTDIR) deterministically, including
    // when running as root.
    const blockerFile = join(base, "blocker-file");
    await writeFile(blockerFile, "file content");
    const parentDir = join(blockerFile, "subdir");
    const targetDir = join(parentDir, "target");

    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallError);
    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(`Failed to inspect target parent '${parentDir}'`);
  });

  test("retains missing status and would-install for existing writable parent with absent target", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const targetDir = join(parentDir, "new-target");

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("would-install");
    expect(await dirExists(targetDir)).toBe(false);
  });

  test("installs beneath existing writable parent with absent target", async () => {
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const parentDir = await createTempDir(tempDirs);
    const targetDir = join(parentDir, "new-target");

    const result = await installGuide(targetDir, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("installed");
    expect(await dirExists(targetDir)).toBe(true);
    expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(true);
  });

  test("retains outdated status and would-replace for existing writable parent", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs, "# New\n");
    const parentDir = await createTempDir(tempDirs);
    const targetDir = join(parentDir, "new-target");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old\n");

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("outdated");
    expect(result.action).toBe("would-replace");

    const content = await readFile(join(targetDir, "vibe-guide.md"), "utf8");
    expect(content).toBe("# Old\n");
  });

  test("retains identical status and would-skip for existing writable parent", async () => {
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const parentDir = await createTempDir(tempDirs);
    const targetDir = join(parentDir, "new-target");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "vibe-guide.md"), content);

    const result = await installGuide(targetDir, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("identical");
    expect(result.action).toBe("would-skip");
  });

  test("symlink-component check runs before immediate parent inspection", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const realDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkDir = join(parentDir, "symlinked");
    await symlink(realDir, symlinkDir, "dir");

    const targetDir = join(symlinkDir, "target");

    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(GuideInstallValidationError);
    await expect(
      installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      }),
    ).rejects.toThrow(/symlink/i);
  });
});

describe("installGuide - existing writable root beneath non-writable parent", () => {
  async function createWritableRootInReadonlyParent(
    tracking: string[],
  ): Promise<{ parentDir: string; targetDir: string }> {
    const base = await createTempDir(tracking);
    const parentDir = join(base, "readonly-parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "existing-root");
    await mkdir(targetDir);
    return { parentDir, targetDir };
  }

  test("retains missing status and would-install on dry-run for existing writable root beneath non-writable parent", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const { parentDir, targetDir } =
      await createWritableRootInReadonlyParent(tempDirs);
    await chmod(parentDir, 0o555);

    try {
      const result = await installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe("missing");
      expect(result.action).toBe("would-install");
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("installs into existing writable root beneath non-writable parent", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs, "# Guide\n");
    const { parentDir, targetDir } =
      await createWritableRootInReadonlyParent(tempDirs);
    await chmod(parentDir, 0o555);

    try {
      const result = await installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe("missing");
      expect(result.action).toBe("installed");
      expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(true);
      const installed = await readFile(
        join(targetDir, "vibe-guide.md"),
        "utf8",
      );
      expect(installed).toBe("# Guide\n");
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("retains identical status and would-skip on dry-run for existing writable root beneath non-writable parent", async () => {
    if (process.getuid?.() === 0) return;
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const { parentDir, targetDir } =
      await createWritableRootInReadonlyParent(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);
    await chmod(parentDir, 0o555);

    try {
      const result = await installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe("identical");
      expect(result.action).toBe("would-skip");
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("retains outdated status and would-replace on dry-run for existing writable root beneath non-writable parent", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs, "# New\n");
    const { parentDir, targetDir } =
      await createWritableRootInReadonlyParent(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old\n");
    await chmod(parentDir, 0o555);

    try {
      const result = await installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe("outdated");
      expect(result.action).toBe("would-replace");
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("replaces into existing writable root beneath non-writable parent", async () => {
    if (process.getuid?.() === 0) return;
    const packageRoot = await createGuidePackageRoot(tempDirs, "# New\n");
    const { parentDir, targetDir } =
      await createWritableRootInReadonlyParent(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), "# Old\n");
    await chmod(parentDir, 0o555);

    try {
      const result = await installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe("outdated");
      expect(result.action).toBe("replaced");
      const installed = await readFile(
        join(targetDir, "vibe-guide.md"),
        "utf8",
      );
      expect(installed).toBe("# New\n");
    } finally {
      await chmod(parentDir, 0o755);
    }
  });

  test("skips in existing writable root beneath non-writable parent", async () => {
    if (process.getuid?.() === 0) return;
    const content = "# Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const { parentDir, targetDir } =
      await createWritableRootInReadonlyParent(tempDirs);
    await writeFile(join(targetDir, "vibe-guide.md"), content);
    await chmod(parentDir, 0o555);

    try {
      const result = await installGuide(targetDir, {
        dryRun: false,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe("identical");
      expect(result.action).toBe("skipped");
    } finally {
      await chmod(parentDir, 0o755);
    }
  });
});

describe("installGuide - parent write check scoped to absent roots", () => {
  test("skips parent write check for existing writable root when parent access is denied", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "existing-root");
    await mkdir(targetDir);

    const fsPromises = await import("node:fs/promises");
    const originalAccess = fsPromises.access;
    const spy = spyOn(fsPromises, "access");
    spy.mockImplementation(((path: string, mode?: number) => {
      if (path === parentDir && mode === constants.W_OK) {
        throw new Error("EACCES: permission denied");
      }
      return originalAccess(path, mode);
    }) as typeof fsPromises.access);

    try {
      const result = await installGuide(targetDir, {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe("missing");
      expect(result.action).toBe("would-install");
    } finally {
      spy.mockRestore();
    }
  });

  test("keeps parent write check for absent target root when parent access is denied", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "absent-target");

    const fsPromises = await import("node:fs/promises");
    const originalAccess = fsPromises.access;
    const spy = spyOn(fsPromises, "access");
    spy.mockImplementation(((path: string, mode?: number) => {
      if (path === parentDir && mode === constants.W_OK) {
        throw new Error("EACCES: permission denied");
      }
      return originalAccess(path, mode);
    }) as typeof fsPromises.access);

    try {
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(GuideInstallValidationError);
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow("No write access to target parent");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("installGuide - lstat targetRoot non-ENOENT non-ENOTDIR failure", () => {
  test("throws GuideInstallValidationError when preflight lstat on targetRoot fails after symlink walk succeeds", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const targetDir = join(base, "target");
    await mkdir(targetDir);

    const fsPromises = await import("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");
    let lstatTargetDirCalls = 0;
    spy.mockImplementation(((p: Parameters<typeof fsPromises.lstat>[0]) => {
      if (typeof p === "string" && p === targetDir) {
        lstatTargetDirCalls++;
        // First call is from the symlink walk — let it succeed.
        // Subsequent calls (preflight lstat) — throw EACCES.
        if (lstatTargetDirCalls > 1) {
          const err = new Error(
            "EACCES: permission denied",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
      }
      return originalLstat(p);
    }) as typeof fsPromises.lstat);

    try {
      // Single installGuide call — the counter is stable across one call.
      // The symlink walk lstats targetDir once (success), then the preflight
      // lstats it again (EACCES) hitting the else branch at lines 142-144.
      await expect(
        installGuide(targetDir, {
          dryRun: true,
          anchorDir: getAnchorDir(packageRoot),
        }),
      ).rejects.toThrow(
        `Failed to inspect target root '${targetDir}': EACCES: permission denied`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
