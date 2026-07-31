import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const originalCwd = process.cwd();
const packageRoot = originalCwd;
/** Packed fixture root — owned by beforeAll/afterAll, not afterEach. */
let packFixtureRoot: string | undefined;

afterAll(async () => {
  if (packFixtureRoot) {
    await rm(packFixtureRoot, { recursive: true, force: true });
    packFixtureRoot = undefined;
  }
});

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Pack and extract the package, returning the extracted root.
 * The fixture is reused across tests via beforeAll/afterAll.
 */
async function packAndExtract(): Promise<string> {
  const workRoot = await mkdtemp(join(packageRoot, ".guide-pack-"));
  const packDir = join(workRoot, "pack");
  const extractDir = join(workRoot, "extract");
  await mkdir(packDir, { recursive: true });
  await mkdir(extractDir, { recursive: true });

  // Rebuild dist so the packed CLI matches current source contracts.
  const buildResult = spawnSync("bun", ["run", "build"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      PAGER: "cat",
      TERM: "dumb",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    encoding: "utf-8",
  });
  expect(buildResult.status).toBe(0);

  const packResult = spawnSync(
    "bun",
    ["pm", "pack", "--destination", packDir, "--ignore-scripts", "--quiet"],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        CI: "true",
        NO_COLOR: "1",
        PAGER: "cat",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      encoding: "utf-8",
    },
  );
  expect(packResult.status).toBe(0);

  const packedFiles = (await readdir(packDir)).filter((name) =>
    name.endsWith(".tgz"),
  );
  expect(packedFiles).toHaveLength(1);
  const tarball = join(packDir, packedFiles[0] as string);

  const extractResult = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], {
    cwd: packageRoot,
    env: process.env as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    encoding: "utf-8",
  });
  expect(extractResult.status).toBe(0);

  const extractedRoot = join(extractDir, "package");
  expect(await fileExists(join(extractedRoot, "package.json"))).toBe(true);
  expect(await fileExists(join(extractedRoot, "dist", "vibe.js"))).toBe(true);

  packFixtureRoot = workRoot;
  return extractedRoot;
}

let extractedRoot: string;

beforeAll(async () => {
  extractedRoot = await packAndExtract();
}, 90_000);

describe("packed package guide surface", () => {
  test("extracted package contains docs/vibe-guide.md", async () => {
    const guidePath = join(extractedRoot, "docs", "vibe-guide.md");
    expect(await fileExists(guidePath)).toBe(true);

    const content = await readFile(guidePath, "utf8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("# Vibe Skills");
  });

  test("extracted package guide matches source guide byte-for-byte", async () => {
    const sourceGuide = await readFile(
      join(packageRoot, "docs", "vibe-guide.md"),
      "utf8",
    );
    const packedGuide = await readFile(
      join(extractedRoot, "docs", "vibe-guide.md"),
      "utf8",
    );
    expect(packedGuide).toBe(sourceGuide);
  });

  test("guide resolver works from extracted package dist directory", async () => {
    // The guide file should be directly accessible from the extracted root
    const guidePath = join(extractedRoot, "docs", "vibe-guide.md");
    expect(await fileExists(guidePath)).toBe(true);

    // Verify the file is readable
    const content = await readFile(guidePath, "utf8");
    expect(content).toContain("vibe-check");
  });

  test("package.json files array includes docs/vibe-guide.md", async () => {
    const pkgJson = JSON.parse(
      await readFile(join(extractedRoot, "package.json"), "utf8"),
    ) as { files: string[] };
    expect(pkgJson.files).toContain("docs/vibe-guide.md");
  });

  test("packed guide list resolves packaged guide and emits JSON", async () => {
    const workDir = await mkdtemp(join(extractedRoot, ".guide-test-"));
    try {
      const result = spawnSync(
        "bun",
        [join(extractedRoot, "dist", "vibe.js"), "guide", "list"],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          encoding: "utf-8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        target: string;
        status: string;
      };
      expect(payload.target).toBe(workDir);
      expect(["missing", "identical", "outdated"]).toContain(payload.status);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("packed guide install --dry-run resolves packaged guide and writes nothing", async () => {
    const workDir = await mkdtemp(join(extractedRoot, ".guide-test-"));
    try {
      const result = spawnSync(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "install",
          "--dry-run",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          encoding: "utf-8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(payload.target).toBe(workDir);
      expect(payload.dryRun).toBe(true);
      expect(payload.ok).toBe(true);
      expect(["missing", "identical", "outdated"]).toContain(payload.status);
      expect(["would-install", "would-replace", "would-skip"]).toContain(
        payload.action,
      );
      // Confirm no file was created
      expect(await fileExists(join(workDir, "vibe-guide.md"))).toBe(false);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("packed guide list rejects unsupported options with stderr-only fatal JSON", async () => {
    const result = spawnSync(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "guide", "list", "--bogus"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "error: unknown option '--bogus'",
    });
  });

  test("packed guide install writes guide file and emits one JSON line", async () => {
    const workDir = await mkdtemp(join(extractedRoot, ".guide-test-"));
    try {
      const result = spawnSync(
        "bun",
        [join(extractedRoot, "dist", "vibe.js"), "guide", "install"],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          encoding: "utf-8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      const payload = JSON.parse(result.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(payload.target).toBe(workDir);
      expect(payload.dryRun).toBe(false);
      expect(payload.ok).toBe(true);
      expect(payload.action).toBe("installed");
      expect(await fileExists(join(workDir, "vibe-guide.md"))).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("packed guide install rejects unsupported options with stderr-only fatal JSON", async () => {
    const result = spawnSync(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "guide", "install", "--bogus"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "error: unknown option '--bogus'",
    });
  });

  test("packed guide install surfaces fatal target validation errors as stderr-only fatal JSON", async () => {
    const result = spawnSync(
      "bun",
      [
        join(extractedRoot, "dist", "vibe.js"),
        "guide",
        "install",
        "--target",
        "/dev/null",
      ],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("Target '/dev/null' is not a directory");
  });

  test("packed schema reports guide commands with valid exit contracts", async () => {
    const result = spawnSync(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "schema"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const schema = JSON.parse(result.stdout) as {
      commands: Record<
        string,
        {
          opt?: Record<string, string>;
          out?: unknown;
          exit?: Record<string, string>;
        }
      >;
    };

    expect(schema.commands["guide list"]).toBeDefined();
    expect(schema.commands["guide list"]?.exit).toEqual({
      "0": "success",
      "1": "error",
    });
    expect(schema.commands["guide install"]).toBeDefined();
    expect(schema.commands["guide install"]?.exit).toEqual({
      "0": "success",
      "1": "error",
    });
  });
});
