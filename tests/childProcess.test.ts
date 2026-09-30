import { describe, expect, test } from "bun:test";
import {
  type ChildCompletion,
  type ChildFailureKind,
  normalizeChild,
  requireChild,
  spawnChild,
} from "./helpers/childProcess.js";

const JSON_STDOUT = '{"ok":true}\n';

function completion(overrides: Partial<ChildCompletion>): ChildCompletion {
  return { stdout: "", stderr: "", status: 0, signal: null, ...overrides };
}

// An inherited FORCE_COLOR makes Bun wrap console.error output in ANSI color
// codes; pin it off so exact stderr assertions hold in any terminal.
function spawnOptions(timeout = 10_000) {
  return {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout,
  };
}

describe("normalizeChild", () => {
  // Abnormal cases carry valid-looking JSON stdout to prove the guard
  // blocks output assertions.
  const abnormal: Array<{
    name: string;
    result: ChildCompletion;
    kind: ChildFailureKind;
  }> = [
    {
      name: "a timeout",
      result: completion({
        error: Object.assign(new Error("bun timed out"), {
          code: "ETIMEDOUT",
        }),
        status: null,
        signal: "SIGKILL",
        stdout: JSON_STDOUT,
      }),
      kind: "timeout",
    },
    {
      name: "a spawn error",
      result: completion({
        error: Object.assign(new Error("bun ENOENT"), { code: "ENOENT" }),
        status: null,
        stdout: JSON_STDOUT,
      }),
      kind: "spawn-error",
    },
    {
      name: "signal termination",
      result: completion({
        status: null,
        signal: "SIGKILL",
        stdout: JSON_STDOUT,
      }),
      kind: "signal",
    },
    {
      name: "a null status",
      result: completion({ status: null, stdout: JSON_STDOUT }),
      kind: "null-status",
    },
  ];

  test.each(abnormal)(
    "rejects $name before output parsing",
    ({ result, kind }) => {
      const normalized = normalizeChild(result);
      expect(normalized.ok).toBe(false);
      if (!normalized.ok) expect(normalized.failure.kind).toBe(kind);
      expect(() => requireChild(result, "synthetic")).toThrow(
        new RegExp(`\\[synthetic\\]: ${kind}`),
      );
    },
  );

  test.each([0, 2])("accepts a concrete exit code of %d", (status) => {
    const child = requireChild(
      completion({ status, stdout: JSON_STDOUT, stderr: "err" }),
      "synthetic",
    );

    expect(child).toEqual({
      stdout: JSON_STDOUT,
      stderr: "err",
      exitCode: status,
    });
  });
});

describe("spawnChild", () => {
  test("captures stdout, stderr, and a nonzero exit code", async () => {
    const result = await spawnChild(
      process.execPath,
      ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
      spawnOptions(),
    );

    expect(result).toEqual({
      stdout: "out\n",
      stderr: "err\n",
      status: 3,
      signal: null,
    });
  });

  test("kills a child that outlives its deadline and reports a timeout", async () => {
    const result = await spawnChild("sleep", ["30"], spawnOptions(1));

    expect(normalizeChild(result)).toMatchObject({
      ok: false,
      failure: { kind: "timeout" },
    });
  });

  test("reports a spawn error for a missing executable", async () => {
    const result = await spawnChild(
      "vibe-cli-missing-executable",
      [],
      spawnOptions(),
    );

    expect(normalizeChild(result)).toMatchObject({
      ok: false,
      failure: { kind: "spawn-error" },
    });
  });

  test("reports signal termination", async () => {
    const result = await spawnChild(
      "sh",
      ["-c", "kill -TERM $$"],
      spawnOptions(),
    );

    expect(normalizeChild(result)).toMatchObject({
      ok: false,
      failure: { kind: "signal" },
    });
  });
});
