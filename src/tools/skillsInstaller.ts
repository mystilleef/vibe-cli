// Plain recursive copy — no locking/staging/rollback. Previous
// transactional machinery modeled a hostile-multi-tenant threat that
// doesn't apply to a single-user home-directory install. See
// proposals/simplify-skill-installation.md.

import type { Stats } from "node:fs";
import { access, constants, cp, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  extractErrorMessage as errorMessage,
  isEnoent,
} from "../utils/errors.js";
import { findPackageRoot } from "../utils/packageRoot.js";
import {
  computeSkillsInventory,
  SkillSourceError,
  type SkillsInventory,
  SkillTargetError,
} from "../utils/skills.js";
import { InstallerError, validateDirectory } from "../utils/validation.js";

export interface InstallOptions {
  dryRun: boolean;
  force: boolean;
  /** Override package root for inventory/source discovery (tests). */
  packageRoot?: string;
}

export interface InstallSkillAction {
  name: string;
  status: "missing" | "up-to-date" | "modified";
  action:
    | "would-install"
    | "would-replace"
    | "installed"
    | "replaced"
    | "unchanged"
    | "blocked"
    | "failed";
  /** Copy-operation failure detail, present only when action is "failed". */
  error?: string;
}

export interface InstallResult {
  target: string;
  dryRun: boolean;
  force: boolean;
  ok: boolean;
  skills: InstallSkillAction[];
}

