/**
 * In-process CLI capture runtime. Dispatch handlers route
 * stdout/stderr/console.error/process.exit into an invocation-local
 * capture context while a captured run is active, and fall back to the
 * baseline handlers bound at module load otherwise.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Invocation-local capture context for one captured CLI run. */
interface CaptureContext {
  readonly stdoutChunks: string[];
  readonly stderrChunks: string[];
  exitCode: number;
}

/** AsyncLocalStorage that scopes capture to a single captured run. */
const captureStore = new AsyncLocalStorage<CaptureContext>();

/** Captured result of one in-process CLI run. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Capture API handed to the body of `runCapturedInvocation`. */
export interface InvocationCapture {
  /** Append raw text to the captured stderr stream. */
  appendStderr(data: string): void;
}

// Baseline handlers — captured once at module load, never replaced per-call.
const baselineStdoutWrite = process.stdout.write.bind(process.stdout);
const baselineStderrWrite = process.stderr.write.bind(process.stderr);
const baselineConsoleError = console.error.bind(console);
const baselineExit = process.exit.bind(process);

/** Dispatch stdout to active capture context or baseline. */
function dispatchStdout(chunk: string | Uint8Array): boolean {
  const ctx = captureStore.getStore();
  if (ctx) {
    ctx.stdoutChunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }
  return baselineStdoutWrite(chunk);
}

/** Dispatch stderr to active capture context or baseline. */
function dispatchStderr(chunk: string | Uint8Array): boolean {
  const ctx = captureStore.getStore();
  if (ctx) {
    ctx.stderrChunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }
  return baselineStderrWrite(chunk);
}

/** Dispatch console.error to active capture context or baseline. */
function dispatchConsoleError(...args: unknown[]): void {
  const ctx = captureStore.getStore();
  if (ctx) {
    const msg = args
      .map((a) => (typeof a === "string" ? a : String(a)))
      .join(" ");
    ctx.stderrChunks.push(`${msg}\n`);
    return;
  }
  baselineConsoleError(...args);
}

/** Dispatch process.exit to active capture context or baseline. */
function dispatchExit(code?: number): never {
  const ctx = captureStore.getStore();
  if (ctx) {
    ctx.exitCode = typeof code === "number" ? code : 0;
    return undefined as never;
  }
  return baselineExit(code);
}

/**
 * Set the exit code without terminating: large payloads must drain through
 * the event loop, which process.exit would truncate. In-process runs capture
 * the code instead of leaking it into the host process.
 */
export function setExitCode(code: number): void {
  const ctx = captureStore.getStore();
  if (ctx) ctx.exitCode = code;
  else process.exitCode = code;
}

/** Install dispatch layer once at module load. */
let dispatchInstalled = false;
function installDispatch(): void {
  if (dispatchInstalled) return;
  process.stdout.write = dispatchStdout as typeof process.stdout.write;
  process.stderr.write = dispatchStderr as typeof process.stderr.write;
  console.error = dispatchConsoleError;
  process.exit = dispatchExit as typeof process.exit;
  dispatchInstalled = true;
}

/**
 * Test seam: emit a marker via console.error when VIBE_TEST_ERROR_MARKER is set.
 * Only used in tests to verify console.error isolation across concurrent captures.
 */
export function emitTestErrorMarker(): void {
  const marker = process.env["VIBE_TEST_ERROR_MARKER"];
  if (marker !== undefined) {
    console.error(marker);
  }
}

/**
 * Install the dispatch layer once, run `body` inside a fresh capture
 * context, and resolve with the assembled stdout, stderr, and exit code.
 * Concurrent invocations stay isolated through the capture context.
 */
export async function runCapturedInvocation(
  body: (capture: InvocationCapture) => Promise<void>,
): Promise<CliResult> {
  installDispatch();

  const ctx: CaptureContext = {
    stdoutChunks: [],
    stderrChunks: [],
    exitCode: 0,
  };

  return captureStore.run(ctx, async () => {
    await body({
      appendStderr: (data: string) => {
        ctx.stderrChunks.push(data);
      },
    });

    return {
      stdout: ctx.stdoutChunks.join(""),
      stderr: ctx.stderrChunks.join("").trim(),
      exitCode: ctx.exitCode,
    };
  });
}
