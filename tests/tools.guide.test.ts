import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
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

      const nestedResult = await installGuide("~/nested/target", {
        dryRun: true,
        anchorDir: getAnchorDir(packageRoot),
      });

      expect(nestedResult.target).toBe(join(fakeHome, "nested", "target"));
      expect(nestedResult.ok).toBe(true);
    } finally {
      process.env["HOME"] = originalHome;
    }
  });

  test("resolves absent nested target path for dry-run without writing", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const absentTarget = join(base, "nested", "deep", "target");

    const result = await installGuide(absentTarget, {
      dryRun: true,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.target).toBe(absentTarget);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("would-install");
    expect(await dirExists(join(base, "nested"))).toBe(false);
  });

  test("creates absent nested target path recursively on install", async () => {
    const content = "# Nested Guide\n";
    const packageRoot = await createGuidePackageRoot(tempDirs, content);
    const base = await createTempDir(tempDirs);
    const absentTarget = join(base, "nested", "deep", "target");

    const result = await installGuide(absentTarget, {
      dryRun: false,
      anchorDir: getAnchorDir(packageRoot),
    });

    expect(result.target).toBe(absentTarget);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("installed");
    expect(await dirExists(absentTarget)).toBe(true);
    expect(await fileExists(join(absentTarget, "vibe-guide.md"))).toBe(true);

    const installed = await readFile(
      join(absentTarget, "vibe-guide.md"),
      "utf8",
    );
    expect(installed).toBe(content);
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
    ).rejects.toThrow(GuideInstallError);
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

  test("rejects when intermediate path component lstat fails with EACCES (not targetRoot / not destPath)", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    // Create a nested path: parent exists, target child doesn't.
    // Then fail lstat on parentDir (intermediate component — not targetRoot, not destPath).
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "nonexistent-target");

    const fsPromises = await import("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");

    // Fail lstat on parentDir (intermediate component, not targetRoot, not destPath)
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
      ).rejects.toThrow(/Failed to inspect target path/);
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects when findExistingAncestor lstat fails with non-ENOENT/non-ENOTDIR error", async () => {
    const packageRoot = await createGuidePackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const parentDir = join(base, "parent");
    await mkdir(parentDir);
    const targetDir = join(parentDir, "nonexistent-target");

    const fsPromises = await import("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");

    // Fail lstat on parentDir when findExistingAncestor walks up from
    // nonexistent targetDir.
    spy.mockImplementation(((p: Parameters<typeof fsPromises.lstat>[0]) => {
      if (typeof p === "string" && p === parentDir) {
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
      ).rejects.toThrow("Failed to inspect target path");
    } finally {
      spy.mockRestore();
    }
  });
});
