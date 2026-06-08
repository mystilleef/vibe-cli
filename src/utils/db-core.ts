import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Returns the vibe-cli data root directory (`~/.vibe-cli`).
 *
 * Uses `$HOME` when set, falling back to `os.homedir()`.
 */
export function getDataRoot(): string {
  return path.join(process.env["HOME"] ?? os.homedir(), ".vibe-cli");
}

/** Creates the data root directory if it does not already exist. */
export function ensureDataDir(): void {
  const dataDir = getDataRoot();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}
