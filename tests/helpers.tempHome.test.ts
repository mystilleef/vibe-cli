import { afterEach, describe, expect, test } from "bun:test";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext | undefined;

afterEach(async () => {
  if (home) {
    await home.cleanup();
    home = undefined;
  }
});

describe("createTempHome", () => {
  test("preserves original HOME and restores it on cleanup", async () => {
    const originalHome = process.env["HOME"];
    home = await createTempHome();
    expect(process.env["HOME"]).not.toBe(originalHome);
    expect(process.env["HOME"]).toBe(home.home);

    await home.cleanup();
    expect(process.env["HOME"]).toBe(originalHome);
  });

  test("deletes HOME from env when it was not previously set", async () => {
    const savedHome = process.env["HOME"];
    delete process.env["HOME"];

    try {
      home = await createTempHome();
      expect(process.env["HOME"] as string | undefined).toBe(home.home);

      await home.cleanup();
      expect(process.env).not.toHaveProperty("HOME");
    } finally {
      process.env["HOME"] = savedHome;
    }
  });
});
