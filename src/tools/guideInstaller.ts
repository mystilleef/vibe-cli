/**
 * Guide installer — safe, idempotent guide installation with dry-run support.
 *
 * Follows the same patterns as skillsInstaller.ts but for a single file.
 */

import { join } from "node:path";
import { extractErrorMessage } from "../utils/errors.js";
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
  ensureTargetDirectory,
  type InstallerAction,
  InstallerError,
  type PerformedInstallerAction,
  resolveInstallerAction,
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
    throw new GuideInstallError(`${context}: ${extractErrorMessage(error)}`);
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

  await validateInstallerTarget(absoluteTargetRoot, GUIDE_FILENAME, {
    validationErrorClass: GuideInstallValidationError,
    baseErrorClass: GuideInstallError,
  });

  const sourceContent = wrapGuideError(
    () => readGuideSourceBuffer(anchorDir),
    "Failed to read guide source",
  );

  const destPath = join(absoluteTargetRoot, GUIDE_FILENAME);
  const status = wrapGuideError(
    () => compareGuideHash(sourceContent, destPath),
    "Inspection failed",
  );

  let performed: PerformedInstallerAction;
  if (status === "identical") {
    performed = "skipped";
  } else if (status === "missing") {
    performed = "installed";
  } else {
    performed = "replaced";
  }
  const action = resolveInstallerAction(performed, options.dryRun);

  const result: InstallGuideResult = {
    target: absoluteTargetRoot,
    dryRun: options.dryRun,
    ok: true,
    status,
    action,
  };

  if (options.dryRun || status === "identical") {
    return result;
  }

  await ensureTargetDirectory(absoluteTargetRoot, GuideInstallError);

  await atomicFileWrite(
    destPath,
    sourceContent,
    ".vibe-guide.tmp",
    GuideInstallError,
  );

  return result;
}
