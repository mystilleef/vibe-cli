/**
 * Subprocess-backed SQLite snapshot executor for transaction-consistent safety backups.
 *
 * Executes `VACUUM INTO` in an isolated Bun subprocess opened readonly with
 * `busy_timeout=0` and no contention retries. The subprocess runs outside the parent
 * event loop, leaves parent-process connections untouched, and supports an optional
 * internal observation/barrier contract for test coordination.
 *
 * Child lifecycle frames are validated against an ordered protocol, and every wait for
 * protocol progress — stream read, observer callback, child exit — stays bounded by the
 * configured timeout. A child that times out, misbehaves, or fails an observer is
 * terminated, drained, and awaited to actual exit before the executor settles.
 */

import path from "node:path";
import { extractErrorMessage } from "./errors.js";

/** Observed boundary of an actual SQL execution event. */
export interface DatabaseSnapshotBoundary {
  /** Wall-clock millisecond epoch timestamp comparable across independent processes. */
  readonly timestamp: number;
  /** High-resolution monotonic timestamp in nanoseconds. */
  readonly hrtime?: number | undefined;
}

/** Termination signal of a Bun child; numeric when the name is unknown. */
export type ChildSignal = NodeJS.Signals | number | null;

/** Information about a reaped child snapshot process. */
export interface DatabaseSnapshotReaped {
  readonly exitCode: number | null;
  readonly signal: ChildSignal;
}

/** Control object provided to `DatabaseSnapshotObserver.onReady`. */
export interface DatabaseSnapshotControl {
  /** Authorize the child executor to proceed with `VACUUM INTO`. */
  authorizeStart: () => void;
}

/**
 * Optional lifecycle observer for database snapshot coordination and concurrency testing.
 */
export interface DatabaseSnapshotObserver {
  /** Invoked before spawning the child process. */
  onBeforeSpawn?: () => void | Promise<void>;
  /** Invoked when the child process has opened the database and is ready. */
  onReady?: (control: DatabaseSnapshotControl) => void | Promise<void>;
  /** Invoked immediately before `VACUUM INTO ?` execution in the child. */
  onSqlStart?: (boundary: DatabaseSnapshotBoundary) => void | Promise<void>;
  /** Invoked immediately after `VACUUM INTO ?` execution in the child. */
  onSqlEnd?: (boundary: DatabaseSnapshotBoundary) => void | Promise<void>;
  /** Invoked after the child process has exited and been reaped. */
  onReaped?: (reaped: DatabaseSnapshotReaped) => void | Promise<void>;
}

/** Options for database snapshot execution. */
export interface DatabaseSnapshotOptions {
  /** Optional lifecycle observer. */
  observer?: DatabaseSnapshotObserver;
  /** Whether the child executor should pause after readiness and await explicit authorization. */
  gated?: boolean;
  /**
   * Maximum execution time in milliseconds, covering child runtime, observer
   * callbacks, and completion, before terminating the child (default: 30,000).
   */
  timeout?: number;
}

/** Injectable seam signature for snapshot execution. */
export type DatabaseSnapshotExecutor = (
  sourcePath: string,
  destinationPath: string,
  options?: DatabaseSnapshotOptions,
) => Promise<void>;

const SNAPSHOT_CHILD_SCRIPT = `
import { Database } from "bun:sqlite";

const args = process.argv.slice(1);
const sourcePath = args[0];
const destinationPath = args[1];
const isGated = args.includes("--gated");

function emit(type, data = {}) {
  process.stdout.write(
    JSON.stringify({
      type,
      timestamp: Date.now(),
      hrtime: Number(process.hrtime.bigint()),
      ...data,
    }) + "\\n"
  );
}

let db = null;
try {
  db = new Database(sourcePath, { readonly: true, create: false });
  db.run("PRAGMA busy_timeout = 0");
  emit("ready");

  if (isGated) {
    process.stdin.resume();
    await new Promise((resolve, reject) => {
      process.stdin.once("data", (chunk) => {
        if (chunk.toString().includes("START")) resolve();
      });
      process.stdin.once("end", () =>
        reject(new Error("child stdin closed before authorization"))
      );
      process.stdin.once("error", reject);
    });
  }

  emit("sql-start");
  db.run("VACUUM INTO ?", [destinationPath]);
  emit("sql-end");

  db.close();
  db = null;
  emit("done");
  process.exit(0);
} catch (error) {
  if (db !== null) {
    try {
      db.close();
    } catch {}
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + "\\n");
  process.exit(1);
}
`;

