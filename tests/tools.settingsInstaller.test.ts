import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import * as realFsPromises from "node:fs/promises";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

// ── Fault-injection seams ──────────────────────────────────────────────────
// mock.module wraps node:fs and node:fs/promises so tests can (a) prove the
// installer never reads destination bytes, (b) prove staging bytes are
// written through the exclusively reserved handle and closed before rename,
// and (c) inject staging write and rename failures deterministically. The
// real modules are spread through so all other behavior is unchanged. Import
// the module under test AFTER these registrations so the mocks take effect.

let failWriteFile = false;
let failRename = false;
let failReadFileSync = false;
let failMkdir = false;
let failAccess = false;
let failLstat = false;
let failLstatAfter = -1; // fail after N successful calls (for targeted injection)
let lstatCallCount = 0;
let failLstatSync = false;
let failLstatSyncAfter = -1;
let failLstatSyncPath: string | null = null;
let lstatSyncCallCount = 0;
const readFileSyncCalls: string[] = [];
const writeFileCalls: unknown[][] = [];
const renameCalls: unknown[][] = [];

// Capture real fs functions before mock registration: once mock.module runs,
// the namespace bindings below resolve to the mocked module.
const realReadFileSync = realFs.readFileSync;
const realLstatSync = realFs.lstatSync;
const realWriteFile = realFsPromises.writeFile;
const realRename = realFsPromises.rename;
const realMkdir = realFsPromises.mkdir;
const realRm = realFsPromises.rm;
const realAccess = realFsPromises.access;
const realLstat = realFsPromises.lstat;

const trackedReadFileSync = ((path: unknown, ...rest: unknown[]) => {
  readFileSyncCalls.push(String(path));
  if (failReadFileSync) {
    throw new Error("injected readFileSync failure");
  }
  return (realReadFileSync as unknown as (...args: unknown[]) => unknown)(
    path,
    ...rest,
  );
}) as unknown as typeof realFs.readFileSync;

mock.module("node:fs", () => ({
  ...realFs,
  readFileSync: trackedReadFileSync,
  lstatSync: ((path: unknown, ...rest: unknown[]) => {
    lstatSyncCallCount++;
    if (
      failLstatSync ||
      (failLstatSyncPath !== null && String(path) === failLstatSyncPath) ||
      (failLstatSyncAfter >= 0 && lstatSyncCallCount > failLstatSyncAfter)
    ) {
      const err = new Error("injected lstatSync failure: EACCES");
      (err as NodeJS.ErrnoException).code = "EACCES";
      throw err;
    }
    return (realLstatSync as unknown as (...args: unknown[]) => unknown)(
      path,
      ...rest,
    );
  }) as unknown as typeof realFs.lstatSync,
}));

mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  mkdir: async (...args: Parameters<typeof realMkdir>) => {
    if (failMkdir) {
      throw new Error("injected mkdir failure");
    }
    return realMkdir(...args);
  },
  writeFile: async (...args: Parameters<typeof realFsPromises.writeFile>) => {
    writeFileCalls.push(args);
    if (failWriteFile) {
      throw new Error("injected staging write failure");
    }
    return realWriteFile(...args);
  },
  rename: async (...args: Parameters<typeof realFsPromises.rename>) => {
    renameCalls.push(args);
    if (failRename) {
      throw new Error("injected staging rename failure");
    }
    return realRename(...args);
  },
  access: async (...args: Parameters<typeof realAccess>) => {
    if (failAccess) {
      const err = new Error("injected access failure");
      (err as NodeJS.ErrnoException).code = "EACCES";
      throw err;
    }
    return realAccess(...args);
  },
  lstat: async (...args: Parameters<typeof realLstat>) => {
    lstatCallCount++;
    if (failLstat || (failLstatAfter >= 0 && lstatCallCount > failLstatAfter)) {
      const err = new Error("injected lstat failure: EACCES");
      (err as NodeJS.ErrnoException).code = "EACCES";
      throw err;
    }
    return realLstat(...args);
  },
}));

import {
  installSettings,
  SettingsInstallError,
  SettingsInstallValidationError,
} from "../src/tools/settingsInstaller.js";
import {
  cleanupTempDirs,
  createTempDir,
  dirExists,
  fileExists,
} from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];

beforeEach(async () => {
  tempDirs = [];
  readFileSyncCalls.length = 0;
  writeFileCalls.length = 0;
  renameCalls.length = 0;
});

