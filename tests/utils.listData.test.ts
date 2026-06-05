import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDatabase } from "../src/utils/database";
import {
  applyListLimit,
  buildListStats,
  formatAlignedRows,
  formatListAll,
  formatListCategories,
  formatListChecks,
  formatListCommandOverview,
  formatListConstitution,
  formatListLearnings,
  formatListProviders,
  formatListSessions,
  formatListStats,
  formatRelativeTime,
  parseCheckReason,
  parseLearningType,
  parseListLimit,
  readListAll,
  readListCategories,
  readListChecks,
  readListConstitution,
  readListLearnings,
  readListProviders,
  readListSessions,
  readListStats,
  summarizeLearningCategories,
  toListOverviewJson,
  toProvidersJson,
  truncateText,
} from "../src/utils/listData";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext;
let cwd: string;
const originalCwd = process.cwd();
const originalProvider = process.env.DEFAULT_LLM_PROVIDER;

beforeEach(async () => {
  home = await createTempHome();
  cwd = await mkdtemp(join(tmpdir(), "vibe-cli-list-data-"));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalProvider === undefined) {
    delete process.env.DEFAULT_LLM_PROVIDER;
  } else {
    process.env.DEFAULT_LLM_PROVIDER = originalProvider;
  }
  await rm(cwd, { recursive: true, force: true });
  await home.cleanup();
});

