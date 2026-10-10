/**
 * Non-blocking child-process execution and result normalization for tests.
 *
 * Tests never block the worker on a child: blocking `spawnSync` spun forever
 * in parallel test workers without reaping its exited child, starving its
 * own timeout and every hook and test timeout. Abnormal process states —
 * timeout, signal termination, spawn error, and null exit status — reject
 * before any stdout or stderr parsing, so output assertions never run
 * against ambiguous completion.
 */

import type { ChildSignal } from "../../src/utils/databaseSnapshot.js";

/** Raw completion record of one child process. */
export interface ChildCompletion {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: ChildSignal;
  error?: Error;
}

export interface SpawnChildOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Milliseconds before the child is killed and reported as timed out. */
  timeout: number;
}

/** Child result with a concrete exit code, safe for output assertions. */
export interface ChildProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Abnormal child-process states rejected before output assertions. */
export type ChildFailureKind =
  | "timeout"
  | "spawn-error"
  | "signal"
  | "null-status";

export interface ChildFailure {
  readonly kind: ChildFailureKind;
  readonly detail: string;
}

export type NormalizedChild =
  | { readonly ok: true; readonly child: ChildProcessResult }
  | { readonly ok: false; readonly failure: ChildFailure };

function startChild(
  command: string,
  args: readonly string[],
  { cwd, env }: SpawnChildOptions,
  deadline: AbortSignal,
) {
  return Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: deadline,
    killSignal: "SIGKILL",
  });
}

/**
 * Spawn a child without blocking the event loop and resolve its completion
 * record. A child outliving `timeout` is killed and carries an `ETIMEDOUT`
 * error; a command that cannot start carries its spawn error.
 */
export async function spawnChild(
  command: string,
  args: readonly string[],
  options: SpawnChildOptions,
): Promise<ChildCompletion> {
  const deadline = AbortSignal.timeout(options.timeout);
  let child: ReturnType<typeof startChild>;
  try {
    child = startChild(command, args, options, deadline);
  } catch (error) {
    return {
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: error as Error,
    };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const completion: ChildCompletion = {
    stdout,
    stderr,
    status: child.exitCode,
    signal: child.signalCode,
  };
  if (!deadline.aborted) return completion;
  return {
    ...completion,
    error: Object.assign(
      new Error(`${command} timed out after ${options.timeout}ms`),
      { code: "ETIMEDOUT" },
    ),
  };
}

/**
 * Classify a completion record. Spawn errors (including timeout), signal
 * termination, and null status yield a typed failure; a concrete exit
 * status, zero or nonzero, yields a normalized result.
 */
export function normalizeChild(result: ChildCompletion): NormalizedChild {
  const error = result.error as (Error & { code?: string }) | undefined;
  if (error) {
    return error.code === "ETIMEDOUT"
      ? {
          ok: false,
          failure: {
            kind: "timeout",
            detail: `child timed out: ${error.message}`,
          },
        }
      : {
          ok: false,
          failure: {
            kind: "spawn-error",
            detail: `child failed to spawn: ${error.message}`,
          },
        };
  }
  if (result.signal !== null) {
    return {
      ok: false,
      failure: {
        kind: "signal",
        detail: `child terminated by signal ${result.signal}`,
      },
    };
  }
  if (result.status === null) {
    return {
      ok: false,
      failure: {
        kind: "null-status",
        detail: "child exited without a status code",
      },
    };
  }
  return {
    ok: true,
    child: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status,
    },
  };
}

/**
 * Normalize a completion record or throw a diagnostic naming the abnormal
 * state and `context`.
 */
export function requireChild(
  result: ChildCompletion,
  context: string,
): ChildProcessResult {
  const normalized = normalizeChild(result);
  if (!normalized.ok) {
    throw new Error(
      `child outcome rejected before output assertions [${context}]: ` +
        `${normalized.failure.kind} — ${normalized.failure.detail}`,
    );
  }
  return normalized.child;
}

/** Spawn a child and require a concrete exit code. */
export async function runChild(
  command: string,
  args: readonly string[],
  options: SpawnChildOptions,
): Promise<ChildProcessResult> {
  return requireChild(
    await spawnChild(command, args, options),
    [command, ...args].join(" "),
  );
}
