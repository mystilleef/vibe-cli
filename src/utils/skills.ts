import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { findPackageRoot } from "./packageRoot.js";
import { expandTildePath, getSafeHomedir } from "./paths.js";

export interface SkillFile {
  relativePath: string;
  hash: string;
  size: number;
}

export interface SkillSource {
  name: string;
  sourcePath: string;
  hash: string;
  files: SkillFile[];
}

export interface SkillTarget {
  name: string;
  targetPath: string;
  hash: string;
  files: SkillFile[];
}

export type InventoryStatus = "missing" | "up-to-date" | "modified";

export interface SkillInventoryEntry {
  name: string;
  status: InventoryStatus;
  source?: SkillSource;
  target?: SkillTarget;
}

export interface SkillsInventory {
  targetRoot: string;
  skills: SkillInventoryEntry[];
}

export interface DiscoverOptions {
  packageRoot?: string;
}

export interface InventoryOptions {
  packageRoot?: string;
}

/** Error thrown when a skill source directory is invalid or unsafe. */
export class SkillSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillSourceError";
  }
}

/** Error thrown when a skill target directory is invalid or unsafe. */
export class SkillTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillTargetError";
  }
}

type TreeErrorCtor = typeof SkillSourceError | typeof SkillTargetError;

/**
 * Encode a non-negative integer as a big-endian uint32 length prefix.
 */
function encodeLength(length: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(length);
  return buf;
}

/**
 * Compute SHA-256 hash of raw bytes (no text normalization).
 */
export function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA-256 hash of a file's raw bytes (no text normalization).
 */
function hashFile(filePath: string): string {
  return hashContent(readFileSync(filePath));
}

/**
 * Compute a path-sensitive combined SHA-256 over lexically sorted relative
 * paths and each file's raw content hash. Length-delimited fields prevent
 * path-only renames from colliding when content bytes match.
 */
function computeSkillHash(files: SkillFile[]): string {
  const combined = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    combined.update(encodeLength(pathBytes.length));
    combined.update(pathBytes);
    const hashBytes = Buffer.from(file.hash, "utf8");
    combined.update(encodeLength(hashBytes.length));
    combined.update(hashBytes);
  }
  return combined.digest("hex");
}

function assertEntryType(
  path: string,
  ErrorType: TreeErrorCtor,
  label: string,
  expected: "directory" | "file",
): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new ErrorType(`Failed to stat ${label} ${path}: ${error}`);
  }
  if (stats.isSymbolicLink()) {
    throw new ErrorType(`${label} is a symlink`);
  }
  const isExpected =
    expected === "directory" ? stats.isDirectory() : stats.isFile();
  if (!isExpected) {
    throw new ErrorType(`${label} is not a regular ${expected}`);
  }
  return stats;
}

/**
 * Walk a skill directory and collect all regular files in lexical order.
 * Rejects nested symlinks and non-regular entries (fail-closed).
 */
