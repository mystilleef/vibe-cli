/**
 * Packed CLI child-process result normalization.
 *
 * Rejects abnormal process states — timeout, signal termination, spawn
 * error, and null exit status — before any stdout or stderr parsing, so
 * output assertions never run against ambiguous completion. Deterministic:
 * classification derives only from the child-result record, never from
 * platform timing.
 */

import type { SpawnSyncReturns } from "node:child_process";

/**
 * Normalized packed CLI child result with a concrete exit code.
 * Produced only after abnormal process states have been rejected.
 */
export interface PackedChildProcess {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Abnormal child-process states rejected before output assertions. */
export type PackedChildFailureKind =
  | "timeout"
  | "spawn-error"
  | "signal"
  | "null-status";

/** Deterministic diagnostic for an abnormal child-process state. */
export interface PackedChildFailure {
  readonly kind: PackedChildFailureKind;
  readonly detail: string;
}

export type NormalizedPackedChild =
  | { readonly ok: true; readonly child: PackedChildProcess }
  | { readonly ok: false; readonly failure: PackedChildFailure };

/**
 * Classify a raw `spawnSync` result. Abnormal states — spawn error
 * (including timeout), signal termination, null status — yield a typed
 * failure; a concrete exit status (zero or nonzero) yields a normalized
 * child result.
 */
export function normalizePackedChild(
  result: SpawnSyncReturns<string>,
): NormalizedPackedChild {
  const error = result.error as (Error & { code?: string }) | undefined;
  if (error) {
    if (error.code === "ETIMEDOUT") {
      return {
        ok: false,
        failure: {
          kind: "timeout",
          detail: `packed CLI child timed out: ${error.message}`,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: "spawn-error",
        detail: `packed CLI child failed to spawn: ${error.message}`,
      },
    };
  }
  if (result.signal !== null) {
    return {
      ok: false,
      failure: {
        kind: "signal",
        detail: `packed CLI child terminated by signal ${result.signal}`,
      },
    };
  }
  if (result.status === null) {
    return {
      ok: false,
      failure: {
        kind: "null-status",
        detail: "packed CLI child exited without a status code",
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
 * Normalize a raw `spawnSync` result or throw a deterministic diagnostic
 * naming the abnormal state. Callers receive a result with a concrete
 * exit code; stdout and stderr are safe to parse only after this guard.
 */
export function requirePackedChild(
  result: SpawnSyncReturns<string>,
  context: string,
): PackedChildProcess {
  const normalized = normalizePackedChild(result);
  if (!normalized.ok) {
    throw new Error(
      `Packed CLI outcome rejected before output assertions [${context}]: ` +
        `${normalized.failure.kind} — ${normalized.failure.detail}`,
    );
  }
  return normalized.child;
}
