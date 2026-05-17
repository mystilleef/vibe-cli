import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = path.join(os.homedir(), '.vibe-check');
const LOG_FILE = path.join(DATA_DIR, 'vibe-log.json');

export type LearningType = 'mistake' | 'preference' | 'success';

export interface LearningEntry {
  type: LearningType;
  category: string;
  mistake: string;
  solution?: string;
  timestamp: number;
}

interface VibeLog {
  mistakes: Record<string, { count: number; examples: LearningEntry[]; lastUpdated: number }>;
  lastUpdated: number;
}

const emptyLog: VibeLog = { mistakes: {}, lastUpdated: Date.now() };

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readLogFile(): VibeLog {
  ensureDataDir();
  if (!fs.existsSync(LOG_FILE)) {
    writeLogFile(emptyLog);
    return emptyLog;
  }
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) as VibeLog;
  } catch {
    return emptyLog;
  }
}

function writeLogFile(data: VibeLog): void {
  ensureDataDir();
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing vibe log:', error);
  }
}

export function addLearningEntry(
  mistake: string,
  category: string,
  solution?: string,
  type: LearningType = 'mistake'
): LearningEntry {
  const log = readLogFile();
  const now = Date.now();
  const entry: LearningEntry = { type, category, mistake, solution, timestamp: now };

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
    Object.entries(log.mistakes).map(([cat, data]) => [cat, data.examples])
  );
}

export function getLearningCategorySummary(): Array<{
  category: string;
  count: number;
  recentExample: LearningEntry;
}> {
  const log = readLogFile();
  return Object.entries(log.mistakes)
    .map(([category, data]) => ({
      category,
      count: data.count,
      recentExample: data.examples[data.examples.length - 1],
    }))
    .sort((a, b) => b.count - a.count);
}

export function removeLearningEntriesAfter(timestamp: number): void {
  const log = readLogFile();
  for (const cat of Object.keys(log.mistakes)) {
    const data = log.mistakes[cat];
    data.examples = data.examples.filter(e => e.timestamp < timestamp);
    if (data.examples.length === 0) {
      delete log.mistakes[cat];
    } else {
      data.count = data.examples.length;
      data.lastUpdated = Math.max(...data.examples.map(e => e.timestamp));
    }
  }
  log.lastUpdated = Date.now();
  writeLogFile(log);
}

export function getLearningContextText(maxPerCategory = 5): string {
  const log = readLogFile();
  return Object.entries(log.mistakes)
    .map(([category, data]) => {
      const examples = [...data.examples]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-maxPerCategory)
        .map(ex => {
          const label = ex.type === 'mistake' ? 'Mistake' : ex.type === 'preference' ? 'Preference' : 'Success';
          const sol = ex.solution ? ` | Solution: ${ex.solution}` : '';
          return `- [${new Date(ex.timestamp).toISOString()}] ${label}: ${ex.mistake}${sol}`;
        })
        .join('\n');
      return `Category: ${category} (count: ${data.count})\n${examples}`;
    })
    .join('\n\n')
    .trim();
}
