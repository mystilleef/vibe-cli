/**
 * Shared test utilities for skills-related tests.
 *
 * Provides temp directory lifecycle management, skill directory creation,
 * and filesystem inspection helpers used across multiple test files.
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ── Temp directory lifecycle ────────────────────────────────────────────────

/**
 * Create a temporary directory and track it for cleanup.
 *
 * @param tracking - Array that accumulates created dirs for afterEach cleanup.
 * @param prefix   - mkdtemp prefix (default: "vibe-skills-").
 */
export async function createTempDir(
  tracking: string[],
  prefix = "vibe-skills-",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tracking.push(dir);
  return dir;
}

/**
 * Remove all tracked temp directories. Call from `afterEach`.
 */
export async function cleanupTempDirs(dirs: string[]): Promise<void> {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

// ── Skill directory creation ────────────────────────────────────────────────

/**
 * Create a skill directory with the given files.
 * Intermediate directories are created as needed.
 */
export async function createSkillDir(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const skillDir = join(root, name);
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(skillDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  return skillDir;
}

/**
 * Create a package root with `package.json` and a `skills/` directory.
 * Optionally pre-populate skills.
 */
export async function createPackageRoot(
  tracking: string[],
  skills: Record<string, Record<string, string>> = {},
): Promise<string> {
  const root = await createTempDir(tracking, "vibe-pkg-");
  await writeFile(join(root, "package.json"), '{"name":"test-package"}');
  const skillsDir = join(root, "skills");
  await mkdir(skillsDir, { recursive: true });
  for (const [name, files] of Object.entries(skills)) {
    await createSkillDir(skillsDir, name, files);
  }
  return root;
}

// ── Filesystem inspection helpers ───────────────────────────────────────────

/** Check whether a path is an existing directory. */
export async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Check whether a path is an existing regular file. */
export async function fileExists(file: string): Promise<boolean> {
  try {
    const s = await stat(file);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively read a directory tree, returning a map of
 * relative-path → content for every regular file.
 */
export async function readDirTree(
  dir: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(d: string, base: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(d, entry.name);
      const relPath = join(base, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        result[relPath] = await readFile(fullPath, "utf8");
      }
    }
  }
  await walk(dir, "");
  return result;
}
