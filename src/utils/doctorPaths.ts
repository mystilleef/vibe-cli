/**
 * Recorded-path safety contract: containment by path segments, role suffix
 * shape, and component checks shared by diagnostics classification
 * (`doctorStorage.ts`) and purge revalidation (`doctorMaintenance.ts`) so
 * collection and removal enforce one policy.
 *
 * `rejected` messages name the role so classification and purge report
 * identical wording; `error` carries operational faults for callers to
 * fail on. Purge revalidation runs these checks immediately before unlink
 * so any supplied finding stays safe to delete.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { extractErrorMessage, isEnoent } from "./errors.js";
import { getPathAncestorsAndSelf } from "./pathValidation.js";

const LEGACY_BACKUP_SUFFIX_PATTERN = /\.bak$/;

/** Rejection subject and suffix policy for one recorded path role. */
export interface RecordedPathRole {
  subject: string;
  requireBakSuffix: boolean;
}

export const BACKUP_PATH_ROLE: RecordedPathRole = {
  subject: "recorded backup path",
  requireBakSuffix: true,
};

export const ARTIFACT_PATH_ROLE: RecordedPathRole = {
  subject: "artifact path",
  requireBakSuffix: false,
};

/** Outcome of validating one recorded path against the data root. */
export type RecordedPathVerdict =
  | { status: "safe" }
  | { status: "missing" }
  | { status: "rejected"; message: string }
  | { status: "error"; message: string };

export type PathCheck =
  | { status: "safe"; isFile: boolean }
  | { status: "missing" }
  | { status: "unsafe"; message: string }
  | { status: "error"; message: string };

/**
 * Shared safety validation for recorded paths: containment by path segments
 * (never string prefixes), role suffix shape, non-symlink components strictly
 * below the data root, and a regular-file leaf. `rejected` messages name the
 * role so classification and purge report identical wording; `error` carries
 * operational faults for the inventory to fail on. Purge revalidation runs
 * these same checks right before unlink so any supplied finding stays safe
 * to delete.
 */
export async function verifyRecordedPath(
  resolved: string,
  dataRoot: string,
  role: RecordedPathRole,
): Promise<RecordedPathVerdict> {
  if (!isWithinRoot(resolved, dataRoot)) {
    return {
      status: "rejected",
      message: `${role.subject} escapes the data root`,
    };
  }
  if (role.requireBakSuffix && !LEGACY_BACKUP_SUFFIX_PATTERN.test(resolved)) {
    return {
      status: "rejected",
      message: `${role.subject} does not have a .bak suffix`,
    };
  }
  const check = await checkContainedPath(resolved, dataRoot);
  if (check.status === "error") {
    return { status: "error", message: check.message };
  }
  if (check.status === "unsafe") {
    return { status: "rejected", message: check.message };
  }
  if (check.status === "missing") return { status: "missing" };
  return check.isFile
    ? { status: "safe" }
    : { status: "rejected", message: `${role.subject} is not a regular file` };
}

/**
 * Validate containment by path segments (never string prefixes) and walk
 * components strictly below the data root for symlinks and non-directory
 * ancestors before any recorded path is traversed.
 */
export async function checkContainedPath(
  resolved: string,
  dataRoot: string,
): Promise<PathCheck> {
  const components = getPathAncestorsAndSelf(resolved).filter(
    (component) => component !== dataRoot && isWithinRoot(component, dataRoot),
  );
  let isFile = false;
  for (const component of components) {
    try {
      const stats = await lstat(component);
      if (stats.isSymbolicLink()) {
        return {
          status: "unsafe",
          message: `path component is a symlink: ${component}`,
        };
      }
      if (component === resolved) {
        isFile = stats.isFile();
        continue;
      }
      if (!stats.isDirectory()) {
        return {
          status: "unsafe",
          message: `path component is not a directory: ${component}`,
        };
      }
    } catch (error) {
      if (isEnoent(error)) return { status: "missing" };
      return { status: "error", message: extractErrorMessage(error) };
    }
  }
  return { status: "safe", isFile };
}

export function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
