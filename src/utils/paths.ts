import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Return the user's home directory or throw if unavailable.
 */
export function getSafeHomedir(): string {
  const home = process.env["HOME"] ?? homedir();
  if (!home) {
    throw new Error(
      "Unable to determine home directory (HOME/USERPROFILE not set)",
    );
  }
  return home;
}

/**
 * Resolve a path that may start with `~` (tilde expansion).
 * Falls back to `defaultTo` when `target` is empty or undefined.
 */
export function expandTildePath(target?: string, defaultTo?: string): string {
  if (!target) {
    return resolve(defaultTo ?? process.cwd());
  }
  if (target === "~") {
    return resolve(getSafeHomedir());
  }
  if (target.startsWith("~")) {
    return resolve(join(getSafeHomedir(), target.slice(1)));
  }
  return resolve(target);
}