/** Ordered lifecycle events a healthy snapshot child emits. */
const SNAPSHOT_PROTOCOL_SEQUENCE = [
  "ready",
  "sql-start",
  "sql-end",
  "done",
] as const;

type SnapshotProtocolEvent = (typeof SNAPSHOT_PROTOCOL_SEQUENCE)[number];

const SNAPSHOT_PROTOCOL_EVENTS: ReadonlySet<string> = new Set(
  SNAPSHOT_PROTOCOL_SEQUENCE,
);

/** Fixed grace for a termination-triggered observer callback to complete. */
const TERMINATION_GRACE_MS = 250;

/** Parsed child lifecycle frame with comparable timestamps. */
interface SnapshotProtocolFrame {
  readonly type: SnapshotProtocolEvent;
  readonly timestamp: number;
  readonly hrtime: number | undefined;
}

/**
 * Parse one child stdout line into a lifecycle frame. Every frame must be a
 * JSON object with a known event type and finite timestamp; anything else is a
 * protocol failure, never a silently skipped line.
 */
function parseSnapshotProtocolFrame(line: string): SnapshotProtocolFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("snapshot protocol frame is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("snapshot protocol frame is not a JSON object");
  }
  const frame = parsed as Record<string, unknown>;
  const type = frame["type"];
  if (typeof type !== "string" || !SNAPSHOT_PROTOCOL_EVENTS.has(type)) {
    throw new Error(
      `snapshot protocol emitted an unknown event: ${String(type)}`,
    );
  }
  const timestamp = frame["timestamp"];
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error(
      `snapshot protocol emitted "${type}" without a valid timestamp`,
    );
  }
  const hrtime = frame["hrtime"];
  return {
    type: type as SnapshotProtocolEvent,
    timestamp,
    hrtime: typeof hrtime === "number" ? hrtime : undefined,
  };
}

/** Outcome of racing one awaited operation against a settlement bound. */
type SnapshotSettlement<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "bound" };

/**
 * Race `operation` against `bound` so no stream read, observer callback, or
 * child exit holds settlement open past its deadline. Rejections are captured
 * here, never left to surface as unhandled rejections.
 */
function raceSnapshotSettlement<T>(
  bound: Promise<void>,
  operation: Promise<T>,
): Promise<SnapshotSettlement<T>> {
  return Promise.race([
    operation.then(
      (value) => ({ kind: "value", value }) as const,
      (error) => ({ kind: "error", error }) as const,
    ),
    bound.then(() => ({ kind: "bound" }) as const),
  ]);
}

/**
 * Dispatch one validated child frame to its matching observer callback.
 */
async function invokeSnapshotObserver(
  frame: SnapshotProtocolFrame,
  observer: DatabaseSnapshotObserver | undefined,
  control: DatabaseSnapshotControl,
): Promise<void> {
  if (frame.type === "ready" && observer?.onReady) {
    await observer.onReady(control);
  } else if (frame.type === "sql-start" && observer?.onSqlStart) {
    await observer.onSqlStart({
      timestamp: frame.timestamp,
      hrtime: frame.hrtime,
    });
  } else if (frame.type === "sql-end" && observer?.onSqlEnd) {
    await observer.onSqlEnd({
      timestamp: frame.timestamp,
      hrtime: frame.hrtime,
    });
  }
}

/**
 * Validate one child frame against the ordered protocol and the gated
 * authorization contract. Returns the protocol violation, or `null` when the
 * frame may be counted and dispatched.
 */
