import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext | undefined;
let cwd: string | undefined;
const originalCwd = process.cwd();
let mod: typeof import("../src/tools/constitution");

beforeAll(async () => {
  mod = await import("../src/tools/constitution");
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = undefined;
  if (home) await home.cleanup();
  home = undefined;
});

async function setup(): Promise<string> {
  home = await createTempHome();
  cwd = await mkdtemp(join(tmpdir(), "vibe-cli-constitution-"));
  process.chdir(cwd);
  return cwd;
}

describe("constitution guards", () => {
  test("updateConstitution ignores empty rule", async () => {
    await setup();
    const session = mod.getCurrentConstitutionSessionId();

    mod.updateConstitution("");

    expect(mod.getConstitution()).toEqual([]);
    expect(mod.getCurrentConstitutionSessionId()).toBe(session);
  });

  test("updateConstitution shifts oldest rule at MAX_RULES", async () => {
    await setup();

    for (let i = 0; i < 50; i++) {
      mod.updateConstitution(`rule-${i}`);
    }
    expect(mod.getConstitution()).toHaveLength(50);
    expect(mod.getConstitution()[0]).toBe("rule-0");

    mod.updateConstitution("rule-50");
    expect(mod.getConstitution()).toHaveLength(50);
    expect(mod.getConstitution()[0]).toBe("rule-1");
    expect(mod.getConstitution()[49]).toBe("rule-50");
  });

  test("resetConstitution truncates to MAX_RULES", async () => {
    await setup();

    const manyRules = Array.from({ length: 75 }, (_, i) => `rule-${i}`);
    mod.resetConstitution(manyRules);

    expect(mod.getConstitution()).toHaveLength(50);
    expect(mod.getConstitution()[0]).toBe("rule-0");
    expect(mod.getConstitution()[49]).toBe("rule-49");
  });

  test("resetConstitution with no rules clears the session", async () => {
    await setup();

    mod.updateConstitution("rule-a");
    mod.updateConstitution("rule-b");
    mod.resetConstitution([]);

    expect(mod.getConstitution()).toEqual([]);
  });

  test("getConstitution returns empty array for untouched session", async () => {
    await setup();

    expect(mod.getConstitution()).toEqual([]);
  });
});
