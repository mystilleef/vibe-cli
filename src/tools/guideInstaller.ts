/**
 * Guide installer — safe, idempotent guide installation with dry-run support.
 *
 * Follows the same patterns as skillsInstaller.ts but for a single file.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extractErrorMessage as errorMessage } from "../utils/errors.js";
import {
  compareGuideHash,
  GUIDE_FILENAME,
  GuideSourceError,
  type GuideStatus,
  GuideTargetError,
  readGuideSourceBuffer,
  resolveGuideTarget,
} from "../utils/guide.js";
import {
  atomicFileWrite,
  type InstallerAction,
  InstallerError,
  validateInstallerTarget,
} from "../utils/validation.js";

export interface InstallGuideOptions {
  dryRun: boolean;
  /** Override anchor dir for source discovery (tests). */
  anchorDir?: string;
}

export type InstallGuideAction = InstallerAction;

export interface InstallGuideResult {
  target: string;
  dryRun: boolean;
  ok: boolean;
  status: GuideStatus;
  action: InstallGuideAction;
}

/** Error thrown when guide installation fails (exit 1). */
export class GuideInstallError extends InstallerError {
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
 * Validate the target path and its existing ancestor directory.
 * Delegates to shared validateInstallerTarget from validation.ts.
 */
async function validateTarget(
  targetRoot: string,
  guideFilename: string,
): Promise<void> {
  await validateInstallerTarget(targetRoot, guideFilename, {
    validationErrorClass: GuideInstallValidationError,
    baseErrorClass: GuideInstallError,
  });
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

  await atomicFileWrite(
    destPath,
    sourceContent,
    ".vibe-guide.tmp",
    GuideInstallError,
  );

  return {
    target: absoluteTargetRoot,
    dryRun: false,
    ok: true,
    status,
    action,
  };
}
