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

/**
 * Resolve a target path with tilde expansion, throwing a typed error
 * when the home directory is unavailable.
 *
 * Consolidates the pattern shared by `resolveGuideTarget`,
 * `resolveTargetRoot`, and the settings installer's target resolution.
 *
 * @param target - Optional target path (absolute, relative, or tilde).
 * @param errorClass - Error constructor for the home-directory failure.
 * @returns Absolute resolved path.
 */
export function resolveTargetPath<E extends new (message: string) => Error>(
  target: string | undefined,
  errorClass: E,
): string {
  try {
    return expandTildePath(target);
  } catch {
    throw new errorClass(
      "Unable to determine home directory (HOME/USERPROFILE not set)",
    );
  }
}
