/**
 * Guide installer — safe, idempotent guide installation with dry-run support.
 *
 * Follows the same patterns as skillsInstaller.ts but for a single file.
 */

import {
  access,
  constants,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  extractErrorMessage as errorMessage,
  isEnoent,
} from "../utils/errors.js";
import {
  compareGuideHash,
  GUIDE_FILENAME,
  GuideSourceError,
  type GuideStatus,
  GuideTargetError,
  getPathAncestorsAndSelf,
  readGuideSourceBuffer,
  rejectSymlinkPathComponents,
  resolveGuideTarget,
} from "../utils/guide.js";

export interface InstallGuideOptions {
  dryRun: boolean;
  /** Override anchor dir for source discovery (tests). */
  anchorDir?: string;
}

export type InstallGuideAction =
  | "would-install"
  | "would-replace"
  | "would-skip"
  | "installed"
  | "replaced"
  | "skipped";

export interface InstallGuideResult {
  target: string;
  dryRun: boolean;
  ok: boolean;
  status: GuideStatus;
  action: InstallGuideAction;
}

/** Error thrown when guide installation fails (exit 1). */
export class GuideInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideInstallError";
  }
}

/** Error thrown when guide installation validation fails (fatal exit 1). */
export class GuideInstallValidationError extends GuideInstallError {
  constructor(message: string) {
    super(message);
    this.name = "GuideInstallValidationError";
  }
}

/**
 * Walk up from `targetRoot` until an existing directory is found.
 * Returns the first ancestor that exists and is a directory.
 */
async function findExistingAncestor(targetRoot: string): Promise<string> {
  let ancestor = targetRoot;
  while (true) {
    try {
      const stats = await lstat(ancestor);
      if (!stats.isDirectory()) {
        const label = ancestor === targetRoot ? "Target" : "Target parent";
        throw new GuideInstallValidationError(
          `${label} '${ancestor}' is not a directory`,
        );
      }
      return ancestor;
    } catch (error) {
      if (error instanceof GuideInstallValidationError) throw error;
      if (
        isEnoent(error) ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR"
      ) {
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      } else {
        throw new GuideInstallError(
          `Failed to inspect target path '${ancestor}': ${errorMessage(error)}`,
        );
      }
    }
  }
  throw new GuideInstallValidationError(
    `Target parent directory '${targetRoot}' does not exist`,
  );
}

/**
 * Validate the target path and its existing ancestor directory.
 * - Target destination file must not be a symlink
 * - Closest existing ancestor directory of target path must be a directory and writable
 *
 * Runs unconditionally (including dry-run) so an invalid or unwritable target
 * path fails fast instead of silently attempting impossible operations.
 */
async function validateTarget(
  targetRoot: string,
  guideFilename: string,
): Promise<void> {
  const destPath = join(targetRoot, guideFilename);

  await rejectSymlinkPathComponents(getPathAncestorsAndSelf(destPath), lstat, {
    destPath,
    targetRoot,
    errorClass: GuideInstallValidationError,
    formatError: (component, root, error) => {
      if (component === root) {
        return `Failed to inspect target directory '${root}': ${errorMessage(error)}`;
      }
      if (component === destPath) {
        return `Failed to inspect destination '${destPath}': ${errorMessage(error)}`;
      }
      return `Failed to inspect target path '${component}': ${errorMessage(error)}`;
    },
  });

  const existingAncestor = await findExistingAncestor(targetRoot);

  try {
    await access(existingAncestor, constants.W_OK);
  } catch {
    throw new GuideInstallValidationError(
      `No write access to target parent '${existingAncestor}'`,
    );
  }
}

/**
 * Wrap a guide operation, converting guide-specific errors to GuideInstallError.
 */
function wrapGuideError<T>(operation: () => T, context: string): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GuideSourceError) {
      throw new GuideInstallError(`Source error: ${error.message}`);
    }
    if (error instanceof GuideTargetError) {
      throw new GuideInstallError(`Target error: ${error.message}`);
    }
    throw new GuideInstallError(`${context}: ${errorMessage(error)}`);
  }
}

/**
 * Install the bundled guide into a target directory.
 *
 * @param targetRoot - Target directory path (absolute, relative, or tilde).
 * @param options - Installation options (dry-run, anchor dir).
 * @returns Installation result with status and action taken.
 * @throws {GuideInstallValidationError} When validation fails.
 * @throws {GuideInstallError} When installation fails.
 */
export async function installGuide(
  targetRoot: string,
  options: InstallGuideOptions,
): Promise<InstallGuideResult> {
  const absoluteTargetRoot = resolveGuideTarget(targetRoot);
  const anchorDir = options.anchorDir ?? import.meta.dir;

  await validateTarget(absoluteTargetRoot, GUIDE_FILENAME);

  const sourceContent = wrapGuideError(
    () => readGuideSourceBuffer(anchorDir),
    "Failed to read guide source",
  );

  const destPath = join(absoluteTargetRoot, GUIDE_FILENAME);
  const status = wrapGuideError(
    () => compareGuideHash(sourceContent, destPath),
    "Inspection failed",
  );

  let action: InstallGuideAction;
  if (status === "identical") {
    action = options.dryRun ? "would-skip" : "skipped";
  } else if (status === "missing") {
    action = options.dryRun ? "would-install" : "installed";
  } else {
    action = options.dryRun ? "would-replace" : "replaced";
  }

  if (options.dryRun) {
    return {
      target: absoluteTargetRoot,
      dryRun: true,
      ok: true,
      status,
      action,
    };
  }

  if (status === "identical") {
    return {
      target: absoluteTargetRoot,
      dryRun: false,
      ok: true,
      status,
      action: "skipped",
    };
  }

  try {
    await mkdir(absoluteTargetRoot, { recursive: true });
  } catch (error) {
    throw new GuideInstallError(
      `Failed to create target '${absoluteTargetRoot}': ${errorMessage(error)}`,
    );
  }

  const tempPath = join(
    absoluteTargetRoot,
    `.vibe-guide.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
  try {
    await writeFile(tempPath, sourceContent);
    await rename(tempPath, destPath);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failure
    }
    throw new GuideInstallError(
      `Failed to install guide to '${destPath}': ${errorMessage(error)}`,
    );
  }

  return {
    target: absoluteTargetRoot,
    dryRun: false,
    ok: true,
    status,
    action,
  };
}
