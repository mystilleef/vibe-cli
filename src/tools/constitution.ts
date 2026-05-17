import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = path.join(os.homedir(), '.vibe-check');
const CONSTITUTION_FILE = path.join(DATA_DIR, 'constitution.json');
const MAX_RULES = 50;

type Store = Record<string, string[]>;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read(): Store {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(CONSTITUTION_FILE, 'utf8')) as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  ensureDir();
  fs.writeFileSync(CONSTITUTION_FILE, JSON.stringify(store, null, 2), 'utf8');
}

export function updateConstitution(sessionId: string, rule: string): void {
  if (!sessionId || !rule) return;
  const store = read();
  const rules = store[sessionId] ?? [];
  if (rules.length >= MAX_RULES) rules.shift();
  rules.push(rule);
  store[sessionId] = rules;
  write(store);
}

export function resetConstitution(sessionId: string, rules: string[]): void {
  if (!sessionId) return;
  const store = read();
  store[sessionId] = rules.slice(0, MAX_RULES);
  write(store);
}

export function getConstitution(sessionId: string): string[] {
  return read()[sessionId] ?? [];
}
