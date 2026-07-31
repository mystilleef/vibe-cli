import { lstatSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { findPackageRoot } from "./packageRoot.js";
import { expandTildePath } from "./paths.js";
import {
  getPathAncestorsAndSelf,
  rejectSymlinkPathComponentsSync,
} from "./pathValidation.js";
import { hashContent } from "./skills.js";

export {
  getPathAncestorsAndSelf,
  rejectSymlinkPathComponents,
  rejectSymlinkPathComponentsSync,
} from "./pathValidation.js";

export const GUIDE_FILENAME = "vibe-guide.md";
const GUIDE_DOCS_DIR = "docs";

/** Error thrown when the bundled guide source is missing or inaccessible. */
export class GuideSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideSourceError";
  }
}

/** Error thrown when the guide target is invalid or unsafe. */
export class GuideTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideTargetError";
  }
}

/**
 * Resolve the canonical guide source path from the package root.
 *
 * The guide lives at `<package-root>/docs/vibe-guide.md` in both checkout
 * and extracted-package layouts. Uses `findPackageRoot(import.meta.dir)`
 * so resolution works from any source file within the package.
 *
 * @param anchorDir - Directory to walk up from to find package root
 *                    (default: `import.meta.dir`).
 * @returns Absolute path to the canonical guide file.
 * @throws {GuideSourceError} When the guide file is missing or otherwise inaccessible.
 */
export function resolveGuideSource(
  anchorDir: string = import.meta.dir,
): string {
  const packageRoot = findPackageRoot(anchorDir);
  const guidePath = join(packageRoot, GUIDE_DOCS_DIR, GUIDE_FILENAME);

  let stats: Stats;
  try {
    stats = statSync(guidePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GuideSourceError(`Guide source not found: ${guidePath}`);
    }
    throw new GuideSourceError(`Guide source inaccessible: ${guidePath}`);
  }

  if (!stats.isFile()) {
    throw new GuideSourceError(
      `Guide source is not a regular file: ${guidePath}`,
    );
  }

  return guidePath;
}

/**
 * Read the canonical guide content as raw bytes.
 *
 * @param anchorDir - Directory to walk up from to find package root
 *                    (default: `import.meta.dir`).
 * @returns The guide file content Buffer.
 * @throws {GuideSourceError} When the guide is missing or inaccessible.
 */
export function readGuideSourceBuffer(
  anchorDir: string = import.meta.dir,
): Buffer {
  const guidePath = resolveGuideSource(anchorDir);

  try {
    return readFileSync(guidePath);
  } catch (_error) {
    throw new GuideSourceError(`Failed to read guide source: ${guidePath}`);
  }
}

/**
 * Resolve a target root path, expanding `~` to home directory and resolving
 * to an absolute path. Accepts default (cwd), tilde, relative, and absolute inputs.
 *
 * @param target - Optional target path. If omitted, uses `process.cwd()`.
 * @returns Absolute path to the target root.
 * @throws {GuideTargetError} When target is `~` and home directory is unavailable.
 */
export function resolveGuideTarget(target?: string): string {
  try {
    return expandTildePath(target);
  } catch {
    throw new GuideTargetError(
      "Unable to determine home directory (HOME/USERPROFILE not set)",
    );
  }
}

/** Status of the guide relative to its source. */
export type GuideStatus = "missing" | "outdated" | "identical";

/** Result of guide inspection. */
export interface GuideInspection {
  target: string;
  status: GuideStatus;
}

/**
 * Compare pre-read source bytes against whatever exists at `destPath`.
 *
 * Callers that already validated `destPath`'s ancestor chain for symlink
 * safety (e.g. `installGuide`'s `validateTarget`) can call this directly
 * without repeating that walk or re-reading the source file.
 *
 * @param sourceContent - Already-read bytes of the canonical guide.
 * @param destPath - Absolute path to the destination guide file.
 * @throws {GuideTargetError} When the destination is a symlink, not a
 *   regular file, or unreadable.
 */
export function compareGuideHash(
  sourceContent: Buffer,
  destPath: string,
): GuideStatus {
  let destStats: Stats;
  try {
    destStats = lstatSync(destPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "missing";
    }
    throw new GuideTargetError(`Failed to stat guide destination: ${destPath}`);
  }

  if (destStats.isSymbolicLink()) {
    throw new GuideTargetError(`Guide destination is a symlink: ${destPath}`);
  }

  if (!destStats.isFile()) {
    throw new GuideTargetError(
      `Guide destination is not a regular file: ${destPath}`,
    );
  }

  let destContent: Buffer;
  try {
    destContent = readFileSync(destPath);
  } catch {
    throw new GuideTargetError(`Failed to read guide destination: ${destPath}`);
  }

  return hashContent(sourceContent) === hashContent(destContent)
    ? "identical"
    : "outdated";
}

/**
 * Inspect guide drift by comparing source and destination hashes.
 * Does not create directories or files.
 *
 * @param target - Target directory path (optional, defaults to cwd).
 * @param anchorDir - Directory to walk up from to find package root.
 * @returns Inspection result with target path and drift status.
 * @throws {GuideSourceError} When the source guide is missing or inaccessible.
 * @throws {GuideTargetError} When the destination is a symlink.
 */
export function inspectGuide(
  target?: string,
  anchorDir: string = import.meta.dir,
): GuideInspection {
  const sourcePath = resolveGuideSource(anchorDir);
  const targetRoot = resolveGuideTarget(target);
  const destPath = join(targetRoot, GUIDE_FILENAME);

  rejectSymlinkPathComponentsSync(
    getPathAncestorsAndSelf(destPath),
    (component) => lstatSync(component),
    {
      destPath,
      targetRoot,
      errorClass: GuideTargetError,
    },
  );

  let sourceContent: Buffer;
  try {
    sourceContent = readFileSync(sourcePath);
  } catch {
    throw new GuideSourceError(`Failed to read guide source: ${sourcePath}`);
  }

  return {
    target: targetRoot,
    status: compareGuideHash(sourceContent, destPath),
  };
}