afterEach(async () => {
  failWriteFile = false;
  failRename = false;
  failReadFileSync = false;
  failMkdir = false;
  failAccess = false;
  failLstat = false;
  failLstatAfter = -1;
  lstatCallCount = 0;
  failLstatSync = false;
  failLstatSyncAfter = -1;
  failLstatSyncPath = null;
  lstatSyncCallCount = 0;
  await cleanupTempDirs(tempDirs);
});

/**
 * Create a minimal package root with a settings.example.json file.
 */
async function createSettingsPackageRoot(
  tracking: string[],
  content: string | Buffer = JSON.stringify({
    provider: "openai",
    providers: [
      {
        name: "openai",
        spec: "openai",
        envVar: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
      },
    ],
  }),
): Promise<string> {
  const root = await createTempDir(tracking);
  await writeFile(join(root, "package.json"), '{"name":"test-package"}');
  await writeFile(join(root, "settings.example.json"), content);
  return root;
}

describe("installSettings - target resolution", () => {
  test("resolves explicit absolute target", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    const result = await installSettings(targetDir, {
      dryRun: true,
      sourceAnchor: packageRoot,
    });

    expect(result.destination).toBe(join(targetDir, "settings.json"));
    expect(result.ok).toBe(true);
  });

  test("resolves cwd target", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);

    const result = await installSettings(".", {
      dryRun: true,
      sourceAnchor: packageRoot,
    });

    expect(result.destination).toBe(join(process.cwd(), "settings.json"));
    expect(result.ok).toBe(true);
  });

  test("resolves tilde target", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const fakeHome = await createTempDir(tempDirs);
    const originalHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;

    try {
      const result = await installSettings("~", {
        dryRun: true,
        sourceAnchor: packageRoot,
      });

      expect(result.destination).toBe(join(fakeHome, "settings.json"));
      expect(result.ok).toBe(true);
    } finally {
      process.env["HOME"] = originalHome;
    }
  });

  test("rejects absent nested target path on dry-run when parent does not exist", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const absentTarget = join(base, "nested", "deep", "target");

    await expect(
      installSettings(absentTarget, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);

    expect(await dirExists(join(base, "nested"))).toBe(false);
    expect(await dirExists(absentTarget)).toBe(false);
  });

  test("rejects absent nested target path on install when parent does not exist", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const absentTarget = join(base, "nested", "deep", "target");

    await expect(
      installSettings(absentTarget, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);

    expect(await dirExists(join(base, "nested"))).toBe(false);
    expect(await dirExists(absentTarget)).toBe(false);
  });

  test("names only settings.json beneath target", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    await installSettings(targetDir, {
      dryRun: false,
      sourceAnchor: packageRoot,
    });

    // Only settings.json should exist
    const entries = await readdir(targetDir);
    expect(entries).toEqual(["settings.json"]);
  });
});

