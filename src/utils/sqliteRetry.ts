/**
 * Returns `true` when `err` carries an SQLite error code of
 * `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT` — the only transient
 * conflict codes eligible for bounded retry.
 */
export function isTransientSqliteError(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    const code = (err as Error & { code: string }).code;
    return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
  }
  return false;
}

/**
 * Retry a synchronous operation that may fail with transient SQLite errors.
 * Retries up to 3 attempts with incremental backoff (50ms, 100ms).
 * Non-transient errors are thrown immediately.
 */
export function retryOnTransientSqliteError<T>(fn: () => T): T {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isTransientSqliteError(err)) throw err;
      lastError = err;
      if (attempt < maxAttempts - 1) {
        Bun.sleepSync(50 + attempt * 50);
      }
    }
  }
  throw lastError;
}
