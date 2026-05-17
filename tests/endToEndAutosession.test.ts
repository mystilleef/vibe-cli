import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOSESSION_TTL_MS,
  getCwdKey,
  resolveAutosession,
} from "../src/utils/autosession";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const llmInputs: unknown[] = [];

mock.module("../src/utils/llm.js", () => ({
  FALLBACK_QUESTIONS: "fallback",
  getMetacognitiveQuestions: async (input: unknown) => {
    llmInputs.push(input);
    return { questions: "approved" };
  },
  getGateDecision: async () => ({
    proceed: true,
    confidence: 0.99,
    reason: "sound",
  }),
  revisePlan: async () => "revised",
}));

let home: TempHomeContext | undefined;
let cwd: string | undefined;
let otherCwd: string | undefined;
const originalCwd = process.cwd();
let tools: typeof import("../src/tools/vibeCheck") &
  typeof import("../src/tools/vibeGate") &
  typeof import("../src/tools/vibeLearn") &
  typeof import("../src/tools/constitution") &
  typeof import("../src/utils/state");

beforeAll(async () => {
  tools = {
    ...(await import("../src/tools/vibeCheck")),
    ...(await import("../src/tools/vibeGate")),
    ...(await import("../src/tools/vibeLearn")),
    ...(await import("../src/tools/constitution")),
    ...(await import("../src/utils/state")),
  };
});

afterEach(async () => {
  process.chdir(originalCwd);
  llmInputs.length = 0;
  if (cwd) await rm(cwd, { recursive: true, force: true });
  if (otherCwd) await rm(otherCwd, { recursive: true, force: true });
  cwd = undefined;
  otherCwd = undefined;
  if (home) await home.cleanup();
  home = undefined;
});

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sessionFile(targetCwd: string): string {
  return join(home?.dataRoot, "sessions", `${getCwdKey(targetCwd)}.json`);
}

describe("end-to-end autosession behavior", () => {
  test("check, gate, learn, constitution, and session flows share one CWD session", async () => {
    home = await createTempHome();
    cwd = await mkdtemp(join(tmpdir(), "vibe-cli-e2e-"));
    otherCwd = await mkdtemp(join(tmpdir(), "vibe-cli-e2e-other-"));
    process.chdir(cwd);
    await tools.loadHistory();

    const session = resolveAutosession().id;
    tools.updateConstitution("Prefer verified plans.");
    const check = await tools.vibeCheckTool({
      goal: "ship",
      plan: "verify first",
    });
    const gate = await tools.vibeGateTool({
      goal: "ship",
      plan: "gate before merge",
    });
    const learn = await tools.vibeLearnTool({
      mistake: "Skipped shared session verification.",
      category: "Autosession",
      solution: "Verify shared CWD session behavior.",
      type: "success",
    });

    const history = readJson<Record<string, unknown[]>>(
      join(home.dataRoot, "history.json"),
    );
    expect(check.questions).toBe("approved");
    expect(gate.proceed).toBe(true);
    expect(gate.questions).toBe("approved");
    expect(learn.added).toBe(true);
    expect(resolveAutosession().id).toBe(session);
    expect(tools.getCurrentConstitutionSessionId()).toBe(session);
    expect(tools.getConstitution()).toEqual(["Prefer verified plans."]);
    expect(Object.keys(history)).toEqual([session]);
    expect(history[session]).toHaveLength(2);
    expect(llmInputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: session })]),
    );

    process.chdir(otherCwd);
    const isolatedSession = resolveAutosession().id;
    expect(isolatedSession).not.toBe(session);
    expect(tools.getConstitution()).toEqual([]);
  });

  test("TTL rotation renews inactive CWD sessions without migrating or deleting existing data", async () => {
    home = await createTempHome();
    cwd = await mkdtemp(join(tmpdir(), "vibe-cli-e2e-ttl-"));
    process.chdir(cwd);
    await tools.loadHistory();

    const legacyRoot = join(home.home, ".vibe-cli");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(
      join(legacyRoot, "history.json"),
      JSON.stringify({ legacy: ["keep"] }),
    );
    writeFileSync(
      join(home.dataRoot, "learning.json"),
      JSON.stringify({ entries: ["keep"] }),
    );

    const first = resolveAutosession();
    tools.updateConstitution("Active access keeps the current session.");
    await writeFile(
      sessionFile(cwd),
      JSON.stringify({
        ...first,
        lastAccessedAt: new Date(
          Date.now() - AUTOSESSION_TTL_MS + 60_000,
        ).toISOString(),
      }),
    );
    const active = resolveAutosession();
    expect(active.id).toBe(first.id);

    await writeFile(
      sessionFile(cwd),
      JSON.stringify({
        ...active,
        lastAccessedAt: new Date(
          Date.now() - AUTOSESSION_TTL_MS - 1,
        ).toISOString(),
      }),
    );
    const rotated = resolveAutosession();

    expect(rotated.id).not.toBe(first.id);
    expect(tools.getConstitution()).toEqual([]);
    expect(existsSync(join(legacyRoot, "history.json"))).toBe(true);
    expect(readJson(join(home.dataRoot, "learning.json"))).toEqual({
      entries: ["keep"],
    });
  });
});
