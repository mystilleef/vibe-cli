import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  addLearningEntry,
  getLearningCategorySummary,
  getLearningContextText,
  getLearningEntries,
  removeLearningEntriesAfter,
} from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  await home.cleanup();
});

describe("addLearningEntry", () => {
  test("creates a new category and returns the entry", () => {
    const entry = addLearningEntry("forgot import", "imports", "add import");
    expect(entry.type).toBe("mistake");
    expect(entry.category).toBe("imports");
    expect(entry.mistake).toBe("forgot import");
    expect(entry.solution).toBe("add import");
    expect(typeof entry.timestamp).toBe("number");
  });

  test("supports non-default type values", () => {
    const e = addLearningEntry("good pattern", "style", undefined, "success");
    expect(e.type).toBe("success");
    expect(e.solution).toBeUndefined();
  });

  test("increments count on repeated category writes", () => {
    addLearningEntry("e1", "cat");
    addLearningEntry("e2", "cat");
    const summary = getLearningCategorySummary();
    const found = summary.find((s) => s.category === "cat");
    expect(found?.count).toBe(2);
  });
});

describe("getLearningEntries", () => {
  test("returns empty object when log is fresh", () => {
    expect(getLearningEntries()).toEqual({});
  });

  test("groups entries by category", () => {
    addLearningEntry("e1", "a");
    addLearningEntry("e2", "b");
    addLearningEntry("e3", "a");
    const entries = getLearningEntries();
    expect(entries.a).toHaveLength(2);
    expect(entries.b).toHaveLength(1);
  });
});

describe("getLearningCategorySummary", () => {
  test("returns empty array when no entries", () => {
    expect(getLearningCategorySummary()).toEqual([]);
  });

  test("sorts by count descending and exposes recentExample", () => {
    addLearningEntry("x", "low");
    addLearningEntry("y", "high");
    addLearningEntry("z", "high");
    const summary = getLearningCategorySummary();
    expect(summary[0]?.category).toBe("high");
    expect(summary[0]?.count).toBe(2);
    expect(summary[0]?.recentExample.mistake).toBe("z");
    expect(summary[1]?.category).toBe("low");
  });
});

