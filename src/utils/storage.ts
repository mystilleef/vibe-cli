import fs from "node:fs";
import path from "node:path";
import { ensureDataDir, getDataRoot } from "./autosession.js";

function getLogFile(): string {
  return path.join(getDataRoot(), "vibe-log.json");
}

export type LearningType = "mistake" | "preference" | "success";

export interface LearningEntry {
  type: LearningType;
  category: string;
  mistake: string;
  solution?: string;
  timestamp: number;
  demoId?: string;
}

interface VibeLog {
  mistakes: Record<
    string,
    { count: number; examples: LearningEntry[]; lastUpdated: number }
  >;
  lastUpdated: number;
}

function freshLog(): VibeLog {
  return { mistakes: {}, lastUpdated: Date.now() };
}

function readLogFile(): VibeLog {
  ensureDataDir();
  const logFile = getLogFile();
  if (!fs.existsSync(logFile)) {
    const log = freshLog();
    writeLogFile(log);
    return log;
  }
  try {
    return JSON.parse(fs.readFileSync(logFile, "utf8")) as VibeLog;
  } catch {
    return freshLog();
  }
}

function writeLogFile(data: VibeLog): void {
  ensureDataDir();
  try {
    fs.writeFileSync(getLogFile(), JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing vibe log:", error);
  }
}

export function addLearningEntry(
  mistake: string,
  category: string,
  solution?: string,
  type: LearningType = "mistake",
  demoId?: string,
): LearningEntry {
  const log = readLogFile();
  const now = Date.now();
  const entry: LearningEntry = {
    type,
    category,
    mistake,
    ...(solution !== undefined && { solution }),
    timestamp: now,
    ...(demoId !== undefined && { demoId }),
  };

  if (!log.mistakes[category]) {
    log.mistakes[category] = { count: 0, examples: [], lastUpdated: now };
  }
  log.mistakes[category].count += 1;
  log.mistakes[category].examples.push(entry);
  log.mistakes[category].lastUpdated = now;
  log.lastUpdated = now;
  writeLogFile(log);
  return entry;
}

export function getLearningEntries(): Record<string, LearningEntry[]> {
  const log = readLogFile();
  return Object.fromEntries(
    Object.entries(log.mistakes).map(([cat, data]) => [cat, data.examples]),
  );
}

export function getLearningCategorySummary(): Array<{
  category: string;
  count: number;
  recentExample: LearningEntry;
}> {
  const log = readLogFile();
  return Object.entries(log.mistakes)
    .flatMap(([category, data]) => {
      const recentExample = data.examples.at(-1);
      return recentExample === undefined
        ? []
        : [
            {
              category,
              count: data.count,
              recentExample,
            },
          ];
    })
    .sort((a, b) => b.count - a.count);
}

function rewriteLearningLog(
  filterEntry: (entry: LearningEntry) => boolean,
): void {
  const log = readLogFile();
  for (const cat of Object.keys(log.mistakes)) {
    const data = log.mistakes[cat];
    if (!data) continue;
    data.examples = data.examples.filter(filterEntry);
    if (data.examples.length === 0) {
      delete log.mistakes[cat];
    } else {
      data.count = data.examples.length;
      data.lastUpdated = Math.max(...data.examples.map((e) => e.timestamp));
    }
  }
  log.lastUpdated = Date.now();
  writeLogFile(log);
}

export function removeLearningEntriesAfter(timestamp: number): void {
  rewriteLearningLog((entry) => entry.timestamp < timestamp);
}

export function removeLearningEntriesForDemo(demoId: string): void {
  rewriteLearningLog((entry) => entry.demoId !== demoId);
}

export function getLearningContextText(maxPerCategory = 5): string {
  const log = readLogFile();
  return Object.entries(log.mistakes)
    .map(([category, data]) => {
      const examples = [...data.examples]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-maxPerCategory)
        .map((ex) => {
          const label =
            ex.type === "mistake"
              ? "Mistake"
              : ex.type === "preference"
                ? "Preference"
                : "Success";
          const sol = ex.solution ? ` | Solution: ${ex.solution}` : "";
          return `- [${label}] ${ex.mistake}${sol}`;
        })
        .join("\n");
      return `Category: ${category} (count: ${data.count})\n${examples}`;
    })
    .join("\n\n")
    .trim();
}