function checkSnapshotProtocolOrder(
  frame: SnapshotProtocolFrame,
  protocolIndex: number,
  gated: boolean,
  authorized: boolean,
): Error | null {
  const expected = SNAPSHOT_PROTOCOL_SEQUENCE[protocolIndex];
  if (expected === undefined) {
    return new Error(
      `snapshot protocol violation: unexpected "${frame.type}" after completion`,
    );
  }
  if (frame.type !== expected) {
    return new Error(
      `snapshot protocol violation: received "${frame.type}" while expecting "${expected}"`,
    );
  }
  if (frame.type === "sql-start" && gated && !authorized) {
    return new Error(
      "snapshot protocol violation: child started SQL before authorization",
    );
  }
  return null;
}

/** One awaited stdout read: a chunk, or end-of-stream. */
type SnapshotReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value: Uint8Array | undefined };

/** stdout reader surface the protocol loop consumes. */
interface SnapshotStreamReader {
  read(): Promise<SnapshotReadResult>;
}

/** Outcome of consuming the child's stdout protocol stream. */
interface SnapshotProtocolRun {
  /** First failure encountered, or `null` when consumption ran clean. */
  readonly failureError: unknown;
  /** Count of lifecycle frames accepted in order. */
  readonly protocolIndex: number;
  /** Whether the child closed its stdout stream. */
  readonly stdoutEnded: boolean;
}

/** Outcome of consuming one protocol line: continue, or halt consumption. */
type SnapshotLineOutcome =
  | { readonly kind: "continue"; readonly protocolIndex: number }
  | {
      readonly kind: "halt";
      readonly protocolIndex: number;
      readonly failureError: unknown;
    };

/**
 * Validate and dispatch one protocol line: parse the frame, enforce the
 * ordered lifecycle and gated-authorization contract, and dispatch it to the
 * observer under `deadline`. The outcome carries the advanced protocol index;
 * a parse failure, violation, dispatch failure, or bound halts consumption
 * with the effective failure (`null` for a bound).
 */
async function processSnapshotProtocolLine(params: {
  line: string;
  protocolIndex: number;
  deadline: Promise<void>;
  observer: DatabaseSnapshotObserver | undefined;
  control: DatabaseSnapshotControl;
  gated: boolean;
  isAuthorized: () => boolean;
}): Promise<SnapshotLineOutcome> {
  const {
    line,
    protocolIndex,
    deadline,
    observer,
    control,
    gated,
    isAuthorized,
  } = params;
  let frame: SnapshotProtocolFrame;
  try {
    frame = parseSnapshotProtocolFrame(line);
  } catch (error) {
    return { kind: "halt", protocolIndex, failureError: error };
  }
  const violation = checkSnapshotProtocolOrder(
    frame,
    protocolIndex,
    gated,
    isAuthorized(),
  );
  if (violation !== null) {
    return { kind: "halt", protocolIndex, failureError: violation };
  }
  const nextIndex = protocolIndex + 1;
  const dispatchOutcome = await raceSnapshotSettlement(
    deadline,
    invokeSnapshotObserver(frame, observer, control),
  );
  if (dispatchOutcome.kind === "error") {
    return {
      kind: "halt",
      protocolIndex: nextIndex,
      failureError: dispatchOutcome.error,
    };
  }
  if (dispatchOutcome.kind === "bound") {
    return { kind: "halt", protocolIndex: nextIndex, failureError: null };
  }
  return { kind: "continue", protocolIndex: nextIndex };
}

/**
 * Consume the child's stdout protocol stream: parse frames, enforce the
 * ordered lifecycle and gated-authorization contract, and dispatch every
 * accepted frame to the observer. Each read and callback stays bounded by
 * `deadline`; a bound or failure ends consumption without disturbing the
 * child, whose settlement the caller owns.
 */
