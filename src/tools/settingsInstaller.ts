/**
 * Settings installer — safe, idempotent settings installation with dry-run support.
 *
 * Follows the same patterns as guideInstaller.ts but for settings.json.
 */

import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { extractErrorMessage as errorMessage } from "../utils/errors.js";
import { findPackageRoot } from "../utils/packageRoot.js";
import { resolveTargetPath } from "../utils/paths.js";
import { validateProviderSettings } from "../utils/settings.js";
import {
  atomicFileWrite,
  ensureTargetDirectory,
  type InstallerAction,
  InstallerError,
  resolveInstallerAction,
  statRegularFileDestination,
  validateInstallerTarget,
} from "../utils/validation.js";

// ── Constants ──────────────────────────────────────────────────────────────

const SETTINGS_FILENAME = "settings.example.json";
const DESTINATION_FILENAME = "settings.json";

// ── Types ──────────────────────────────────────────────────────────────────

export interface InstallSettingsOptions {
  dryRun: boolean;
  /** Override anchor dir for source discovery (tests). */
  sourceAnchor?: string;
  /** Override data root for target resolution (tests). */
  dataRoot?: string;
  /** Force replacement of existing destination. */
  force?: boolean;
}

export type InstallSettingsAction = InstallerAction;

export type InstallSettingsStatus = "missing" | "present";

export interface InstallSettingsResult {
  /** Absolute path to the settings.json destination file. */
  destination: string;
  dryRun: boolean;
  force: boolean;
  ok: boolean;
  status: InstallSettingsStatus;
  action: InstallSettingsAction;
}

// ── Error classes ──────────────────────────────────────────────────────────

/** Error thrown when settings installation fails (exit 1). */
export class SettingsInstallError extends InstallerError {
  constructor(message: string) {
    super(message);
    this.name = "SettingsInstallError";
  }
}

/** Error thrown when settings installation validation fails (fatal exit 1). */
export class SettingsInstallValidationError extends SettingsInstallError {
  constructor(message: string) {
    super(message);
    this.name = "SettingsInstallValidationError";
  }
}

// ── Source resolution ──────────────────────────────────────────────────────

/**
 * Resolve the canonical settings source path from the package root.
 *
 * @param anchorDir - Directory to walk up from to find package root.
 * @returns Absolute path to the canonical settings.example.json file.
 * @throws {SettingsInstallError} When the source is missing, inaccessible, or not a regular file.
 */
function resolveSourcePath(anchorDir: string): string {
  const packageRoot = findPackageRoot(anchorDir);
  const settingsPath = join(packageRoot, SETTINGS_FILENAME);

  let stats: Stats;
  try {
    stats = lstatSync(settingsPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SettingsInstallError(
        `Settings source not found: ${settingsPath}`,
      );
    }
    throw new SettingsInstallError(
      `Settings source inaccessible: ${settingsPath}`,
    );
  }

  if (stats.isSymbolicLink()) {
    throw new SettingsInstallError(
      `Settings source is a symlink: ${settingsPath}`,
    );
  }

  if (!stats.isFile()) {
    throw new SettingsInstallError(
      `Settings source is not a regular file: ${settingsPath}`,
    );
  }

  return settingsPath;
}

/**
 * Read and validate the settings source file.
 *
 * @param anchorDir - Directory to walk up from to find package root.
 * @returns The validated source content as a Buffer.
 * @throws {SettingsInstallError} When the source is missing, inaccessible, or invalid.
 */
function readAndValidateSource(anchorDir: string): Buffer {
  const sourcePath = resolveSourcePath(anchorDir);

  let content: Buffer;
  try {
    content = readFileSync(sourcePath);
  } catch {
    throw new SettingsInstallError(
      `Failed to read settings source: ${sourcePath}`,
    );
  }

  // Validate JSON syntax
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SettingsInstallError(
        `Malformed JSON in settings source: ${error.message}`,
      );
    }
    throw new SettingsInstallError(
      `Failed to parse settings source: ${errorMessage(error)}`,
    );
  }

  // Validate provider settings structure
  try {
    validateProviderSettings(parsed);
  } catch (error) {
    throw new SettingsInstallError(
      `Settings source validation failed: ${errorMessage(error)}`,
    );
  }

  return content;
}

