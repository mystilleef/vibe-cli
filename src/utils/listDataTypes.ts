import type { LearningEntry, LearningType } from "./storage.js";

/** Stable list subcommand registry shared by CLI help, schema, and tests. */
export const LIST_COMMAND_NAMES = [
  "learnings",
  "constitution",
  "sessions",
  "providers",
  "checks",
  "categories",
  "stats",
  "all",
] as const;

export type ListCommandName = (typeof LIST_COMMAND_NAMES)[number];

export interface ListLearningFilters {
  type?: LearningType;
  category?: string;
  limit?: number;
}

export interface ListCheckFilters {
  session?: string;
  limit?: number;
}

export interface ListClock {
  now?: Date | number;
}

export interface ListSession {
  id: string;
  cwd_key: string;
  cwd: string | null;
  created_at: string;
  last_accessed_at: string;
}

export interface ListConstitution {
  session: string;
  rules: string[];
}

export interface ListProviderState {
  activeProvider: string;
  providers: Record<string, string>;
}

export interface ListCheck {
  id: number;
  session_id: string;
  goal: string;
  output: string;
  timestamp: number;
  displayCwd: string | null;
}

export interface ListCategorySummary {
  category: string;
  count: number;
  recentExample: LearningEntry;
}

export interface ListStats {
  learnings: {
    total: number;
    mistake: number;
    preference: number;
    success: number;
  };
  sessions: {
    total: number;
    mostActiveCwd: string | null;
  };
  constitution: {
    activeRules: number;
  };
  checks: {
    total: number;
  };
}

export interface ListAllData {
  learnings: LearningEntry[];
  constitution: ListConstitution;
  sessions: ListSession[];
  providers: ListProviderState;
  checks: ListCheck[];
  categories: ListCategorySummary[];
  stats: ListStats;
}
