/**
 * In-memory interaction history persisted to `history.json` in the
 * data-root directory.  Each session accumulates up to 10 recent
 * interactions; older entries are evicted FIFO on append.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { VibeCheckInput } from "../tools/vibeCheck.js";
import { getDataRoot } from "./autosession.js";

function getHistoryFile(): string {
  return path.join(getDataRoot(), "history.json");
}

interface Interaction {
  input: VibeCheckInput;
  output: string;
  /** Epoch-ms when recorded. */
  timestamp: number;
}

let history: Map<string, Interaction[]> = new Map();

async function ensureDataDir() {
  try {
    await fs.mkdir(getDataRoot(), { recursive: true });
  } catch {}
}

/**
 * Load history from disk into memory.  Safe to call multiple times—
 * replaces the in-memory map each call.  Starts fresh when the file
 * is missing or corrupt.
 */
export async function loadHistory() {
  await ensureDataDir();
  try {
    const data = await fs.readFile(getHistoryFile(), "utf-8");
    const parsed = JSON.parse(data);
    history = new Map(
      Object.entries(parsed).map(([k, v]) => [k, v as Interaction[]]),
    );
  } catch {
    history = new Map();
  }
}

async function saveHistory() {
  await ensureDataDir();
  const data = Object.fromEntries(history);
  await fs.writeFile(getHistoryFile(), JSON.stringify(data));
}

/**
 * Return a truncated summary of the last 5 interactions for
 * `sessionId`, or empty string when none exist.  Intended for
 * injecting recent context into LLM prompts.
 */
export function getHistorySummary(sessionId = "default"): string {
  const sessHistory = history.get(sessionId) || [];
  if (!sessHistory.length) return "";
  const summary = sessHistory
    .slice(-5)
    .map(
      (int, i) =>
        `Interaction ${i + 1}: Goal ${int.input.goal}, Guidance: ${int.output.slice(0, 100)}...`,
    )
    .join("\n");
  return `History Context:\n${summary}\n`;
}

/**
 * Drop all history for `sessionId` and persist.  No-op if the
 * session does not exist.
 */
export async function clearSession(sessionId: string): Promise<void> {
  history.delete(sessionId);
  await saveHistory();
}

/**
 * Append an interaction to `sessionId`'s history and persist.
 * Caps the buffer at 10 entries (oldest dropped first).
 */
export async function addToHistory(
  sessionId: string,
  input: VibeCheckInput,
  output: string,
) {
  const sessHistory = history.get(sessionId) ?? [];
  history.set(sessionId, sessHistory);
  sessHistory.push({ input, output, timestamp: Date.now() });
  if (sessHistory.length > 10) sessHistory.shift();
  await saveHistory();
}
