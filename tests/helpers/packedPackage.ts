/**
 * Packed-package fixture shared by packed CLI suites.
 *
 * Each suite builds and packs a private staging copy of the package. Packed
 * suites run in parallel workers, and rebuilding the shared `dist/` let one
 * worker pack another's half-written bundle.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runChild } from "./childProcess.js";

const packageRoot = join(import.meta.dir, "..", "..");

/** Build inputs staged alongside the manifest's published entries. */
const BUILD_INPUTS = [
  "package.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "src",
];

export interface PackedFixture {
  /** Scratch root holding stage, tarball, and extraction; caller removes it. */
  workRoot: string;
  /** Extracted package root, laid out as a consumer installs it. */
  extractedRoot: string;
}

/**
 * Stage, build, pack, and extract the package under a fresh work root inside
 * the package directory, so dependency resolution matches the source tree.
 * The work root is removed when any step fails.
 */
export async function packAndExtract(prefix: string): Promise<PackedFixture> {
  const workRoot = await mkdtemp(join(packageRoot, prefix));
  try {
    const stageRoot = join(workRoot, "stage");
    const packDir = join(workRoot, "pack");
    const extractDir = join(workRoot, "extract");
    await stagePackage(stageRoot);
    await mkdir(packDir);
    await mkdir(extractDir);
    await run("bun", ["run", "build"], stageRoot, 60_000);
    await run(
      "bun",
      ["pm", "pack", "--destination", packDir, "--ignore-scripts", "--quiet"],
      stageRoot,
      30_000,
    );
    const [tarball, ...extra] = (await readdir(packDir)).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (tarball === undefined || extra.length > 0) {
      throw new Error(`expected one packed tarball in ${packDir}`);
    }
    await run(
      "tar",
      ["-xzf", join(packDir, tarball), "-C", extractDir],
      workRoot,
      15_000,
    );
    return { workRoot, extractedRoot: join(extractDir, "package") };
  } catch (error) {
    await rm(workRoot, { recursive: true, force: true });
    throw error;
  }
}

async function stagePackage(stageRoot: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { files: string[] };
  const published = manifest.files.filter((entry) => entry !== "dist");
  await Promise.all(
    [...BUILD_INPUTS, ...published].map((entry) =>
      cp(join(packageRoot, entry), join(stageRoot, entry), {
        recursive: true,
      }),
    ),
  );
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
): Promise<void> {
  const child = await runChild(command, args, {
    cwd,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      PAGER: "cat",
      TERM: "dumb",
    },
    timeout,
  });
  if (child.exitCode !== 0) {
    throw new Error(
      `${[command, ...args].join(" ")} exited ${String(child.exitCode)}: ${child.stderr}`,
    );
  }
}