describe("installSettings - presence status reports", () => {
  test("reports missing status when destination does not exist", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    const result = await installSettings(targetDir, {
      dryRun: true,
      sourceAnchor: packageRoot,
    });

    expect(result.status).toBe("missing");
    expect(result.action).toBe("would-install");
  });

  test("reports present status when destination matches source", async () => {
    const content = JSON.stringify({
      provider: "openai",
      providers: [
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "settings.json"), content);

    const result = await installSettings(targetDir, {
      dryRun: true,
      sourceAnchor: packageRoot,
    });

    expect(result.status).toBe("present");
    expect(result.action).toBe("would-skip");
  });

  test("never reads destination bytes without force", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const oldContent = JSON.stringify({ provider: "old", providers: [] });
    await writeFile(join(targetDir, "settings.json"), oldContent);

    const result = await installSettings(targetDir, {
      dryRun: false,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("skipped");

    // Only the bundled source is read; the present destination is never read
    const destPath = join(targetDir, "settings.json");
    const sourcePath = join(packageRoot, "settings.example.json");
    expect(readFileSyncCalls).toContain(sourcePath);
    expect(readFileSyncCalls).not.toContain(destPath);

    // Original content preserved
    const content = await readFile(destPath, "utf8");
    expect(content).toBe(oldContent);
  });
});

describe("installSettings - byte-for-byte install", () => {
  test("installs settings to target", async () => {
    const content = JSON.stringify({
      provider: "openai",
      providers: [
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);

    const result = await installSettings(targetDir, {
      dryRun: false,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("installed");
    expect(await fileExists(join(targetDir, "settings.json"))).toBe(true);

    const installed = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(installed).toBe(content);
  });

  test("copies exact source bytes on install", async () => {
    const content = JSON.stringify({
      provider: "anthropic",
      providers: [
        {
          name: "anthropic",
          spec: "anthropic",
          envVar: "ANTHROPIC_API_KEY",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);

    await installSettings(targetDir, {
      dryRun: false,
      sourceAnchor: packageRoot,
    });

    const installed = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(installed).toBe(content);
  });
});

describe("installSettings - replacement", () => {
  test("replaces present settings with source bytes when force is true", async () => {
    const newContent = JSON.stringify({
      provider: "openai",
      providers: [
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, newContent);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(
      join(targetDir, "settings.json"),
      JSON.stringify({ provider: "old", providers: [] }),
    );

    const result = await installSettings(targetDir, {
      dryRun: false,
      force: true,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("replaced");

    const installed = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(installed).toBe(newContent);
  });

  test("byte-for-byte match after replacement", async () => {
    const content = JSON.stringify({
      provider: "gemini",
      providers: [
        {
          name: "gemini",
          spec: "gemini",
          envVar: "GEMINI_API_KEY",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(
      join(targetDir, "settings.json"),
      JSON.stringify({ provider: "old", providers: [] }),
    );

    await installSettings(targetDir, {
      dryRun: false,
      force: true,
      sourceAnchor: packageRoot,
    });

    const installed = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(installed).toBe(content);

    // Verify idempotency
    const second = await installSettings(targetDir, {
      dryRun: false,
      sourceAnchor: packageRoot,
    });
    expect(second.status).toBe("present");
    expect(second.action).toBe("skipped");
  });
});

describe("installSettings - skip present destination", () => {
  test("skips installation when destination matches source", async () => {
    const content = JSON.stringify({
      provider: "openai",
      providers: [
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "settings.json"), content);

    const result = await installSettings(targetDir, {
      dryRun: false,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("skipped");
  });
});

describe("installSettings - dry-run no-write", () => {
  test("dry-run plans skip for present destination without force", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const oldContent = JSON.stringify({ provider: "old", providers: [] });
    await writeFile(join(targetDir, "settings.json"), oldContent);

    const result = await installSettings(targetDir, {
      dryRun: true,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("present");
    // Without force, present destinations are skipped
    expect(result.action).toBe("would-skip");

    // Original content preserved
    const content = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(content).toBe(oldContent);
  });

  test("dry-run plans skip for present destination matching source", async () => {
    const content = JSON.stringify({
      provider: "openai",
      providers: [
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "settings.json"), content);

    const result = await installSettings(targetDir, {
      dryRun: true,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("would-skip");
  });

  test("dry-run does not create target root", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    const absentTarget = join(base, "new-root");

    const result = await installSettings(absentTarget, {
      dryRun: true,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("missing");
    expect(result.action).toBe("would-install");

    // Root should not have been created
    expect(await dirExists(absentTarget)).toBe(false);
  });
});

describe("installSettings - force flag", () => {
  test("force replaces present destination", async () => {
    const newContent = JSON.stringify({
      provider: "openai",
      providers: [
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, newContent);
    const targetDir = await createTempDir(tempDirs);
    const oldContent = JSON.stringify({
      provider: "old",
      providers: [
        {
          name: "old",
          spec: "openai",
          envVar: "OLD_KEY",
          baseUrl: "https://old.example.com/v1",
        },
      ],
    });
    await writeFile(join(targetDir, "settings.json"), oldContent);

    const result = await installSettings(targetDir, {
      dryRun: false,
      force: true,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("replaced");

    const installed = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(installed).toBe(newContent);
  });

  test("force replaces identical destination", async () => {
    const content = JSON.stringify({
      provider: "openai",
      providers: [
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
      ],
    });
    const packageRoot = await createSettingsPackageRoot(tempDirs, content);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(join(targetDir, "settings.json"), content);

    const result = await installSettings(targetDir, {
      dryRun: false,
      force: true,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("replaced");

    // Replaced destination still carries the source bytes
    const installed = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(installed).toBe(content);
  });

  test("force with dry-run shows would-replace", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    await writeFile(
      join(targetDir, "settings.json"),
      JSON.stringify({ provider: "old", providers: [] }),
    );

    const result = await installSettings(targetDir, {
      dryRun: true,
      force: true,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("would-replace");
  });

  test("without force, present destination is skipped", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const oldContent = JSON.stringify({
      provider: "old",
      providers: [
        {
          name: "old",
          spec: "openai",
          envVar: "OLD_KEY",
          baseUrl: "https://old.example.com/v1",
        },
      ],
    });
    await writeFile(join(targetDir, "settings.json"), oldContent);

    const result = await installSettings(targetDir, {
      dryRun: false,
      force: false,
      sourceAnchor: packageRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("present");
    expect(result.action).toBe("skipped");

    // Original content preserved
    const content = await readFile(join(targetDir, "settings.json"), "utf8");
    expect(content).toBe(oldContent);
  });
});

describe("installSettings - symlink failures", () => {
  test("rejects symlink destination with no-follow check", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const realSettings = await createTempDir(tempDirs);
    await writeFile(join(realSettings, "settings.json"), "{}");
    await symlink(
      join(realSettings, "settings.json"),
      join(targetDir, "settings.json"),
    );

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/symlink/i);
  });

  test("rejects symlink destination on dry-run", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const realSettings = await createTempDir(tempDirs);
    await writeFile(join(realSettings, "settings.json"), "{}");
    await symlink(
      join(realSettings, "settings.json"),
      join(targetDir, "settings.json"),
    );

    await expect(
      installSettings(targetDir, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
  });

  test("rejects symlink target root directory with no-follow check", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const realTargetDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkTargetDir = join(parentDir, "symlinked-target");
    await symlink(realTargetDir, symlinkTargetDir, "dir");

    await expect(
      installSettings(symlinkTargetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);
    await expect(
      installSettings(symlinkTargetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/symlink/i);

    expect(await fileExists(join(realTargetDir, "settings.json"))).toBe(false);
  });

  test("rejects symlink target root directory on dry-run", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const realTargetDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkTargetDir = join(parentDir, "symlinked-target");
    await symlink(realTargetDir, symlinkTargetDir, "dir");

    await expect(
      installSettings(symlinkTargetDir, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);
    await expect(
      installSettings(symlinkTargetDir, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/symlink/i);
  });

  test("rejects target path traversing a symlink ancestor directory on install", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const realDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkDir = join(parentDir, "symlinked-dir");
    await symlink(realDir, symlinkDir, "dir");

    const targetWithSymlinkAncestor = join(symlinkDir, "nested");

    await expect(
      installSettings(targetWithSymlinkAncestor, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);

    expect(await fileExists(join(realDir, "nested", "settings.json"))).toBe(
      false,
    );
  });

  test("rejects target path traversing a symlink ancestor directory on dry-run", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const realDir = await createTempDir(tempDirs);
    const parentDir = await createTempDir(tempDirs);
    const symlinkDir = join(parentDir, "symlinked-dir");
    await symlink(realDir, symlinkDir, "dir");

    const targetWithSymlinkAncestor = join(symlinkDir, "nested");

    await expect(
      installSettings(targetWithSymlinkAncestor, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
  });
});

describe("installSettings - invalid target failures", () => {
  test("rejects target path that exists as a file", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    // Create a file instead of a directory
    const targetFile = join(base, "target-file");
    await writeFile(targetFile, "not a directory");

    await expect(
      installSettings(targetFile, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);
  });

  test("rejects unwritable target root", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    await chmod(targetDir, 0o444);

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);

    // Restore permissions for cleanup
    await chmod(targetDir, 0o755);
  });

  test("rejects unwritable parent when target root absent", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    await chmod(base, 0o444);
    const absentTarget = join(base, "new-root");

    await expect(
      installSettings(absentTarget, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);

    // Restore permissions for cleanup
    await chmod(base, 0o755);
  });
});

describe("installSettings - source validation failures", () => {
  test("rejects unreadable source file", async () => {
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), '{"name":"test"}');
    // Create a directory instead of a file to simulate unreadable source
    await mkdir(join(packageRoot, "settings.example.json"), {
      recursive: true,
    });

    const targetDir = await createTempDir(tempDirs);

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
  });

  test("rejects non-regular source file", async () => {
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), '{"name":"test"}');
    // Create a symlink to non-existent target
    await symlink(
      "/nonexistent/path",
      join(packageRoot, "settings.example.json"),
    );

    const targetDir = await createTempDir(tempDirs);

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
  });

  test("rejects symlink source pointing at a regular file", async () => {
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), '{"name":"test"}');
    const realSource = await createTempDir(tempDirs);
    await writeFile(
      join(realSource, "settings.example.json"),
      JSON.stringify({
        provider: "openai",
        providers: [
          {
            name: "openai",
            spec: "openai",
            envVar: "OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      }),
    );
    await symlink(
      join(realSource, "settings.example.json"),
      join(packageRoot, "settings.example.json"),
    );

    const targetDir = await createTempDir(tempDirs);

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/symlink/i);

    expect(await fileExists(join(targetDir, "settings.json"))).toBe(false);
  });

  test("rejects malformed JSON source", async () => {
    const packageRoot = await createSettingsPackageRoot(
      tempDirs,
      "{ invalid json",
    );
    const targetDir = await createTempDir(tempDirs);

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/malformed|invalid/i);
  });

  test("rejects source that fails provider validation", async () => {
    const packageRoot = await createSettingsPackageRoot(
      tempDirs,
      JSON.stringify({ providers: [] }),
    );
    const targetDir = await createTempDir(tempDirs);

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/validation/i);
  });
});

describe("installSettings - staging and rename faults", () => {
  test("removes temp sibling and preserves destination when staging write fails", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const oldContent = JSON.stringify({ provider: "old", providers: [] });
    await writeFile(join(targetDir, "settings.json"), oldContent);

    failWriteFile = true;
    try {
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          force: true,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(SettingsInstallError);
    } finally {
      failWriteFile = false;
    }

    // Pre-existing destination preserved byte-for-byte
    expect(await readFile(join(targetDir, "settings.json"), "utf8")).toBe(
      oldContent,
    );
    // No staging residue remains
    const entries = await readdir(targetDir);
    expect(entries).toEqual(["settings.json"]);
  });

  test("removes temp sibling and preserves destination when rename fails", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const oldContent = JSON.stringify({ provider: "old", providers: [] });
    await writeFile(join(targetDir, "settings.json"), oldContent);

    failRename = true;
    try {
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          force: true,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(SettingsInstallError);
    } finally {
      failRename = false;
    }

    // Pre-existing destination preserved byte-for-byte
    expect(await readFile(join(targetDir, "settings.json"), "utf8")).toBe(
      oldContent,
    );
    // No staging residue remains
    const entries = await readdir(targetDir);
    expect(entries).toEqual(["settings.json"]);
  });
});

describe("installSettings - inspectDestination non-regular file", () => {
  test("rejects directory at settings.json path", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    // Create a directory where settings.json would be installed
    await mkdir(join(targetDir, "settings.json"), { recursive: true });

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/not a regular file/);
  });

  test("rejects directory at settings.json on dry-run", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    await mkdir(join(targetDir, "settings.json"), { recursive: true });

    await expect(
      installSettings(targetDir, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/not a regular file/);
  });
});

describe("installSettings - readFileSync failure after source validation", () => {
  test("fails with SettingsInstallError when source bytes cannot be read", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    failReadFileSync = true;
    try {
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(SettingsInstallError);
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(/Failed to read settings source/);
    } finally {
      failReadFileSync = false;
    }

    // Verify destination was never created
    expect(await fileExists(join(targetDir, "settings.json"))).toBe(false);
  });
});

describe("installSettings - mkdir failure", () => {
  test("fails with SettingsInstallError when target root cannot be created", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    // Remove the temp dir so installSettings creates it (triggers mkdir)
    await realRm(targetDir, { recursive: true, force: true });

    failMkdir = true;
    try {
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(SettingsInstallError);
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(/Failed to create target/);
    } finally {
      failMkdir = false;
      // Recreate for cleanup
      await realMkdir(targetDir, { recursive: true });
    }
  });
});

describe("installSettings - data root override", () => {
  test("uses custom data root for target resolution", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const customRoot = await createTempDir(tempDirs);

    const result = await installSettings("~", {
      dryRun: true,
      sourceAnchor: packageRoot,
      dataRoot: customRoot,
    });

    expect(result.destination).toBe(join(customRoot, "settings.json"));
  });
});

describe("installSettings - source validation edge cases", () => {
  test("rejects source when settings.example.json is absent from package root", async () => {
    // Package root without settings.example.json
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), '{"name":"test-pkg"}');
    const targetDir = await createTempDir(tempDirs);

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/Settings source not found/);
  });

  test("rejects absent source on dry-run", async () => {
    const packageRoot = await createTempDir(tempDirs);
    await writeFile(join(packageRoot, "package.json"), '{"name":"test-pkg"}');
    const targetDir = await createTempDir(tempDirs);

    await expect(
      installSettings(targetDir, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/Settings source not found/);
  });
});

describe("installSettings - ENOTDIR on target path", () => {
  test("rejects target when parent path component is a regular file", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    // Place a regular file where a directory is expected in the target path
    await writeFile(join(base, "somefile"), "not a directory");
    const targetWithFileParent = join(base, "somefile", "subdir");

    await expect(
      installSettings(targetWithFileParent, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);
    await expect(
      installSettings(targetWithFileParent, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/not a directory/);

    // Verify no settings.json was created
    expect(await fileExists(join(targetWithFileParent, "settings.json"))).toBe(
      false,
    );
  });

  test("rejects ENOTDIR target on dry-run", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const base = await createTempDir(tempDirs);
    await writeFile(join(base, "somefile"), "not a directory");
    const targetWithFileParent = join(base, "somefile", "subdir");

    await expect(
      installSettings(targetWithFileParent, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);
    await expect(
      installSettings(targetWithFileParent, {
        dryRun: true,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/not a directory/);
  });
});

describe("installSettings - resolveSourcePath non-ENOENT lstat error", () => {
  test("rejects source when parent directory is inaccessible", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    // Remove execute permission from package root to cause lstatSync to fail with EACCES
    await chmod(packageRoot, 0o666);
    const targetDir = await createTempDir(tempDirs);

    try {
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(SettingsInstallError);
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(/Settings source inaccessible/);
    } finally {
      await chmod(packageRoot, 0o755);
    }
  });
});

describe("installSettings - readAndValidateSource non-SyntaxError parse", () => {
  test("rejects source when JSON.parse throws a non-SyntaxError", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);

    const origParse = JSON.parse;
    try {
      JSON.parse = (() => {
        throw new TypeError("forced non-SyntaxError");
      }) as unknown as typeof JSON.parse;

      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(SettingsInstallError);
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(/Failed to parse settings source/);
    } finally {
      JSON.parse = origParse;
    }
  });
});

describe("installSettings - validateTarget non-ENOENT/non-ENOTDIR lstat error", () => {
  // The catch-all at validateTarget line 226-228 is a defensive dead-code path:
  // the ancestor walk lstat's every component including targetRoot, so a
  // subsequent lstat(targetRoot) can only fail through a TOCTOU race.
  // The ancestor walk's own error handler is covered by the next test.
  test("rejects target when ancestor walk lstat fails with unexpected error", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    failLstat = true;

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);
  });
});

describe("installSettings - validateTarget access failure", () => {
  test("rejects target when access check indicates no write permission", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    failAccess = true;

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallValidationError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/No write access to target root/);
  });
});

describe("installSettings - inspectDestination non-regular file (not symlink)", () => {
  test("rejects destination when it is a directory", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    // Create a directory at settings.json to trigger non-regular file error
    await mkdir(join(targetDir, "settings.json"));

    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(SettingsInstallError);
    await expect(
      installSettings(targetDir, {
        dryRun: false,
        sourceAnchor: packageRoot,
      }),
    ).rejects.toThrow(/not a regular file/);
  });
});

describe("installSettings - inspectDestination lstat error (non-ENOENT)", () => {
  test("throws SettingsInstallError when lstatSync on destination fails with non-ENOENT error", async () => {
    const packageRoot = await createSettingsPackageRoot(tempDirs);
    const targetDir = await createTempDir(tempDirs);
    const destPath = join(targetDir, "settings.json");

    // Only fail lstatSync for the exact destination path, leaving the source
    // validation (resolveSourcePath) and any other callers unaffected.
    failLstatSyncPath = destPath;
    try {
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(SettingsInstallError);
      await expect(
        installSettings(targetDir, {
          dryRun: false,
          sourceAnchor: packageRoot,
        }),
      ).rejects.toThrow(/Failed to stat settings destination/);
    } finally {
      failLstatSyncPath = null;
    }
  });
});
