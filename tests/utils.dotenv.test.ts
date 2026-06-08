import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { warnLegacyDotenv } from "../src/utils/dotenv.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

let tempHome: TempHomeContext;
let stderrOutput: string;
let originalWrite: typeof process.stderr.write;

function captureStderr(): void {
  stderrOutput = "";
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
}

function restoreStderr(): void {
  process.stderr.write = originalWrite;
}

beforeEach(async () => {
  tempHome = await createTempHome();
  captureStderr();
});

afterEach(async () => {
  restoreStderr();
  await tempHome.cleanup();
});

describe("warnLegacyDotenv", () => {
  test("emits deprecation warning when ~/.vibe-cli/.env exists", async () => {
    await mkdir(join(tempHome.home, ".vibe-cli"), { recursive: true });
    await writeFile(join(tempHome.home, ".vibe-cli", ".env"), "KEY=value\n");

    warnLegacyDotenv();

    expect(stderrOutput).toContain("Deprecated ~/.vibe-cli/.env ignored");
    expect(stderrOutput).toContain("settings.json");
  });

  test("emits nothing when ~/.vibe-cli/.env does not exist", () => {
    warnLegacyDotenv();

    expect(stderrOutput).toBe("");
  });

  test("uses HOME environment variable over os.homedir()", async () => {
    const altHome = join(tempHome.home, "alt");
    await mkdir(join(altHome, ".vibe-cli"), { recursive: true });
    await writeFile(join(altHome, ".vibe-cli", ".env"), "KEY=value\n");
    const originalHome = process.env["HOME"];
    process.env["HOME"] = altHome;

    try {
      warnLegacyDotenv();

      expect(stderrOutput).toContain("Deprecated");
    } finally {
      if (originalHome !== undefined) process.env["HOME"] = originalHome;
      else delete process.env["HOME"];
    }
  });
});
