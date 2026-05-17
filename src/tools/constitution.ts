import fs from "node:fs";
import path from "node:path";
import { ensureDataDir, getDataRoot, resolveAutosession } from "../utils/autosession.js";

function getConstitutionFile(): string {
  return path.join(getDataRoot(), "constitution.json");
}
const MAX_RULES = 50;

type Store = Record<string, string[]>;

function read(): Store {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(getConstitutionFile(), "utf8")) as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  ensureDataDir();
  fs.writeFileSync(
    getConstitutionFile(),
    JSON.stringify(store, null, 2),
    "utf8",
  );
}

function resolveSessionId(): string {
  return resolveAutosession().id;
}

export function updateConstitution(rule: string): void {
  const resolvedSessionId = resolveSessionId();
  if (!resolvedSessionId || !rule) return;
  const store = read();
  const rules = store[resolvedSessionId] ?? [];
  if (rules.length >= MAX_RULES) rules.shift();
  rules.push(rule);
  store[resolvedSessionId] = rules;
  write(store);
}

export function resetConstitution(rules: string[]): void {
  const resolvedSessionId = resolveSessionId();
  if (!resolvedSessionId) return;
  const store = read();
  store[resolvedSessionId] = rules.slice(0, MAX_RULES);
  write(store);
}

export function getConstitution(): string[] {
  return read()[resolveSessionId()] ?? [];
}

export function getCurrentConstitutionSessionId(): string {
  return resolveAutosession().id;
}
