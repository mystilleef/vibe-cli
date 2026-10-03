import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createTempHarness } from "./helpers/tempHome";

const harness = createTempHarness();

let tools: typeof import("../src/tools/vibeLearn") &
  typeof import("../src/tools/constitution");

beforeAll(async () => {
  tools = {
    ...(await import("../src/tools/vibeLearn")),
    ...(await import("../src/tools/constitution")),
  };
});

afterEach(async () => {
  await harness.cleanup();
});

async function setupIsolatedCwd(): Promise<string> {
  await harness.useTempHome();
  return harness.useCwd("learn-constitution");
}

describe("learn and constitution autosessions", () => {
  test("learn accepts no session ID and preserves learning output behavior", async () => {
    await setupIsolatedCwd();

    const input: import("../src/tools/vibeLearn").VibeLearnInput = {
      observation: "Agent repeated a risky plan without verification.",
      category: "Premature Implementation",
      solution: "Verify the plan before executing risky work.",
      type: "mistake",
    };

    const result = await tools.vibeLearnTool(input);

    expect(result.added).toBe(true);
    expect(result.categoryCount).toBe(1);
    expect(result.topCategories[0]?.category).toBe("Premature Implementation");
  });

  test("same CWD shares constitution rules and different CWD isolates them", async () => {
    const firstCwd = await setupIsolatedCwd();
    const secondCwd = await harness.createCwd("learn-constitution");

    tools.updateConstitution("Prefer tested rollback plans.");
    const firstSession = tools.getCurrentConstitutionSessionId();

    expect(tools.getConstitution()).toEqual(["Prefer tested rollback plans."]);

    process.chdir(secondCwd);
    const secondSession = tools.getCurrentConstitutionSessionId();

    expect(secondSession).not.toBe(firstSession);
    expect(tools.getConstitution()).toEqual([]);

    tools.updateConstitution("Keep scope minimal.");
    expect(tools.getConstitution()).toEqual(["Keep scope minimal."]);

    process.chdir(firstCwd);
    expect(tools.getConstitution()).toEqual(["Prefer tested rollback plans."]);
  });

  test("constitution reset targets the current autosession", async () => {
    await setupIsolatedCwd();

    tools.updateConstitution("Initial rule.");
    tools.resetConstitution(["Replacement rule."]);

    expect(tools.getConstitution()).toEqual(["Replacement rule."]);
  });
});