function walkSkillDirectory(skillPath: string, isSource: boolean): SkillFile[] {
  const ErrorType = isSource ? SkillSourceError : SkillTargetError;
  const files: SkillFile[] = [];
  const rootReal = realpathSync(skillPath);

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch (error) {
      throw new ErrorType(`Failed to read directory ${dir}: ${error}`);
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stats: Stats;
      try {
        stats = lstatSync(fullPath);
      } catch (error) {
        throw new ErrorType(`Failed to stat ${fullPath}: ${error}`);
      }

      const entryLabel = `${isSource ? "Source" : "Target"} skill entry: ${relative(skillPath, fullPath) || entry}`;

      if (stats.isDirectory()) {
        if (stats.isSymbolicLink()) {
          throw new ErrorType(`${entryLabel} is a symlink`);
        }
        // Ensure the directory stays inside the skill root (no mount escapes).
        let dirReal: string;
        try {
          dirReal = realpathSync(fullPath);
        } catch (error) {
          throw new ErrorType(`Failed to resolve ${fullPath}: ${error}`);
        }
        const relToRoot = relative(rootReal, dirReal);
        if (
          relToRoot === ".." ||
          relToRoot.startsWith(`..${sep}`) ||
          join(rootReal, relToRoot) !== dirReal
        ) {
          throw new ErrorType(`${entryLabel} escapes skill root`);
        }
        walk(fullPath);
        continue;
      }

      if (stats.isSymbolicLink()) {
        throw new ErrorType(`${entryLabel} is a symlink`);
      }
      if (!stats.isFile()) {
        throw new ErrorType(`${entryLabel} is not a regular file`);
      }

      let hash: string;
      try {
        hash = hashFile(fullPath);
      } catch (error) {
        throw new ErrorType(`Failed to read file ${fullPath}: ${error}`);
      }

      const relPath = relative(skillPath, fullPath);
      files.push({
        relativePath: relPath,
        hash,
        size: stats.size,
      });
    }
  }

  walk(skillPath);
  return files;
}

/**
 * Discover bundled skills from the package's skills/ directory.
 * Returns skills in lexical order by name.
 * Throws SkillSourceError for missing, unreadable, malformed, or unsafe
 * source trees (including any nested symlink).
 */
export function discoverBundledSkills(
  options: DiscoverOptions = {},
): SkillSource[] {
  const packageRoot = options.packageRoot ?? findPackageRoot(import.meta.dir);
  const skillsDir = join(packageRoot, "skills");

  if (!existsSync(skillsDir)) {
    throw new SkillSourceError(`Skills directory does not exist: ${skillsDir}`);
  }

  assertEntryType(skillsDir, SkillSourceError, "Skills directory", "directory");

  let entries: string[];
  try {
    entries = readdirSync(skillsDir).sort();
  } catch (error) {
    throw new SkillSourceError(`Failed to read skills directory: ${error}`);
  }

  const skills: SkillSource[] = [];

  for (const entry of entries) {
    const skillPath = join(skillsDir, entry);

    let stats: Stats;
    try {
      stats = lstatSync(skillPath);
    } catch (error) {
      throw new SkillSourceError(`Failed to stat ${skillPath}: ${error}`);
    }

    // Reject top-level skill-directory symlinks.
    if (stats.isSymbolicLink()) {
      throw new SkillSourceError(`Skill directory '${entry}' is a symlink`);
    }

    // Top-level non-directories (metadata files) stay outside inventory.
    if (!stats.isDirectory()) {
      continue;
    }

    const skillMdPath = join(skillPath, "SKILL.md");
    let skillMdStats: Stats;
    try {
      skillMdStats = lstatSync(skillMdPath);
    } catch (error) {
      throw new SkillSourceError(
        `Skill '${entry}' SKILL.md not accessible: ${error}`,
      );
    }

    if (skillMdStats.isSymbolicLink()) {
      throw new SkillSourceError(`Skill '${entry}' has symlinked SKILL.md`);
    }

    if (!skillMdStats.isFile()) {
      throw new SkillSourceError(
        `Skill '${entry}' SKILL.md is not a regular file`,
      );
    }

    const files = walkSkillDirectory(skillPath, true);

    if (!files.some((f) => f.relativePath === "SKILL.md")) {
      throw new SkillSourceError(
        `Skill '${entry}' SKILL.md missing after tree walk`,
      );
    }

    const hash = computeSkillHash(files);

    skills.push({
      name: entry,
      sourcePath: skillPath,
      hash,
      files,
    });
  }

  return skills;
}

/**
 * Read a skill from the target directory.
 * Returns null if the skill directory doesn't exist.
 * Throws SkillTargetError for unsafe target trees (symlinks, unreadable files).
 */