/** Error thrown when installation operation fails (exit 1). */
export class InstallError extends InstallerError {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** Error thrown when installation preflight validation fails (fatal exit 1). */
export class InstallValidationError extends InstallError {
  constructor(message: string) {
    super(message);
    this.name = "InstallValidationError";
  }
}

/**
 * Confirm the target's parent directory exists, is a directory, and is
 * writable. Run unconditionally (including dry-run and empty plans) so a
 * typo'd or unmounted target path fails fast instead of silently
 * materializing an arbitrary directory chain.
 */
async function validateTargetParent(targetRoot: string): Promise<void> {
  await validateDirectory({
    path: dirname(targetRoot),
    checkWritable: true,
    errorClass: InstallValidationError,
    baseErrorClass: InstallError,
  });
}

/**
 * Plan the installation actions based on inventory and options.
 */
function planInstall(
  inventory: SkillsInventory,
  options: InstallOptions,
): InstallSkillAction[] {
  const actions: InstallSkillAction[] = [];

  for (const skill of inventory.skills) {
    if (skill.status === "up-to-date" && !options.force) {
      actions.push({
        name: skill.name,
        status: skill.status,
        action: "unchanged",
      });
      continue;
    }
    if (skill.status === "modified" && !options.force) {
      actions.push({
        name: skill.name,
        status: skill.status,
        action: "blocked",
      });
      continue;
    }
    // missing, or up-to-date/modified with --force
    const action = options.dryRun
      ? skill.status === "missing"
        ? "would-install"
        : "would-replace"
      : skill.status === "missing"
        ? "installed"
        : "replaced";
    actions.push({ name: skill.name, status: skill.status, action });
  }

  return actions;
}

/**
 * Compute inventory, converting skill errors to installation errors.
 */
async function computeInventory(
  targetRoot: string,
  packageRoot: string,
): Promise<SkillsInventory> {
  try {
    return computeSkillsInventory(targetRoot, { packageRoot });
  } catch (error) {
    if (error instanceof SkillSourceError) {
      throw new InstallError(`Source error: ${error.message}`);
    }
    if (error instanceof SkillTargetError) {
      // Convert validation failures to InstallValidationError.
      // ENOTDIR → clean "is not a directory" message for the parent.
      // Other validation signals (not a directory, symlink, no write)
      // are forwarded as-is with a prefix.
      const message = error.message;
      if (message.includes("ENOTDIR")) {
        throw new InstallValidationError(
          `Target parent '${dirname(targetRoot)}' is not a directory`,
        );
      }
      if (
        message.includes("not a directory") ||
        message.includes("is a symlink") ||
        message.includes("No write access")
      ) {
        throw new InstallValidationError(`Target error: ${message}`);
      }
      throw new InstallError(`Target error: ${message}`);
    }
    throw new InstallError(`Inventory failed: ${errorMessage(error)}`);
  }
}

/**
 * Preflight target root before inventory computation.
 * Rejects existing non-directory and non-writable-directory roots with
 * InstallValidationError. Symlink rejection is deferred to inventory safety
 * checks.
 */
async function validateTargetRootDirectory(targetRoot: string): Promise<void> {
  let targetStat: Stats | undefined;
  try {
    targetStat = await lstat(targetRoot);
  } catch (error) {
    if (isEnoent(error)) {
      // Absent root — defer to parent validation later
      return;
    }
    throw new InstallValidationError(
      `Failed to inspect target root '${targetRoot}': ${errorMessage(error)}`,
    );
  }

  // Symlink rejection deferred to inventory safety checks
  if (targetStat.isSymbolicLink()) {
    return;
  }

  if (!targetStat.isDirectory()) {
    throw new InstallValidationError(
      `Target root '${targetRoot}' is not a directory`,
    );
  }

  try {
    await access(targetRoot, constants.W_OK);
  } catch {
    throw new InstallValidationError(
      `No write access to target root '${targetRoot}'`,
    );
  }
}

/**
 * Install bundled skills into target directory.
 */
export async function installSkills(
  targetRoot: string,
  options: InstallOptions,
): Promise<InstallResult> {
  const absoluteTargetRoot = resolve(targetRoot);
  const packageRoot = options.packageRoot ?? findPackageRoot(import.meta.dir);

  // Preflight target root — reject existing non-directory and non-writable roots
  // before inventory computation. Symlink rejection deferred to inventory safety
  // checks.
  await validateTargetRootDirectory(absoluteTargetRoot);

  const inventory = await computeInventory(absoluteTargetRoot, packageRoot);
  const actions = planInstall(inventory, options);

  // Block entire request when any modified target lacks force (including dry-run).
  if (actions.some((a) => a.action === "blocked")) {
    return {
      target: absoluteTargetRoot,
      dryRun: options.dryRun,
      force: options.force,
      ok: false,
      skills: actions,
    };
  }

  // Always preflight the target parent — including dry-run, empty
  // inventories, and fully unchanged plans.
  await validateTargetParent(absoluteTargetRoot);

  // If dry-run, return plan without executing.
  if (options.dryRun) {
    return {
      target: absoluteTargetRoot,
      dryRun: true,
      force: options.force,
      ok: true,
      skills: actions,
    };
  }

  const sourceByName = new Map(
    inventory.skills.flatMap((s) => (s.source ? [[s.name, s.source]] : [])),
  );
  const toInstall = actions.filter((a) =>
    ["installed", "replaced"].includes(a.action),
  );

  if (toInstall.length === 0) {
    return {
      target: absoluteTargetRoot,
      dryRun: false,
      force: options.force,
      ok: true,
      skills: actions,
    };
  }

  try {
    await mkdir(absoluteTargetRoot, { recursive: true });
  } catch (error) {
    throw new InstallError(
      `Failed to create target '${absoluteTargetRoot}': ${errorMessage(error)}`,
    );
  }

  let ok = true;
  for (const entry of toInstall) {
    const source = sourceByName.get(entry.name);
    if (!source) continue;
    const destPath = join(absoluteTargetRoot, entry.name);
    try {
      // Remove any existing directory first so a replace mirrors the
      // bundle exactly, instead of merging and leaving target-only
      // files the bundle no longer ships.
      if (entry.status !== "missing") {
        await rm(destPath, { recursive: true, force: true });
      }
      await cp(source.sourcePath, destPath, { recursive: true });
    } catch (error) {
      entry.action = "failed";
      entry.error = errorMessage(error);
      ok = false;
    }
  }

  return {
    target: absoluteTargetRoot,
    dryRun: false,
    force: options.force,
    ok,
    skills: actions,
  };
}
