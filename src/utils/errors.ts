/**
 * Extract a human-readable message from an unknown catch-clause value.
 */
export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Return `true` when `error` carries an `ENOENT` POSIX errno.
 */
export function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Create a `NodeJS.ErrnoException` with the given POSIX `code` and message. */
export function makeErrno(
  code: string,
  message: string,
): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}
