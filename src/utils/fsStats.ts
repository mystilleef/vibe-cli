/**
 * ENOENT-tolerant stat probes shared by backup mechanics
 * (`databaseBackup.ts`) and doctor storage guards (`doctorStorage.ts`):
 * an absent target reports `null` so callers classify absence, while every
 * other fault surfaces unchanged.
 */

import type { Stats } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { isEnoent } from "./errors.js";

async function statOrMissingWith(
  probe: (target: string) => Promise<Stats>,
  target: string,
): Promise<Stats | null> {
  try {
    return await probe(target);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/** `stat` a target, reporting `null` when it does not exist. */
export function statOrMissing(target: string): Promise<Stats | null> {
  return statOrMissingWith(stat, target);
}

/** `lstat` a target, reporting `null` when it does not exist. */
export function lstatOrMissing(target: string): Promise<Stats | null> {
  return statOrMissingWith(lstat, target);
}
