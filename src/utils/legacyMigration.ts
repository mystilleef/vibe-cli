import fs from "node:fs";
import path from "node:path";
import { getDataRoot } from "./db-core.js";

export const LEGACY_LEARNING_LOG = "vibe-log.json";
export const LEGACY_CONSTITUTION = "constitution.json";
export const LEGACY_HISTORY = "history.json";

export function getLegacyAutosessionDir(): string {
  return path.join(getDataRoot(), "sessions");
}

export function getLegacyArtifactPath(filename: string): string {
  return path.join(getDataRoot(), filename);
}

export function readLegacyJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export function backupLegacyPath(filePath: string): string {
  let candidate = `${filePath}.bak`;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${filePath}.${index}.bak`;
    index += 1;
  }
  fs.renameSync(filePath, candidate);
  return candidate;
}
