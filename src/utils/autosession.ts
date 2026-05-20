import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Duration in milliseconds before an unaccessed session expires (4 hours). */
export const AUTOSESSION_TTL_MS = 4 * 60 * 60 * 1000;

/** Persistent session record stored per working directory. */
export interface AutosessionRecord {
  /** Unique session identifier (UUID v4). */
  id: string;
  /** ISO-8601 timestamp when the session was first created. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent access; used for TTL expiry. */
  lastAccessedAt: string;
}

/**
 * Returns the vibe-cli data root directory (`~/.vibe-cli`).
 *
 * Uses `$HOME` when set, falling back to `os.homedir()`.
 */
export function getDataRoot(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".vibe-cli");
}

/** Creates the data root directory if it does not already exist. */
export function ensureDataDir(): void {
  const dataDir = getDataRoot();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

/** Returns the directory where session JSON files are stored (`~/.vibe-cli/sessions`). */
export function getAutosessionDir(): string {
  return path.join(getDataRoot(), "sessions");
}

/**
 * Derives a deterministic, truncated SHA-256 key from a working directory path.
 *
 * @param cwd - Absolute path to hash (defaults to `process.cwd()`).
 * @returns 12-character hex string used as the session filename.
 */
export function getCwdKey(cwd = process.cwd()): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function getRecordPath(cwd = process.cwd()): string {
  return path.join(getAutosessionDir(), `${getCwdKey(cwd)}.json`);
}

function isValidRecord(value: unknown): value is AutosessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AutosessionRecord>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.createdAt === "string" &&
    !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.lastAccessedAt === "string" &&
    !Number.isNaN(Date.parse(record.lastAccessedAt))
  );
}

function isExpired(record: AutosessionRecord, now: number): boolean {
  return now - Date.parse(record.lastAccessedAt) >= AUTOSESSION_TTL_MS;
}

function createRecord(now: Date): AutosessionRecord {
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    createdAt: timestamp,
    lastAccessedAt: timestamp,
  };
}

function readRecord(filePath: string): AutosessionRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isValidRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeRecord(filePath: string, record: AutosessionRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  } catch {}
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
}

/**
 * Resolves the autosession for the given working directory.
 *
 * Returns the existing session if it has not expired (within
 * {@link AUTOSESSION_TTL_MS}), updating its `lastAccessedAt` timestamp.
 * Otherwise creates and persists a new session with a fresh UUID.
 *
 * @param cwd - Working directory to resolve against (defaults to `process.cwd()`).
 * @returns The active {@link AutosessionRecord}.
 */
export function resolveAutosession(cwd = process.cwd()): AutosessionRecord {
  const filePath = getRecordPath(cwd);
  const now = new Date();
  const existing = readRecord(filePath);

  if (existing && !isExpired(existing, now.getTime())) {
    const touched = { ...existing, lastAccessedAt: now.toISOString() };
    writeRecord(filePath, touched);
    return touched;
  }

  const record = createRecord(now);
  writeRecord(filePath, record);
  return record;
}
