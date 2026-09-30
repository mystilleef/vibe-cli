/**
 * Baseline fallback of the CLI dispatch layer. `runCliInProcess` routes
 * stdout/stderr/console.error/process.exit into an AsyncLocalStorage
 * capture context; outside a capture context — the real CLI process path —
 * every dispatch must fall back to the baseline handler captured at module
 * load. The baseline handlers are bound at import time, so the spies below
 * are installed before the CLI module is dynamically imported, which makes
 * each fallback observable without spawning a subprocess.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
  (() => true) as typeof process.stdout.write,
);
const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
  (() => true) as typeof process.stderr.write,
);
const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
const exitSpy = spyOn(process, "exit").mockImplementation(
  (() => {}) as typeof process.exit,
);

let home: TempHomeContext;
let cliModule: typeof import("../src/cli.js");

beforeAll(async () => {
  // Isolate HOME before the CLI import: module load runs the legacy dotenv
  // warning, which reads `$HOME/.vibe-cli/.env`.
  home = await createTempHome();
  cliModule = await import("../src/cli.js");

  // One captured run installs the dispatch layer; its own output stays
  // inside the capture context and never reaches the spies.
  await cliModule.runCliInProcess(["--version"]);

  // Clear incidental calls (module-load warning probes, capture install).
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
  consoleErrorSpy.mockClear();
  exitSpy.mockClear();
});

afterAll(async () => {
  mock.restore();
  await home.cleanup();
});

describe("cli dispatch baseline fallback", () => {
  test("stdout writes outside capture reach the baseline stream", () => {
    const result = process.stdout.write("fallback-stdout\n");
    expect(result).toBe(true);
    expect(stdoutSpy).toHaveBeenCalledWith("fallback-stdout\n");
  });

  test("stdout forwards Uint8Array chunks to the baseline stream untouched", () => {
    const chunk = new Uint8Array([0x66, 0x61, 0x6c, 0x6c]);
    process.stdout.write(chunk);
    expect(stdoutSpy).toHaveBeenCalledWith(chunk);
  });

  test("stderr writes outside capture reach the baseline stream", () => {
    process.stderr.write("fallback-stderr\n");
    expect(stderrSpy).toHaveBeenCalledWith("fallback-stderr\n");
  });

  test("console.error outside capture reaches the baseline console with all arguments", () => {
    console.error("fallback-console", 42);
    expect(consoleErrorSpy).toHaveBeenCalledWith("fallback-console", 42);
  });

  test("process.exit outside capture calls the baseline exit with the code", () => {
    (process.exit as unknown as (code?: number) => void)(7);
    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  test("process.exit without a code passes undefined to the baseline exit", () => {
    (process.exit as unknown as () => void)();
    expect(exitSpy).toHaveBeenCalledWith(undefined);
  });
});
