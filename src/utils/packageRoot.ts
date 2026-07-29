import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Walk up from `startDir` to the nearest ancestor containing `package.json`.
 * Returns the real path of that ancestor, or the real path of `startDir` when
 * no `package.json` is found up to the filesystem root.
 */
export function findPackageRoot(startDir: string): string {
  let dir: string;
  try {
    dir = realpathSync(startDir);
  } catch {
    dir = startDir;
  }

  const fallback = dir;

  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }

  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}
