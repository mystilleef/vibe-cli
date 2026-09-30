import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnChild } from "./helpers/childProcess.js";
import { packAndExtract } from "./helpers/packedPackage.js";
import { fileExists } from "./helpers/skillsTestUtils.js";

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

let extractedRoot: string;

/** Pack and extract once; the fixture is reused across tests. */
beforeAll(async () => {
  const fixture = await packAndExtract(".guide-pack-");
  packFixtureRoot = fixture.workRoot;
  extractedRoot = fixture.extractedRoot;
  expect(await fileExists(join(extractedRoot, "package.json"))).toBe(true);
  expect(await fileExists(join(extractedRoot, "dist", "vibe.js"))).toBe(true);
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

  test("packed guide list resolves packaged guide and emits readable default output", async () => {
    const workDir = await mkdtemp(join(extractedRoot, ".guide-test-"));
    try {
      // Default output prints readable Guide section.
      const pretty = await spawnChild(
        "bun",
        [join(extractedRoot, "dist", "vibe.js"), "guide", "list"],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(pretty.status).toBe(0);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Guide");
      expect(pretty.stdout).toContain("target:");
      expect(pretty.stdout).toContain("status:");

      // --json preserves parseable payload.
      const result = await spawnChild(
        "bun",
        [join(extractedRoot, "dist", "vibe.js"), "guide", "list", "--json"],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
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
      // Default output prints readable Guide Install section.
      const pretty = await spawnChild(
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
          timeout: 10_000,
        },
      );

      expect(pretty.status).toBe(0);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Guide Install");
      expect(pretty.stdout).toContain("dryRun: true");
      expect(pretty.stdout).toContain("ok: true");

      // --json preserves parseable payload.
      const result = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "install",
          "--dry-run",
          "--json",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
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
    const result = await spawnChild(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "guide", "list", "--bogus"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "error: unknown option '--bogus'",
    });
  });

  test("packed guide install writes guide file and emits readable default output", async () => {
    const workDir = await mkdtemp(join(extractedRoot, ".guide-test-"));
    try {
      // Default output prints readable Guide Install section.
      const pretty = await spawnChild(
        "bun",
        [join(extractedRoot, "dist", "vibe.js"), "guide", "install"],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(pretty.status).toBe(0);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Guide Install");
      expect(pretty.stdout).toContain(`target: ${workDir}`);
      expect(pretty.stdout).toContain("status: missing");
      expect(pretty.stdout).toContain("action: installed");
      expect(pretty.stdout).toContain("ok: true");
      expect(pretty.stdout).toContain("installed");
      expect(await fileExists(join(workDir, "vibe-guide.md"))).toBe(true);

      // --json preserves parseable payload (second install is idempotent).
      const result = await spawnChild(
        "bun",
        [join(extractedRoot, "dist", "vibe.js"), "guide", "install", "--json"],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
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
      expect(payload.status).toBe("identical");
      expect(payload.action).toBe("skipped");
      expect(await fileExists(join(workDir, "vibe-guide.md"))).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("packed guide list and install honor explicit writable --target", async () => {
    const workDir = await mkdtemp(join(extractedRoot, ".guide-test-"));
    const targetDir = join(workDir, "target");
    try {
      // Pretty list against an explicit target reports missing without writing.
      const listPretty = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "list",
          "--target",
          targetDir,
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(listPretty.status).toBe(0);
      expect(listPretty.stderr).toBe("");
      expect(listPretty.stdout).toContain("Guide");
      expect(listPretty.stdout).toContain(`target: ${targetDir}`);
      expect(listPretty.stdout).toContain("status: missing");
      expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(false);

      // --json list reports the explicit target, not the cwd default.
      const listJson = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "list",
          "--target",
          targetDir,
          "--json",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(listJson.status).toBe(0);
      expect(listJson.stderr).toBe("");
      const listPayload = JSON.parse(listJson.stdout) as {
        target: string;
        status: string;
      };
      expect(listPayload.target).toBe(targetDir);
      expect(listPayload.status).toBe("missing");

      // Pretty install writes into the explicit target, not the cwd.
      const installPretty = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "install",
          "--target",
          targetDir,
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(installPretty.status).toBe(0);
      expect(installPretty.stderr).toBe("");
      expect(installPretty.stdout).toContain("Guide Install");
      expect(installPretty.stdout).toContain(`target: ${targetDir}`);
      expect(installPretty.stdout).toContain("status: missing");
      expect(installPretty.stdout).toContain("action: installed");
      expect(installPretty.stdout).toContain("ok: true");
      expect(await fileExists(join(targetDir, "vibe-guide.md"))).toBe(true);
      expect(await fileExists(join(workDir, "vibe-guide.md"))).toBe(false);

      // --json install reports the explicit target with the full field set.
      const installJson = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "install",
          "--target",
          targetDir,
          "--json",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(installJson.status).toBe(0);
      expect(installJson.stderr).toBe("");
      const installPayload = JSON.parse(installJson.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(installPayload.target).toBe(targetDir);
      expect(installPayload.dryRun).toBe(false);
      expect(installPayload.ok).toBe(true);
      expect(installPayload.status).toBe("identical");
      expect(installPayload.action).toBe("skipped");

      // Installed bytes match the packaged source byte-for-byte.
      const source = await readFile(
        join(extractedRoot, "docs", "vibe-guide.md"),
      );
      const installed = await readFile(join(targetDir, "vibe-guide.md"));
      expect(installed).toEqual(source);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("packed guide detects and replaces a modified target guide", async () => {
    const workDir = await mkdtemp(join(extractedRoot, ".guide-test-"));
    const targetDir = join(workDir, "target");
    try {
      // Seed an installed guide, then modify the target copy.
      const seed = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "install",
          "--target",
          targetDir,
          "--json",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(seed.status).toBe(0);
      expect(seed.stderr).toBe("");
      expect((JSON.parse(seed.stdout) as { action: string }).action).toBe(
        "installed",
      );

      await writeFile(
        join(targetDir, "vibe-guide.md"),
        "# Locally modified guide\n",
      );

      // List reports outdated drift against the modified target.
      const list = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "list",
          "--target",
          targetDir,
          "--json",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(list.status).toBe(0);
      expect(list.stderr).toBe("");
      const listPayload = JSON.parse(list.stdout) as {
        target: string;
        status: string;
      };
      expect(listPayload.target).toBe(targetDir);
      expect(listPayload.status).toBe("outdated");

      // Dry-run plans a replace without touching the modified file.
      const dryRun = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "install",
          "--target",
          targetDir,
          "--dry-run",
          "--json",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(dryRun.status).toBe(0);
      expect(dryRun.stderr).toBe("");
      const dryPayload = JSON.parse(dryRun.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(dryPayload.target).toBe(targetDir);
      expect(dryPayload.dryRun).toBe(true);
      expect(dryPayload.ok).toBe(true);
      expect(dryPayload.status).toBe("outdated");
      expect(dryPayload.action).toBe("would-replace");
      expect(await readFile(join(targetDir, "vibe-guide.md"), "utf8")).toBe(
        "# Locally modified guide\n",
      );

      // Real install replaces the modified file byte-for-byte.
      const install = await spawnChild(
        "bun",
        [
          join(extractedRoot, "dist", "vibe.js"),
          "guide",
          "install",
          "--target",
          targetDir,
          "--json",
        ],
        {
          cwd: workDir,
          env: { ...process.env, HOME: workDir },
          timeout: 10_000,
        },
      );

      expect(install.status).toBe(0);
      expect(install.stderr).toBe("");
      const installPayload = JSON.parse(install.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(installPayload.target).toBe(targetDir);
      expect(installPayload.dryRun).toBe(false);
      expect(installPayload.ok).toBe(true);
      expect(installPayload.status).toBe("outdated");
      expect(installPayload.action).toBe("replaced");

      const source = await readFile(
        join(extractedRoot, "docs", "vibe-guide.md"),
      );
      const installed = await readFile(join(targetDir, "vibe-guide.md"));
      expect(installed).toEqual(source);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("packed guide install rejects unsupported options with stderr-only fatal JSON", async () => {
    const result = await spawnChild(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "guide", "install", "--bogus"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        timeout: 10_000,
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
    const result = await spawnChild(
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
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(
      payload.error.includes("is not a directory") ||
        payload.error.includes("No write access") ||
        payload.error.includes("Failed to inspect"),
    ).toBe(true);
  });

  test("packed guide help advertises --json option", async () => {
    const listHelp = await spawnChild(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "guide", "list", "--help"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        timeout: 10_000,
      },
    );

    expect(listHelp.status).toBe(0);
    expect(listHelp.stderr).toBe("");
    expect(listHelp.stdout).toContain("--json");

    const installHelp = await spawnChild(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "guide", "install", "--help"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        timeout: 10_000,
      },
    );

    expect(installHelp.status).toBe(0);
    expect(installHelp.stderr).toBe("");
    expect(installHelp.stdout).toContain("--json");
  });

  test("packed schema advertises --json for guide commands", async () => {
    const result = await spawnChild(
      "bun",
      [join(extractedRoot, "dist", "vibe.js"), "schema"],
      {
        cwd: extractedRoot,
        env: { ...process.env, HOME: extractedRoot },
        timeout: 10_000,
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
    expect(schema.commands["guide list"]?.opt).toHaveProperty("--json");
    expect(schema.commands["guide install"]).toBeDefined();
    expect(schema.commands["guide install"]?.opt).toHaveProperty("--json");
  });
});
