/**
 * In-capture dispatch coverage for the CLI capture runtime. The baseline
 * fallback (outside any capture context) is covered by
 * `cli.dispatchFallback.test.ts`; this file covers the invocation-local
 * branches: string and binary stream chunks, mixed-type console arguments,
 * exit-code capture without process termination, and the setExitCode seam.
 *
 * Spies are installed before the capture module is imported so its baseline
 * handlers bind to the spies, keeping every fallback write out of the real
 * process streams for a silent test run.
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

const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
  (() => true) as typeof process.stdout.write,
);
const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
  (() => true) as typeof process.stderr.write,
);
const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

type CliCaptureModule = typeof import("../src/utils/cliCapture.js");

let capture: CliCaptureModule;

beforeAll(async () => {
  // Dynamic import after spy installation so baseline handlers bind to spies.
  capture = await import("../src/utils/cliCapture.js");
});

afterAll(() => {
  mock.restore();
});

describe("runCapturedInvocation — in-capture dispatch", () => {
  test("routes stdout string writes into the captured stream only", async () => {
    stdoutSpy.mockClear();

    const result = await capture.runCapturedInvocation(async () => {
      process.stdout.write("captured-out\n");
    });

    expect(result.stdout).toBe("captured-out\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("decodes binary stdout chunks into the captured stream", async () => {
    stdoutSpy.mockClear();

    const result = await capture.runCapturedInvocation(async () => {
      process.stdout.write(new Uint8Array([0x68, 0x69]));
    });

    expect(result.stdout).toBe("hi");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("routes stderr string writes into the captured stream only", async () => {
    stderrSpy.mockClear();

    const result = await capture.runCapturedInvocation(async () => {
      process.stderr.write("captured-err");
    });

    expect(result.stderr).toBe("captured-err");
    expect(result.stdout).toBe("");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("decodes binary stderr chunks into the captured stream", async () => {
    stderrSpy.mockClear();

    const result = await capture.runCapturedInvocation(async () => {
      process.stderr.write(new Uint8Array([0x65, 0x72, 0x72]));
    });

    expect(result.stderr).toBe("err");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("joins mixed-type console.error arguments with spaces into captured stderr", async () => {
    consoleErrorSpy.mockClear();

    const result = await capture.runCapturedInvocation(async () => {
      console.error("code", 42, { nested: true });
    });

    expect(result.stderr).toBe("code 42 [object Object]");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test("preserves stderr interleaving order across write sources", async () => {
    const result = await capture.runCapturedInvocation(async () => {
      process.stderr.write("first ");
      console.error("second");
      process.stderr.write(" third");
    });

    expect(result.stderr).toBe("first second\n third");
  });

  test("captures an explicit exit code without terminating the process", async () => {
    let continued = false;

    const result = await capture.runCapturedInvocation(async () => {
      // The dispatch layer replaces process.exit with a capturing shim that
      // returns instead of terminating; the widened handle makes that
      // runtime contract visible to the type checker.
      const capturedExit: (code?: number) => void = process.exit;
      capturedExit(3);
      continued = true;
    });

    expect(continued).toBe(true);
    expect(result.exitCode).toBe(3);
  });

  test("captures a bare process.exit as exit code zero", async () => {
    const result = await capture.runCapturedInvocation(async () => {
      process.exit();
    });

    expect(result.exitCode).toBe(0);
  });

  test("setExitCode inside a capture writes the captured exit code", async () => {
    const result = await capture.runCapturedInvocation(async () => {
      capture.setExitCode(5);
    });

    expect(result.exitCode).toBe(5);
  });

  test("setExitCode outside a capture writes the process exit code", () => {
    const priorExitCode = process.exitCode;

    try {
      capture.setExitCode(9);
      expect(process.exitCode).toBe(9);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  test("appendStderr accumulates into the trimmed captured stderr", async () => {
    const result = await capture.runCapturedInvocation(async (captureApi) => {
      captureApi.appendStderr("  padded stderr  \n");
    });

    expect(result.stderr).toBe("padded stderr");
  });
});