describe("list data foundations", () => {
  test("learning readers filter, limit, and summarize deterministically", () => {
    withDatabase((db) => {
      const insert = db.prepare(
        "INSERT INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("success", "alpha", "old alpha", null, 1000, null);
      insert.run("mistake", "beta", "beta mistake", null, 2000, null);
      insert.run("mistake", "alpha", "new alpha", "fix", 3000, "demo-1");
    });

    expect(readListLearnings({ category: "alpha", limit: 1 })).toEqual([
      {
        type: "success",
        category: "alpha",
        observation: "old alpha",
        timestamp: 1000,
      },
    ]);
    expect(parseLearningType("mistake")).toBe("mistake");
    expect(
      readListLearnings({ type: "mistake" }).map((entry) => entry.observation),
    ).toEqual(["new alpha", "beta mistake"]);
    expect(readListCategories()).toEqual([
      {
        category: "alpha",
        count: 2,
        recentExample: {
          type: "mistake",
          category: "alpha",
          observation: "new alpha",
          solution: "fix",
          timestamp: 3000,
          demoId: "demo-1",
        },
      },
      {
        category: "beta",
        count: 1,
        recentExample: {
          type: "mistake",
          category: "beta",
          observation: "beta mistake",
          timestamp: 2000,
        },
      },
    ]);
    expect(parseListLimit("2")).toBe(2);
    expect(applyListLimit([1, 2, 3], 2)).toEqual([1, 2]);
    expect(() => parseListLimit("-1")).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => parseListLimit("0")).toThrow(
      "--limit must be a positive integer",
    );
    expect(() => parseLearningType("other")).toThrow(
      "--type must be mistake, preference, or success",
    );
  });

  test("summarizeLearningCategories and resolveMostActiveCwd handle edge cases", () => {
    // Empty learnings → empty categories
    expect(summarizeLearningCategories([])).toEqual([]);

    // Stats with no sessions → null mostActiveCwd
    const emptyStats = buildListStats([], [], { session: "s", rules: [] }, []);
    expect(emptyStats.sessions.mostActiveCwd).toBeNull();

    // Stats with sessions but no interactions → picks first session by last_accessed_at
    const sessions = [
      {
        id: "s1",
        cwd_key: "k1",
        cwd: "/tmp/a",
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-02",
      },
      {
        id: "s2",
        cwd_key: "k2",
        cwd: "/tmp/b",
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-03",
      },
    ];
    const noInteractionStats = buildListStats(
      [],
      sessions,
      { session: "s", rules: [] },
      [],
    );
    expect(noInteractionStats.sessions.mostActiveCwd).toBe("/tmp/b");

    // Sessions with null cwd falls back to cwd_key
    const nullCwdSessions = [
      {
        id: "s3",
        cwd_key: "key3",
        cwd: null,
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-01",
      },
    ];
    const nullCwdStats = buildListStats(
      [],
      nullCwdSessions,
      { session: "s", rules: [] },
      [],
    );
    expect(nullCwdStats.sessions.mostActiveCwd).toBe("key3");

    // Interaction count tiebreaker → last_accessed_at → id
    const tiedInteractions = [
      {
        id: 1,
        session_id: "s1",
        goal: "g1",
        output: "o1",
        timestamp: 1000,
        displayCwd: null,
      },
      {
        id: 2,
        session_id: "s2",
        goal: "g2",
        output: "o2",
        timestamp: 2000,
        displayCwd: null,
      },
    ];
    const tiedStats = buildListStats(
      [],
      sessions,
      { session: "s", rules: [] },
      tiedInteractions,
    );
    expect(tiedStats.sessions.mostActiveCwd).toBe("/tmp/b");

    // Triple tiebreaker: same count, same last_accessed_at → sort by id
    const sameTimestamp = [
      {
        id: "z-session",
        cwd_key: "kz",
        cwd: "/tmp/z",
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-01",
      },
      {
        id: "a-session",
        cwd_key: "ka",
        cwd: "/tmp/a",
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-01",
      },
    ];
    const sameInteractions = [
      {
        id: 1,
        session_id: "z-session",
        goal: "g1",
        output: "o1",
        timestamp: 1000,
        displayCwd: null,
      },
      {
        id: 2,
        session_id: "a-session",
        goal: "g2",
        output: "o2",
        timestamp: 2000,
        displayCwd: null,
      },
    ];
    const tripleTied = buildListStats(
      [],
      sameTimestamp,
      { session: "s", rules: [] },
      sameInteractions,
    );
    expect(tripleTied.sessions.mostActiveCwd).toBe("/tmp/a");
  });

  test("readers expose local sessions, constitution, providers, interactions, and stats", () => {
    const active = readListConstitution();

    withDatabase((db) => {
      const insertSession = db.prepare(
        "INSERT INTO sessions (id, cwd_key, cwd, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
      );
      insertSession.run(
        "session-a",
        "cwd-a",
        "/tmp/project-a",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      );
      insertSession.run(
        "session-b",
        "cwd-b",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z",
      );

      const insertRule = db.prepare(
        "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      );
      insertRule.run(
        active.session,
        "Prefer local reads",
        0,
        "2026-01-01T00:00:00.000Z",
      );
      insertRule.run(
        active.session,
        "Avoid provider calls",
        1,
        "2026-01-01T00:00:00.000Z",
      );

      const insertInteraction = db.prepare(
        "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      );
      insertInteraction.run(
        "session-a",
        "newest",
        JSON.stringify({ reason: "stored reason" }),
        3000,
      );
      insertInteraction.run("session-a", "oldest", "raw output", 1000);
      insertInteraction.run("session-b", "other", "other output", 2000);
    });
    process.env.DEFAULT_LLM_PROVIDER = "deepseek";

    expect(readListConstitution()).toEqual({
      session: active.session,
      rules: ["Prefer local reads", "Avoid provider calls"],
    });
    expect(
      readListSessions().find((session) => session.id === "session-a"),
    ).toEqual(
      expect.objectContaining({
        cwd_key: "cwd-a",
        cwd: "/tmp/project-a",
      }),
    );
    expect(
      readListChecks({ session: "session-a", limit: 1 }).map(
        (interaction) => interaction.goal,
      ),
    ).toEqual(["newest"]);

    const providers = readListProviders();
    expect(providers.activeProvider).toBe("deepseek");
    expect(toProvidersJson(providers)).toMatchObject({
      deepseek: "deepseek-v4-pro",
      gemini: "gemini-2.5-flash",
    });

    expect(readListStats()).toEqual({
      learnings: { total: 0, mistake: 0, preference: 0, success: 0 },
      sessions: { total: 3, mostActiveCwd: "/tmp/project-a" },
      constitution: { activeRules: 2 },
      checks: { total: 3 },
    });
    expect(readListAll()).toMatchObject({
      constitution: { session: active.session },
      providers: expect.objectContaining({
        activeProvider: "deepseek",
        providers: expect.objectContaining({ deepseek: "deepseek-v4-pro" }),
      }),
      stats: { checks: { total: 3 } },
    });
  });

  test("pretty and DTO helpers expose deterministic seams", () => {
    expect(formatRelativeTime(1000, { now: 61_000 })).toBe("1m ago");
    expect(formatRelativeTime(121_000, { now: 61_000 })).toBe("1m from now");
    expect(formatRelativeTime("not-a-date", { now: 0 })).toBe("unknown");
    expect(truncateText("abcdef", 3, "...")).toBe("abc...");
    expect(truncateText("abc", 3)).toBe("abc");
    expect(() => truncateText("abc", -1)).toThrow(
      "maxLength must be a non-negative integer",
    );
    expect(parseCheckReason(JSON.stringify({ reason: "because" }))).toBe(
      "because",
    );
    expect(parseCheckReason(JSON.stringify("plain"))).toBe("plain");
    expect(parseCheckReason("raw")).toBe("raw");
    expect(formatAlignedRows(["a", "long"], [["xx", "y"]])).toContain("xx  y");
    expect(formatListCommandOverview()).toContain("- learnings");
    expect(toListOverviewJson().commands).toContain("all");
  });

  test("formatListLearnings groups by category and shows solutions", () => {
    const base = 100_000;
    const learnings = [
      {
        type: "mistake" as const,
        category: "alpha",
        observation: "A1",
        timestamp: base,
      },
      {
        type: "success" as const,
        category: "alpha",
        observation: "A2",
        solution: "fixed",
        timestamp: base + 1000,
      },
      {
        type: "preference" as const,
        category: "beta",
        observation: "B1",
        timestamp: base + 2000,
      },
    ];
    const result = formatListLearnings(learnings, { now: base + 60_000 });

    expect(result).toContain("Learnings");
    expect(result).toContain("Category: alpha");
    expect(result).toContain("Category: beta");
    expect(result).toContain("[mistake] A1");
    expect(result).toContain("[success] A2");
    expect(result).toContain("Solution: fixed");
    expect(result).toContain("[preference] B1");
    expect(result).toContain("1m ago");
  });

  test("formatListLearnings renders (none) for empty input", () => {
    const result = formatListLearnings([], { now: 0 });
    expect(result).toContain("Learnings");
    expect(result).toContain("(none)");
  });

  test("formatListConstitution renders numbered rules and (none) for empty", () => {
    const withRules = formatListConstitution({
      session: "s1",
      rules: ["Rule A", "Rule B"],
    });
    expect(withRules).toContain("Constitution");
    expect(withRules).toContain("Session: s1");
    expect(withRules).toContain("1. Rule A");
    expect(withRules).toContain("2. Rule B");

    const empty = formatListConstitution({ session: "s2", rules: [] });
    expect(empty).toContain("Session: s2");
    expect(empty).toContain("(none)");
  });

  test("formatListSessions falls back to cwd_key when cwd is null or empty", () => {
    const sessions = [
      {
        id: "s1",
        cwd_key: "key1",
        cwd: "/tmp/project",
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-02",
      },
      {
        id: "s2",
        cwd_key: "key2",
        cwd: null,
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-02",
      },
      {
        id: "s3",
        cwd_key: "key3",
        cwd: "",
        created_at: "2026-01-01",
        last_accessed_at: "2026-01-02",
      },
    ];
    const result = formatListSessions(sessions);

    expect(result).toContain("Sessions");
    expect(result).toContain("/tmp/project");
    expect(result).not.toContain("key1");
    expect(result).toContain("key2");
    expect(result).toContain("key3");
    expect(result).toContain("s1");
    expect(result).toContain("s2");
  });

  test("formatListSessions renders (none) for empty input", () => {
    const result = formatListSessions([]);
    expect(result).toContain("Sessions");
    expect(result).toContain("(none)");
  });

  test("formatListProviders marks active provider and uses fallback for empty model", () => {
    const state = {
      activeProvider: "gemini",
      providers: { gemini: "gemini-2.5-flash", openai: "" },
    };
    const result = formatListProviders(state);

    expect(result).toContain("Providers");
    expect(result).toContain("gemini");
    expect(result).toContain("gemini-2.5-flash");
    expect(result).toContain("(required via --model)");
    expect(result).toContain("*");
  });

  test("formatListCategories shows counts and recent examples", () => {
    const categories = [
      {
        category: "risk",
        count: 3,
        recentExample: {
          type: "mistake" as const,
          category: "risk",
          observation: "Latest risk",
          timestamp: 1000,
        },
      },
      {
        category: "style",
        count: 1,
        recentExample: {
          type: "success" as const,
          category: "style",
          observation: "Style win",
          timestamp: 2000,
        },
      },
    ];
    const result = formatListCategories(categories);

    expect(result).toContain("Categories");
    expect(result).toContain("risk");
    expect(result).toContain("3");
    expect(result).toContain("[mistake] Latest risk");
    expect(result).toContain("[success] Style win");
  });

  test("formatListCategories renders (none) for empty input", () => {
    const result = formatListCategories([]);
    expect(result).toContain("Categories");
    expect(result).toContain("(none)");
  });

  test("formatListChecks groups by session, parses JSON reasons, truncates long text", () => {
    const base = 100_000;
    const interactions = [
      {
        id: 1,
        session_id: "s1",
        goal: "Goal A",
        output: JSON.stringify({ reason: "Because A" }),
        timestamp: base,
        displayCwd: "/tmp/project-a",
      },
      {
        id: 2,
        session_id: "s1",
        goal: "Goal B",
        output: "Raw output reason.",
        timestamp: base + 1000,
        displayCwd: "/tmp/project-a",
      },
      {
        id: 3,
        session_id: "s2",
        goal: "Goal C",
        output: "X".repeat(130),
        timestamp: base + 2000,
        displayCwd: null,
      },
    ];
    const result = formatListChecks(interactions, { now: base + 60_000 });

    expect(result).toContain("Checks");
    expect(result).toContain("Session: /tmp/project-a");
    expect(result).toContain("Session: s2");
    expect(result).toContain("Goal: Goal A");
    expect(result).toContain("Reason: Because A");
    expect(result).toContain("Reason: Raw output reason.");
    expect(result).toContain("1m ago");
    expect(result).toContain(`${"X".repeat(120)}…`);
  });

  test("formatListChecks renders (none) for empty input", () => {
    const result = formatListChecks([], { now: 0 });
    expect(result).toContain("Checks");
    expect(result).toContain("(none)");
  });

  test("formatListStats renders all stat lines including null mostActiveCwd", () => {
    const stats = {
      learnings: { total: 5, mistake: 2, preference: 1, success: 2 },
      sessions: { total: 3, mostActiveCwd: "/tmp/active" },
      constitution: { activeRules: 4 },
      checks: { total: 10 },
    };
    const result = formatListStats(stats);
    expect(result).toContain("Stats");
    expect(result).toContain(
      "Learnings: 5 total (2 mistake, 1 preference, 2 success)",
    );
    expect(result).toContain("Sessions: 3 total");
    expect(result).toContain("Most active cwd: /tmp/active");
    expect(result).toContain("Constitution rules: 4");
    expect(result).toContain("Checks: 10 total");

    const nullCwd = formatListStats({
      ...stats,
      sessions: { total: 0, mostActiveCwd: null },
    });
    expect(nullCwd).toContain("Most active cwd: (none)");
  });

  test("formatListAll composes every section", () => {
    const data = {
      learnings: [
        {
          type: "mistake" as const,
          category: "c",
          observation: "m",
          timestamp: 1000,
        },
      ],
      constitution: { session: "s", rules: ["r"] },
      sessions: [
        {
          id: "s",
          cwd_key: "k",
          cwd: "/tmp",
          created_at: "a",
          last_accessed_at: "b",
        },
      ],
      providers: {
        activeProvider: "gemini",
        providers: { gemini: "gemini-2.5-flash" },
      },
      checks: [
        {
          id: 1,
          session_id: "s",
          goal: "g",
          output: "o",
          timestamp: 1000,
          displayCwd: "/tmp",
        },
      ],
      categories: [
        {
          category: "c",
          count: 1,
          recentExample: {
            type: "mistake" as const,
            category: "c",
            observation: "m",
            timestamp: 1000,
          },
        },
      ],
      stats: {
        learnings: { total: 1, mistake: 1, preference: 0, success: 0 },
        sessions: { total: 1, mostActiveCwd: "/tmp" },
        constitution: { activeRules: 1 },
        checks: { total: 1 },
      },
    };
    const result = formatListAll(data, { now: 0 });

    for (const heading of [
      "Learnings",
      "Constitution",
      "Sessions",
      "Providers",
      "Checks",
      "Categories",
      "Stats",
    ]) {
      expect(result).toContain(heading);
    }
  });
});