// ── Destination inspection ─────────────────────────────────────────────────

/**
 * Inspect the destination using metadata only; never reads its bytes.
 *
 * Without `--force` the installer only needs to know whether a regular
 * destination already exists, and with `--force` every present regular
 * destination is replaced. Neither path compares content, so destination
 * bytes are never read.
 *
 * @param destPath - Absolute path to the destination settings file.
 * @returns Status: missing or present.
 * @throws {SettingsInstallError} When the destination is a symlink or not a
 *   regular file.
 */
function inspectDestination(destPath: string): InstallSettingsStatus {
  return statRegularFileDestination(
    destPath,
    "settings",
    SettingsInstallError,
  ) === undefined
    ? "missing"
    : "present";
}

// ── Target resolution ──────────────────────────────────────────────────────

/**
 * Resolve the canonical settings destination path.
 *
 * @param targetRoot - Target directory path (absolute, relative, or tilde).
 * @returns Absolute path to the target root.
 * @throws {SettingsInstallError} When target is `~` and home directory is unavailable.
 */
function resolveTarget(targetRoot: string): string {
  return resolveTargetPath(targetRoot, SettingsInstallError);
}

// ── Action determination ───────────────────────────────────────────────────

/**
 * Determine the installation action from destination status, force flag, and dry-run mode.
 */
function determineAction(
  status: InstallSettingsStatus,
  force: boolean,
  dryRun: boolean,
): InstallSettingsAction {
  if (status === "missing") {
    return resolveInstallerAction("installed", dryRun);
  }
  if (force) {
    return resolveInstallerAction("replaced", dryRun);
  }
  return resolveInstallerAction("skipped", dryRun);
}

// ── Main installer ─────────────────────────────────────────────────────────

/**
 * Install the bundled settings into a target directory.
 *
 * @param targetRoot - Target directory path (absolute, relative, or tilde).
 * @param options - Installation options (dry-run, source anchor, data root, force).
 * @returns Installation result with status and action taken.
 * @throws {SettingsInstallValidationError} When validation fails.
 * @throws {SettingsInstallError} When installation fails.
 */
export async function installSettings(
  targetRoot: string,
  options: InstallSettingsOptions,
): Promise<InstallSettingsResult> {
  const absoluteTargetRoot = options.dataRoot
    ? resolveTarget(options.dataRoot)
    : resolveTarget(targetRoot);
  const sourceAnchor = options.sourceAnchor ?? import.meta.dir;

  // Validate source first (before target)
  const sourceContent = readAndValidateSource(sourceAnchor);

  // Validate target path
  await validateInstallerTarget(absoluteTargetRoot, DESTINATION_FILENAME, {
    validationErrorClass: SettingsInstallValidationError,
    baseErrorClass: SettingsInstallError,
  });

  const destPath = join(absoluteTargetRoot, DESTINATION_FILENAME);
  const status = inspectDestination(destPath);
  const force = options.force ?? false;
  const action = determineAction(status, force, options.dryRun);

  const result: InstallSettingsResult = {
    destination: destPath,
    dryRun: options.dryRun,
    force,
    ok: true,
    status,
    action,
  };

  // Dry-run and untouched present destinations return without
  // mutating the filesystem.
  if (options.dryRun || (status === "present" && !force)) {
    return result;
  }

  await ensureTargetDirectory(absoluteTargetRoot, SettingsInstallError);

  await atomicFileWrite(
    destPath,
    sourceContent,
    ".vibe-settings.tmp",
    SettingsInstallError,
  );

  return result;
}