async function runSnapshotProtocolLoop(params: {
  reader: SnapshotStreamReader;
  deadline: Promise<void>;
  observer: DatabaseSnapshotObserver | undefined;
  control: DatabaseSnapshotControl;
  gated: boolean;
  isAuthorized: () => boolean;
  hasTimedOut: () => boolean;
}): Promise<SnapshotProtocolRun> {
  const {
    reader,
    deadline,
    observer,
    control,
    gated,
    isAuthorized,
    hasTimedOut,
  } = params;
  let failureError: unknown = null;
  let stdoutEnded = false;
  let protocolIndex = 0;
  let stdoutBuffer = "";

  readLoop: while (failureError === null && !hasTimedOut()) {
    const readOutcome = await raceSnapshotSettlement(deadline, reader.read());
    if (readOutcome.kind === "bound") break;
    if (readOutcome.kind === "error") {
      failureError = readOutcome.error;
      break;
    }
    const { value, done } = readOutcome.value;
    if (done) {
      stdoutEnded = true;
      break;
    }
    stdoutBuffer += new TextDecoder().decode(value);
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const lineOutcome = await processSnapshotProtocolLine({
        line,
        protocolIndex,
        deadline,
        observer,
        control,
        gated,
        isAuthorized,
      });
      protocolIndex = lineOutcome.protocolIndex;
      if (lineOutcome.kind === "halt") {
        failureError = lineOutcome.failureError;
        break readLoop;
      }
    }
  }

  return { failureError, protocolIndex, stdoutEnded };
}

/** Terminal state of one snapshot execution, evaluated in precedence order. */
interface SnapshotOutcome {
  readonly failureError: unknown;
  readonly timedOut: boolean;
  readonly signal: ChildSignal;
  readonly exitCode: number | null;
  readonly protocolIndex: number;
  readonly stderr: string;
  readonly timeout: number;
}

/**
 * Throw unless the snapshot completed cleanly. Precedence: captured failure,
 * timeout, child signal, child exit status, then protocol completeness.
 */
function throwOnSnapshotOutcome(outcome: SnapshotOutcome): void {
  const {
    failureError,
    timedOut,
    signal,
    exitCode,
    protocolIndex,
    stderr,
    timeout,
  } = outcome;
  if (failureError !== null) {
    throw failureError;
  }
  if (timedOut) {
    throw new Error(`snapshot process timed out after ${timeout}ms`);
  }
  if (signal !== null) {
    throw new Error(`snapshot process terminated by signal ${signal}`);
  }
  if (exitCode !== 0) {
    const detail = stderr.trim() || `exit code ${exitCode}`;
    throw new Error(`snapshot execution failed: ${detail}`);
  }
  if (protocolIndex !== SNAPSHOT_PROTOCOL_SEQUENCE.length) {
    const missing = SNAPSHOT_PROTOCOL_SEQUENCE.slice(protocolIndex)
      .map((type) => `"${type}"`)
      .join(", ");
    throw new Error(
      `snapshot protocol incomplete: child exited successfully without ${missing}`,
    );
  }
}

/**
 * Run the optional pre-spawn observer callback bounded by `deadline`. A bound
 * or observer failure throws before the child is ever spawned.
 */
async function dispatchSnapshotBeforeSpawn(
  observer: DatabaseSnapshotObserver | undefined,
  deadline: Promise<void>,
  timeout: number,
): Promise<void> {
  if (!observer?.onBeforeSpawn) return;
  const outcome = await raceSnapshotSettlement(
    deadline,
    (async () => {
      await observer.onBeforeSpawn?.();
    })(),
  );
  if (outcome.kind === "bound") {
    throw new Error(`snapshot process timed out after ${timeout}ms`);
  }
  if (outcome.kind === "error") {
    throw outcome.error;
  }
}

/**
 * Spawn the isolated snapshot child. Launch failures surface as one wrapped
 * error; the caller owns everything after a successful spawn.
 */
