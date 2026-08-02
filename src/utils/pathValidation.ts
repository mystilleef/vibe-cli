import { join, parse, sep } from "node:path";

/**
 * Return all absolute path prefixes from root down to `absPath`.
 */
export function getPathAncestorsAndSelf(absPath: string): string[] {
  const { root } = parse(absPath);
  const relative = absPath.slice(root.length);
  if (!relative) return [root];

  const segments = relative.split(sep).filter(Boolean);
  const paths: string[] = [];
  let current = root;

  for (const seg of segments) {
    current = join(current, seg);
    paths.push(current);
  }
  return paths;
}

/** Options for rejectSymlinkPathComponents. */
export interface RejectSymlinkOptions {
  destPath: string;
  targetRoot: string;
  errorClass: new (message: string) => Error;
  formatError?: (
    component: string,
    targetRoot: string,
    error: unknown,
  ) => string;
}

/**
 * Throw if a path component is a symlink.
 */
export function throwIfSymlink(
  component: string,
  isSymbolicLink: boolean,
  options: Pick<RejectSymlinkOptions, "destPath" | "targetRoot" | "errorClass">,
): void {
  if (!isSymbolicLink) return;
  const { destPath, targetRoot, errorClass } = options;
  if (component === destPath) {
    throw new errorClass(`Destination is a symlink: ${destPath}`);
  }
  if (component === targetRoot) {
    throw new errorClass(`Target directory is a symlink: ${targetRoot}`);
  }
  throw new errorClass(
    `Target directory component '${component}' is a symlink`,
  );
}

/**
 * Handle stat errors during symlink validation.
 * @returns `true` if caller should break (ENOENT/ENOTDIR).
 * @throws On non-recoverable errors.
 */
export function handleSymlinkStatError(
  error: unknown,
  component: string,
  options: RejectSymlinkOptions,
): boolean {
  const { destPath, targetRoot, errorClass, formatError } = options;
  if (error instanceof errorClass) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return true;
  }
  if (formatError) {
    throw new errorClass(formatError(component, targetRoot, error));
  }
  if (component === targetRoot) {
    throw new errorClass(`Failed to stat target directory: ${targetRoot}`);
  }
  if (component === destPath) {
    throw new errorClass(`Failed to stat guide destination: ${destPath}`);
  }
  throw new errorClass(`Failed to stat target path '${component}'`);
}

/**
 * Validate that no path component from root to `destPath` is a symlink.
 * Stops at the first ENOENT/ENOTDIR component.
 *
 * @param pathComponents - Path components to validate (root → destPath).
 * @param statFn - `lstatSync` or async `lstat`.
 * @param options - Dest path, target root, error class, optional formatter.
 * @throws When a symlink or stat failure is detected.
 */
export async function rejectSymlinkPathComponents(
  pathComponents: string[],
  statFn: (component: string) => Promise<{ isSymbolicLink(): boolean }>,
  options: RejectSymlinkOptions,
): Promise<void> {
  for (const component of pathComponents) {
    try {
      const stats = await statFn(component);
      throwIfSymlink(component, stats.isSymbolicLink(), options);
    } catch (error) {
      if (handleSymlinkStatError(error, component, options)) break;
    }
  }
}

/**
 * Validate that no path component from root to `destPath` is a symlink (sync version).
 * Stops at the first ENOENT/ENOTDIR component.
 *
 * @param pathComponents - Path components to validate (root → destPath).
 * @param statFn - `lstatSync`.
 * @param options - Dest path, target root, error class, optional formatter.
 * @throws When a symlink or stat failure is detected.
 */
export function rejectSymlinkPathComponentsSync(
  pathComponents: string[],
  statFn: (component: string) => { isSymbolicLink(): boolean },
  options: RejectSymlinkOptions,
): void {
  for (const component of pathComponents) {
    try {
      const stats = statFn(component);
      throwIfSymlink(component, stats.isSymbolicLink(), options);
    } catch (error) {
      if (handleSymlinkStatError(error, component, options)) break;
    }
  }
}
