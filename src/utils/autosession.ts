import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUTOSESSION_TTL_MS = 4 * 60 * 60 * 1000;

export interface AutosessionRecord {
  id: string;
  createdAt: string;
  lastAccessedAt: string;
}

export function getDataRoot(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".vibe-cli");
}

export function ensureDataDir(): void {
  const dataDir = getDataRoot();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

export function getAutosessionDir(): string {
  return path.join(getDataRoot(), "sessions");
}

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
