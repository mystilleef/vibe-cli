import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSchema } from "../src/utils/schema.js";
import { SETTINGS_FILE_MISSING_ERROR } from "../src/utils/settings.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

let tempHome: TempHomeContext;

async function writeSettings(value: unknown): Promise<void> {
  await mkdir(tempHome.dataRoot, { recursive: true });
  await writeFile(
    join(tempHome.dataRoot, "settings.json"),
    JSON.stringify(value),
  );
}

function validSettings(overrides: Record<string, unknown> = {}) {
  return {
    provider: "gemini",
    providers: [
      { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
      {
        name: "openai",
        spec: "openai",
        envVar: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-mini",
      },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  tempHome = await createTempHome();
});

afterEach(async () => {
  await tempHome.cleanup();
});

describe("buildSchema", () => {
  test("returns settings provider name and model on success", async () => {
    await writeSettings(validSettings({ model: "global-model" }));

    const schema = buildSchema();

    expect(schema.config.provider).toBe("gemini");
    expect(schema.config.model).toBe("global-model");
    expect(schema.v).toBe("1.0.0");
    expect(schema.data).toBe("~/.vibe-cli/");
    expect(schema.commands.check).toBeDefined();
  });

  test("uses provider defaultModel when settings model absent", async () => {
    await writeSettings(validSettings());

    const schema = buildSchema();

    expect(schema.config.provider).toBe("gemini");
    expect(schema.config.model).toBe("(required via --model)");
  });

  test("uses settings model over provider defaultModel", async () => {
    await writeSettings(
      validSettings({ provider: "openai", model: "override-model" }),
    );

    const schema = buildSchema();

    expect(schema.config.provider).toBe("openai");
    expect(schema.config.model).toBe("override-model");
  });

  test("uses provider defaultModel when settings model absent for named provider", async () => {
    await writeSettings(validSettings({ provider: "openai" }));

    const schema = buildSchema();

    expect(schema.config.provider).toBe("openai");
    expect(schema.config.model).toBe("gpt-4o-mini");
  });

  test("reports error message when settings file missing", async () => {
    const schema = buildSchema();

    expect(schema.config.provider).toBe("unresolved");
    expect(schema.config.model).toBe(SETTINGS_FILE_MISSING_ERROR);
  });

  test("reports error message when settings malformed", async () => {
    await mkdir(tempHome.dataRoot, { recursive: true });
    await writeFile(join(tempHome.dataRoot, "settings.json"), "{not-json");

    const schema = buildSchema();

    expect(schema.config.provider).toBe("unresolved");
    expect(schema.config.model).toContain("Malformed JSON");
  });

  test("reports error when active provider not in settings", async () => {
    await writeSettings(validSettings({ provider: "missing" }));

    const schema = buildSchema();

    expect(schema.config.provider).toBe("unresolved");
    expect(schema.config.model).toContain("Provider 'missing' not found");
  });

  test("schema contains all expected command definitions", async () => {
    await writeSettings(validSettings());

    const schema = buildSchema();
    const commands = Object.keys(schema.commands);

    expect(commands).toContain("check");
    expect(commands).toContain("learn");
    expect(commands).toContain("constitution set");
    expect(commands).toContain("constitution get");
    expect(commands).toContain("constitution reset");
    expect(commands).toContain("session");
    expect(commands).toContain("verify");
    expect(commands).toContain("prune");
    expect(commands).toContain("migrate");
    expect(commands).toContain("skills list");
    expect(commands).toContain("skills install");
    expect(commands).not.toContain("list");
  });

  test("skills commands define flags, payloads, and exit codes", async () => {
    await writeSettings(validSettings());

    const schema = buildSchema();
    const list = schema.commands["skills list"];
    const install = schema.commands["skills install"];

    expect(list).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: {
        "--target": "path (default: ~/.agents/skills)",
        "--json": "Emit machine-readable JSON instead of pretty text",
      },
      out: {
        target: "absolute path str",
        skills: "[{name:str,status:missing|up-to-date|modified}]",
      },
      exit: {
        "0": "success",
        "1": "error",
      },
    });
    expect(install).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: {
        "--target": "path (default: ~/.agents/skills)",
        "--dry-run": "plan without writing staging or target files",
        "--force":
          "replace every existing bundled target, including hash matches",
        "--json": "Emit machine-readable JSON instead of pretty text",
      },
      out: {
        target: "absolute path str",
        dryRun: "bool",
        force: "bool",
        ok: "bool",
        skills:
          "[{name:str,status:missing|up-to-date|modified,action:would-install|would-replace|installed|replaced|unchanged|blocked|failed,error?:str}]",
      },
      exit: {
        "0": "success",
        "2": "blocked (modified targets without --force) or failed (partial copy error)",
        "1": "error",
      },
    });
  });

  test("guide commands define flags, payloads, and exit codes", async () => {
    await writeSettings(validSettings());

    const schema = buildSchema();
    const list = schema.commands["guide list"];
    const install = schema.commands["guide install"];

    expect(list).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: {
        "--target": "path (default: cwd)",
        "--json": "Emit machine-readable JSON instead of pretty text",
      },
      out: {
        target: "absolute path str",
        status: "missing|identical|outdated",
      },
      exit: {
        "0": "success",
        "1": "error",
      },
    });
    expect(install).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: {
        "--target": "path (default: cwd)",
        "--dry-run": "plan without writing target files",
        "--json": "Emit machine-readable JSON instead of pretty text",
      },
      out: {
        target: "absolute path str",
        dryRun: "bool",
        ok: "bool",
        status: "missing|identical|outdated",
        action:
          "would-install|would-replace|would-skip|installed|replaced|skipped",
      },
      exit: {
        "0": "success",
        "1": "error",
      },
    });
  });

  test("check command schema defines expected output fields", async () => {
    await writeSettings(validSettings());

    const schema = buildSchema();
    const check = schema.commands.check;

    expect(check.when).toBeDefined();
    expect(check.req["--goal"]).toBe("str");
    expect(check.req["--plan"]).toBe("str");
    expect(check.opt["--provider"]).toBe("settings provider entry name");
    expect(check.out).toHaveProperty("proceed");
    expect(check.out).toHaveProperty("confidence");
    expect(check.exit).toHaveProperty("0");
    expect(check.exit).toHaveProperty("2");
  });
});
