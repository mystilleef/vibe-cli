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
  timestamp: number;
}

let history: Map<string, Interaction[]> = new Map();

async function ensureDataDir() {
  try {
    await fs.mkdir(getDataRoot(), { recursive: true });
  } catch {}
}

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

export async function clearSession(sessionId: string): Promise<void> {
  history.delete(sessionId);
  await saveHistory();
}

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
