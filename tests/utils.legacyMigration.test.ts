/**
 * Direct coverage of the legacy-artifact backup contract: collision-safe
 * rename walks past every existing `.bak` variant until it finds a free
 * name, and the rename always moves the original content.
 *
 * Migration integration tests exercise the first collision (`.1.bak`);
 * these tests pin the loop's continued iterations at the source.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupLegacyPath } from "../src/utils/legacyMigration.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-cli-legacy-"));
  tempRoots.push(root);
  return root;
}

describe("backupLegacyPath", () => {
  test.each([
    {
      name: "skips past .bak and .1.bak to .2.bak",
      existing: ["", ".1"],
      expectedSuffix: ".2.bak",
    },
    {
      name: "continues past every occupied suffix",
      existing: ["", ".1", ".2"],
      expectedSuffix: ".3.bak",
    },
  ])("$name", async ({ existing, expectedSuffix }) => {
    const root = await createTempRoot();
    const artifact = join(root, "vibe-log.json");
    const originalContent = `artifact-bytes-${expectedSuffix}`;
    await writeFile(artifact, originalContent);

    for (const suffix of existing) {
      await writeFile(
        join(root, `vibe-log.json${suffix}.bak`),
        `preexisting-${suffix || "base"}-backup`,
      );
    }

    const result = backupLegacyPath(artifact);

    expect(result).toBe(join(root, `vibe-log.json${expectedSuffix}`));
    expect(existsSync(artifact)).toBe(false);
    expect(await readFile(result, "utf8")).toBe(originalContent);
    for (const suffix of existing) {
      const path = join(root, `vibe-log.json${suffix}.bak`);
      expect(await readFile(path, "utf8")).toBe(
        `preexisting-${suffix || "base"}-backup`,
      );
    }
  });
});