export function readSkillTarget(
  name: string,
  targetRoot: string,
): SkillTarget | null {
  const targetPath = join(targetRoot, name);

  let stats: Stats;
  try {
    stats = lstatSync(targetPath);
  } catch (error: unknown) {
    // Only ENOENT (confirmed absence) returns null.
    // All other errors (EACCES, EIO, etc.) are unsafe—fail closed.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new SkillTargetError(
      `Failed to stat target '${name}' at ${targetPath}: ${error}`,
    );
  }

  if (stats.isSymbolicLink()) {
    throw new SkillTargetError(`Target skill directory '${name}' is a symlink`);
  }

  if (!stats.isDirectory()) {
    throw new SkillTargetError(`Target '${name}' is not a directory`);
  }

  const files = walkSkillDirectory(targetPath, false);

  if (!files.some((f) => f.relativePath === "SKILL.md")) {
    throw new SkillTargetError(`Target skill '${name}' missing SKILL.md`);
  }

  const hash = computeSkillHash(files);

  return {
    name,
    targetPath,
    hash,
    files,
  };
}

/**
 * Validate that a root path is safe to read through:
 * - Not a symlink (lstat no-follow)
 * - Is a real directory (lstat no-follow)
 * - Existing directory is directly enumerable (readdir via fault seam)
 *
 * Confirmed absence (`ENOENT` on lstat) retains read-only missing-root
 * semantics without creating paths. Every other root-access error fails closed.
 */
function assertSafeRoot(
  rootPath: string,
  ErrorType: TreeErrorCtor,
  label: string,
): void {
  let stats: Stats;
  try {
    stats = lstatSync(rootPath);
  } catch (error: unknown) {
    // Only ENOENT (confirmed absence) gets absent-root read-only semantics.
    // All other errors (EACCES, EIO, etc.) are unsafe—fail closed.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw new ErrorType(`Failed to stat ${label} ${rootPath}: ${error}`);
  }

  if (stats.isSymbolicLink()) {
    throw new ErrorType(`${label} is a symlink: ${rootPath}`);
  }
  if (!stats.isDirectory()) {
    throw new ErrorType(`${label} is not a directory: ${rootPath}`);
  }

  // Direct root enumeration after type checks, before source discovery or
  // target traversal. Any readdir failure fails closed (absence is lstat ENOENT).
  try {
    readdirSync(rootPath);
  } catch (error: unknown) {
    throw new ErrorType(`Failed to read ${label} ${rootPath}: ${error}`);
  }
}

/**
 * Compute the inventory of skills comparing bundled sources to installed targets.
 * Throws on unsafe source or target trees. Never creates paths.
 */
export function computeSkillsInventory(
  targetRoot: string,
  options: InventoryOptions = {},
): SkillsInventory {
  const absoluteTargetRoot = resolve(targetRoot);

  assertSafeRoot(absoluteTargetRoot, SkillTargetError, "Target root");

  const sources = discoverBundledSkills(options);
  const skills: SkillInventoryEntry[] = [];

  for (const source of sources) {
    const target = readSkillTarget(source.name, absoluteTargetRoot);

    if (!target) {
      skills.push({
        name: source.name,
        status: "missing",
        source,
      });
    } else if (source.hash === target.hash) {
      skills.push({
        name: source.name,
        status: "up-to-date",
        source,
        target,
      });
    } else {
      skills.push({
        name: source.name,
        status: "modified",
        source,
        target,
      });
    }
  }

  return {
    targetRoot: absoluteTargetRoot,
    skills,
  };
}

/**
 * Resolve the default target root: `~/.agents/skills`.
 * Expands `~` to the user's home directory.
 */
export function resolveDefaultTargetRoot(): string {
  return join(getSafeHomedir(), ".agents", "skills");
}

/**
 * Resolve a target root path, expanding `~` to home directory and resolving
 * to an absolute path. Accepts default, tilde, relative, and absolute inputs.
 */
export function resolveTargetRoot(target?: string): string {
  if (!target) {
    return resolveDefaultTargetRoot();
  }
  return expandTildePath(target);
}
