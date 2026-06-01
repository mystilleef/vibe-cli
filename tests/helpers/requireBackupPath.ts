import { expect } from "bun:test";
import { existsSync } from "node:fs";

/** Assert a non-null backup path exists on disk and return it. */
export function requireBackupPath(result: {
  backupPath: string | null;
}): string {
  if (result.backupPath === null) throw new Error("missing backup path");
  expect(existsSync(result.backupPath)).toBe(true);
  return result.backupPath;
}
