import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

describe("test harness", () => {
  test("isolates home and data state per test case", async () => {
    const first = await createTempHome();
    homes.push(first);
    await mkdir(first.dataRoot, { recursive: true });
    await writeFile(join(first.dataRoot, "sentinel.txt"), "first");

    const second = await createTempHome();
    homes.push(second);

    expect(first.home).not.toBe(second.home);
    expect(first.dataRoot).not.toBe(second.dataRoot);
    expect(process.env["HOME"]).toBe(second.home);
  });
});
