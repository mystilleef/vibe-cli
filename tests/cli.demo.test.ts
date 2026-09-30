import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runCliInProcess } from "../src/cli.js";
import * as demo from "../src/tools/demo.js";

/**
 * Demo command wiring. The demo action is the one command handler not
 * wrapped in `withCliError`, so a walkthrough rejection escapes Commander
 * and reaches `runCliInProcess`'s own catch block — including non-Error
 * values, which must serialize through `String(e)`.
 */

afterEach(() => {
  mock.restore();
});

describe("demo command", () => {
  test("runs the walkthrough with a resolved model override", async () => {
    spyOn(demo, "runDemo").mockResolvedValue(undefined);

    const result = await runCliInProcess([
      "demo",
      "--provider",
      "anthropic",
      "--model",
      "mock-claude",
    ]);

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(demo.runDemo).toHaveBeenCalledTimes(1);
    expect(demo.runDemo).toHaveBeenCalledWith({
      modelOverride: { provider: "anthropic", model: "mock-claude" },
    });
  });

  test("runs the walkthrough without an override when no flags are given", async () => {
    spyOn(demo, "runDemo").mockResolvedValue(undefined);

    const result = await runCliInProcess(["demo"]);

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(demo.runDemo).toHaveBeenCalledTimes(1);
    expect(demo.runDemo).toHaveBeenCalledWith({});
  });

  test("serializes a non-Error walkthrough rejection as a fatal JSON error", async () => {
    spyOn(demo, "runDemo").mockImplementation(() => {
      throw "demo walkthrough exploded";
    });

    const result = await runCliInProcess(["demo"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: "demo walkthrough exploded",
    });
  });
});