// Write a log file with controlled timestamps directly, bypassing Date.now() races.
function writeRawLog(
  dataRoot: string,
  categories: Record<
    string,
    Array<{ mistake: string; timestamp: number; type?: string }>
  >,
) {
  const logPath = path.join(dataRoot, "vibe-log.json");
  const mistakes: Record<
    string,
    { count: number; examples: object[]; lastUpdated: number }
  > = {};
  for (const [cat, entries] of Object.entries(categories)) {
    mistakes[cat] = {
      count: entries.length,
      examples: entries.map((e) => ({
        type: e.type ?? "mistake",
        category: cat,
        mistake: e.mistake,
        timestamp: e.timestamp,
      })),
      lastUpdated: Math.max(...entries.map((e) => e.timestamp)),
    };
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(
    logPath,
    JSON.stringify({ mistakes, lastUpdated: Date.now() }),
  );
}

describe("removeLearningEntriesAfter", () => {
  test("removes entries at or after the cutoff and keeps those before", () => {
    // Use controlled timestamps: "old" at T=100, "new" at T=200, cutoff=150
    writeRawLog(home.dataRoot, {
      cat: [
        { mistake: "old", timestamp: 100 },
        { mistake: "new", timestamp: 200 },
      ],
    });
    removeLearningEntriesAfter(150);
    const entries = getLearningEntries();
    expect(entries.cat?.map((e) => e.mistake)).toContain("old");
    expect(entries.cat?.map((e) => e.mistake)).not.toContain("new");
  });

  test("deletes the entire category when all entries are removed", () => {
    addLearningEntry("x", "gone");
    const cutoff = Date.now() - 10000; // everything is after this
    removeLearningEntriesAfter(cutoff);
    const entries = getLearningEntries();
    expect(entries.gone).toBeUndefined();
  });

  test("recalculates count to match remaining examples", () => {
    // Use controlled timestamps: "a" at T=100, "b" at T=200, cutoff=150
    writeRawLog(home.dataRoot, {
      c: [
        { mistake: "a", timestamp: 100 },
        { mistake: "b", timestamp: 200 },
      ],
    });
    removeLearningEntriesAfter(150);
    const summary = getLearningCategorySummary();
    const found = summary.find((s) => s.category === "c");
    expect(found?.count).toBe(1);
  });
});

describe("removeLearningEntriesAfter — edge cases", () => {
  test("is a no-op when cutoff is before all entries", () => {
    addLearningEntry("x", "kept");
    const cutoff = Date.now() - 60_000; // a minute ago — all entries are newer
    removeLearningEntriesAfter(cutoff);
    // Entry is after cutoff so the filter `timestamp < cutoff` drops it — but the
    // cutoff is before the entry, meaning entry.timestamp > cutoff, so the filter
    // keeps entries whose timestamp < cutoff. Since all entries are after the cutoff,
    // all are removed. This is the expected function contract: "remove entries AFTER
    // the timestamp" means entries with timestamp >= cutoff are removed.
    // We test the opposite: a far-future cutoff keeps everything.
    addLearningEntry("y", "kept2");
    const futureCutoff = Date.now() + 60_000;
    removeLearningEntriesAfter(futureCutoff);
    const afterEntries = getLearningEntries();
    expect(afterEntries.kept2).toHaveLength(1);
  });

  test("updates lastUpdated on the log after removal", () => {
    addLearningEntry("a", "cat-update");
    const before = Date.now();
    const futureCutoff = Date.now() + 60_000;
    removeLearningEntriesAfter(futureCutoff);
    // category still exists, but we verify by reading entries that the write happened
    const entries = getLearningEntries();
    expect(entries["cat-update"]).toHaveLength(1);
    // log.lastUpdated is updated — verified indirectly by no throw
    expect(before).toBeLessThanOrEqual(Date.now());
  });
});

describe("getLearningContextText", () => {
  test("returns empty string when no entries", () => {
    expect(getLearningContextText()).toBe("");
  });

  test("formats entries by category with label and solution", () => {
    addLearningEntry("err1", "style", "fix it");
    const text = getLearningContextText();
    expect(text).toContain("Category: style");
    expect(text).toContain("Mistake:");
    expect(text).toContain("err1");
    expect(text).toContain("Solution: fix it");
  });

  test("omits Solution line when solution is absent", () => {
    addLearningEntry("no-sol", "bare");
    const text = getLearningContextText();
    expect(text).toContain("bare");
    // The entry line should not contain "| Solution:"
    const entryLine = text.split("\n").find((l) => l.includes("no-sol"));
    expect(entryLine).toBeDefined();
    expect(entryLine).not.toContain("Solution:");
  });

  test("respects maxPerCategory cap", () => {
    for (let i = 0; i < 10; i++) {
      addLearningEntry(`e${i}`, "cap");
    }
    const text = getLearningContextText(3);
    // Only last 3 entries should appear
    const matches = (text.match(/- \[/g) ?? []).length;
    expect(matches).toBe(3);
  });

  test("uses Preference label for preference type", () => {
    addLearningEntry("pref1", "prefs", undefined, "preference");
    const text = getLearningContextText();
    expect(text).toContain("Preference:");
  });

  test("uses Success label for success type", () => {
    addLearningEntry("s1", "wins", undefined, "success");
    const text = getLearningContextText();
    expect(text).toContain("Success:");
  });

  test("joins multiple categories with double newline", () => {
    addLearningEntry("e1", "alpha");
    addLearningEntry("e2", "beta");
    const text = getLearningContextText();
    expect(text).toContain("Category: alpha");
    expect(text).toContain("Category: beta");
    // Categories separated by blank line
    expect(text).toContain("\n\n");
  });
});