function spawnSnapshotChild(
  sourcePath: string,
  destinationPath: string,
  gated: boolean,
): ReturnType<typeof Bun.spawn> {
  try {
    return Bun.spawn(
      [
        process.execPath,
        "-e",
        SNAPSHOT_CHILD_SCRIPT,
        sourcePath,
        destinationPath,
        ...(gated ? ["--gated"] : []),
      ],
      {
        cwd: path.dirname(sourcePath),
        env: { ...process.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  } catch (error) {
    throw new Error(
      `snapshot process failed to spawn: ${extractErrorMessage(error)}`,
    );
  }
}

/**
 * Return a usable child pipe stream. A missing stream or a numeric handle —
 * an inherited file descriptor, never a pipe — fails as unavailable.
 */
function requireSubprocessPipe<T extends object>(
  stream: T | null | number | undefined,
  label: string,
): T {
  if (!stream || typeof stream === "number") {
    throw new Error(`subprocess ${label} pipe is unavailable`);
  }
  return stream;
}

/**
 * Settle the child after protocol consumption. A captured failure — or a
 * completion racing past `deadline` — terminates the child first; then queued
 * stdout is drained, stderr is captured, and the child's actual exit is
 * awaited, so settlement and staging cleanup never race ahead of reaping.
 * Returns the effective failure and captured stderr.
 */
async function settleSnapshotChild(params: {
  failureError: unknown;
  deadline: Promise<void>;
  reader: SnapshotStreamReader;
  stdoutEnded: boolean;
  stderrPromise: Promise<string>;
  childExit: Promise<void>;
  terminateChild: () => void;
}): Promise<{ failureError: unknown; stderr: string }> {
  const { deadline, reader, stderrPromise, childExit, terminateChild } = params;
  let { failureError, stdoutEnded } = params;
  let stderr = "";

  const drainStdout = async (): Promise<void> => {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  };

  // After termination, drain queued stdout, capture stderr, and await the
  // child's actual exit. A killed child closes its pipes and exits, so these
  // awaits end; settlement and staging cleanup never race ahead of reaping.
  const settleChild = async (): Promise<void> => {
    const settleOutput = (async () => {
      if (!stdoutEnded) {
        stdoutEnded = true;
        try {
          await drainStdout();
        } catch {
          // The terminated child closed the stream mid-read.
        }
      }
      try {
        stderr = await stderrPromise;
      } catch {
        // stderr is diagnostic only; capture failure must not mask the cause.
      }
    })();
    await Promise.all([settleOutput, childExit]);
  };

  if (failureError !== null) {
    terminateChild();
    await settleChild();
  } else {
    const completion = Promise.all([stderrPromise, childExit]).then(
      ([text]) => text,
    );
    const completionOutcome = await raceSnapshotSettlement(
      deadline,
      completion,
    );
    if (completionOutcome.kind === "value") {
      stderr = completionOutcome.value;
    } else {
      if (completionOutcome.kind === "error") {
        failureError = completionOutcome.error;
      }
      terminateChild();
      await settleChild();
    }
  }

  return { failureError, stderr };
}

/**
 * Dispatch the optional reaped-observer callback bounded by the termination
 * grace once termination started, and by `deadline` otherwise. A reaped
 * failure never replaces an earlier primary failure.
 */
async function dispatchSnapshotReaped(params: {
  observer: DatabaseSnapshotObserver | undefined;
  exitCode: number | null;
  signal: ChildSignal;
  failureError: unknown;
  timedOut: boolean;
  deadline: Promise<void>;
  terminationCutoff: Promise<void>;
}): Promise<unknown> {
  const { observer, exitCode, signal, timedOut, deadline, terminationCutoff } =
    params;
  let { failureError } = params;
  const reapedCallback = observer?.onReaped;
  if (reapedCallback) {
    const bound =
      failureError !== null || timedOut ? terminationCutoff : deadline;
    const reapedOutcome = await raceSnapshotSettlement(
      bound,
      (async () => {
        await reapedCallback({ exitCode, signal });
      })(),
    );
    if (reapedOutcome.kind === "error" && failureError === null) {
      failureError = reapedOutcome.error;
    }
  }
  return failureError;
}

/**
 * Execute a SQLite snapshot from `sourcePath` to `destinationPath` in an
 * isolated Bun subprocess.
 *
 * Validates the ordered child lifecycle before any caller treats the snapshot
 * as complete, and settles only after every awaited child resource is
 * terminated, drained, and reaped.
 */
export async function executeDatabaseSnapshot(
  sourcePath: string,
  destinationPath: string,
  options: DatabaseSnapshotOptions = {},
): Promise<void> {
  const { observer, gated = false, timeout = 30_000 } = options;

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stdin: ReturnType<typeof Bun.spawn>["stdin"] | null = null;

  let timedOut = false;
  const deadline = Promise.withResolvers<void>();
  const termination = Promise.withResolvers<void>();

  // Observer completion gets one fixed grace window once termination starts,
  // so a termination-triggered callback that never resolves cannot hold
  // settlement open. Actual child reaping is awaited separately below.
  let terminationTimer: ReturnType<typeof setTimeout> | null = null;
  const terminationCutoff = termination.promise.then(
    () =>
      new Promise<void>((resolve) => {
        terminationTimer = setTimeout(resolve, TERMINATION_GRACE_MS);
      }),
  );

  let terminationArmed = false;
  const terminateChild = () => {
    if (proc !== null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Child may have already exited.
      }
    }
    if (stdin && typeof stdin !== "number") {
      try {
        stdin.end();
      } catch {
        // Child may have already closed stdin.
      }
    }
    if (!terminationArmed) {
      terminationArmed = true;
      termination.resolve();
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    deadline.resolve();
    terminateChild();
  }, timeout);

  try {
    await dispatchSnapshotBeforeSpawn(observer, deadline.promise, timeout);
    if (timedOut) {
      throw new Error(`snapshot process timed out after ${timeout}ms`);
    }

    proc = spawnSnapshotChild(sourcePath, destinationPath, gated);

    // Pipe failure terminates the child before surfacing the pipe error.
    const requirePipe = <T extends object>(
      stream: T | null | number | undefined,
      label: string,
    ): T => {
      try {
        return requireSubprocessPipe(stream, label);
      } catch (error) {
        terminateChild();
        throw error;
      }
    };

    const validStdin = requirePipe(proc.stdin, "stdin");
    stdin = validStdin;
    const stdout = requirePipe(proc.stdout, "stdout");
    const stderrStream = requirePipe(proc.stderr, "stderr");

    let authorized = false;
    const authorizeStart = () => {
      if (authorized) return;
      authorized = true;
      try {
        validStdin.write("START\n");
        validStdin.flush();
      } catch {
        // Child may have already closed stdin.
      }
    };

    const control: DatabaseSnapshotControl = { authorizeStart };

    const reader = stdout.getReader();
    const stderrPromise = new Response(stderrStream).text();
    const childExit = proc.exited.then(
      () => undefined,
      () => undefined,
    );

    const protocolRun = await runSnapshotProtocolLoop({
      reader,
      deadline: deadline.promise,
      observer,
      control,
      gated,
      isAuthorized: () => authorized,
      hasTimedOut: () => timedOut,
    });

    const settled = await settleSnapshotChild({
      failureError: protocolRun.failureError,
      deadline: deadline.promise,
      reader,
      stdoutEnded: protocolRun.stdoutEnded,
      stderrPromise,
      childExit,
      terminateChild,
    });
    let { failureError } = settled;
    const { stderr } = settled;

    const exitCode = proc.exitCode ?? null;
    const signal = proc.signalCode ?? null;
    failureError = await dispatchSnapshotReaped({
      observer,
      exitCode,
      signal,
      failureError,
      timedOut,
      deadline: deadline.promise,
      terminationCutoff,
    });

    if (terminationTimer !== null) {
      clearTimeout(terminationTimer);
    }
    try {
      reader.releaseLock();
    } catch {
      // A read the grace window could not settle still owns the lock.
    }

    throwOnSnapshotOutcome({
      failureError,
      timedOut,
      signal,
      exitCode,
      protocolIndex: protocolRun.protocolIndex,
      stderr,
      timeout,
    });
  } finally {
    clearTimeout(timer);
  }
}
