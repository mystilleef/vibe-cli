import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatTldr, parseTldr } from "../src/utils/tldr.js";
import { EXPECTED_COMMANDS } from "./helpers/tldrFixtures.js";

const pagePath = join(import.meta.dir, "..", "docs", "tldr.md");
const tldrModulePath = join(import.meta.dir, "..", "src", "utils", "tldr.ts");

const ESC = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Strip ANSI styling so styled text can compare against plain text. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

/** Restore an environment variable to its captured value. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const syntheticPage = `# demo

> First description line.
> Second description line.

- First example:

\`vibe check --goal "{{goal}}" --plan "{{steps}}"\`

- Second example:

\`vibe skills install --target ~/.claude/skills --json=false\`

- Third example:

\`vibe prune --duplicates  --yes\`
`;

const pageText = await readFile(pagePath, "utf8");

describe("parseTldr", () => {
  describe("malformed pages", () => {
    test("throws when the page is empty", () => {
      expect(() => parseTldr("")).toThrow(/missing title/);
    });

    test("throws when the page omits a title", () => {
      expect(() => parseTldr("> Just a description.\n")).toThrow(
        /missing title/,
      );
    });

    test("throws when the title marker is malformed", () => {
      expect(() => parseTldr("## wrong heading\n")).toThrow(/missing title/);
      expect(() => parseTldr("#\n")).toThrow(/missing title/);
    });

    test("throws when an example description lacks its command", () => {
      expect(() => parseTldr("# demo\n\n- Orphan example:\n")).toThrow(
        /missing its command/,
      );
    });

    test("throws when a new example description interrupts an incomplete pair", () => {
      expect(() =>
        parseTldr("# demo\n\n- First:\n\n- Second:\n\n`vibe doctor`\n"),
      ).toThrow(/missing its command/);
    });

    test("throws when an example description carries no text", () => {
      expect(() => parseTldr("# demo\n\n- :\n\n`vibe doctor`\n")).toThrow(
        /must name an example/,
      );
    });

    test("throws when a command line lacks backtick quoting", () => {
      expect(() =>
        parseTldr("# demo\n\n- Broken quote:\n\n`vibe doctor\n"),
      ).toThrow(/backtick-quoted/);
    });

    test("throws when a command line lacks its example description", () => {
      expect(() => parseTldr("# demo\n\n`vibe doctor`\n")).toThrow(
        /missing its example description/,
      );
    });

    test("throws when an example description misses the colon marker", () => {
      expect(() =>
        parseTldr("# demo\n\n- No colon marker\n\n`vibe doctor`\n"),
      ).toThrow(/must end with/);
    });

    test("throws when the page contains unsupported markdown content", () => {
      expect(() => parseTldr("# demo\n\nJust prose.\n")).toThrow(
        /unsupported line/,
      );
    });

    test("throws when a description line follows a completed example", () => {
      expect(() =>
        parseTldr(
          "# demo\n\n- First:\n\n`vibe doctor`\n\n> Late description.\n",
        ),
      ).toThrow(/unsupported line "> Late description\."/);
    });

    test("throws when a command line carries only bare backticks", () => {
      expect(() => parseTldr("# demo\n\n- Bare ticks:\n\n``\n")).toThrow(
        /backtick-quoted/,
      );
    });
  });

  describe("curated grammar", () => {
    test("preserves command bytes and quoted placeholders exactly", () => {
      const page = parseTldr(syntheticPage);

      expect(page.examples.map((example) => example.command)).toEqual([
        'vibe check --goal "{{goal}}" --plan "{{steps}}"',
        "vibe skills install --target ~/.claude/skills --json=false",
        "vibe prune --duplicates  --yes",
      ]);
    });

    test("preserves example descriptions and ordering exactly", () => {
      const page = parseTldr(syntheticPage);

      expect(page.examples.map((example) => example.description)).toEqual([
        "First example",
        "Second example",
        "Third example",
      ]);
    });

    test("joins description lines and retains the title verbatim", () => {
      const page = parseTldr(syntheticPage);

      expect(page.title).toBe("demo");
      expect(page.description).toBe(
        "First description line. Second description line.",
      );
    });

    test("returns exactly the documented nested keys", () => {
      const page = parseTldr(syntheticPage);

      expect(Object.keys(page).sort()).toEqual([
        "description",
        "examples",
        "title",
      ]);
      for (const example of page.examples) {
        expect(Object.keys(example).sort()).toEqual(["command", "description"]);
      }
    });

    test("tolerates blank lines between an example description and its command", () => {
      const page = parseTldr(
        "# demo\n\n- Spaced example:\n\n\n`vibe doctor`\n",
      );

      expect(page.examples).toEqual([
        { description: "Spaced example", command: "vibe doctor" },
      ]);
    });

    test("normalizes CRLF line endings to the same page as LF", () => {
      expect(parseTldr(syntheticPage.replaceAll("\n", "\r\n"))).toEqual(
        parseTldr(syntheticPage),
      );
    });

    test("accepts a title-only page with a trimmed title and empty examples", () => {
      expect(parseTldr("#   demo   \n")).toEqual({
        title: "demo",
        description: "",
        examples: [],
      });
    });
  });
});

describe("curated docs/tldr.md page", () => {
  const page = parseTldr(pageText);

  test("orders the twelve workflow commands exactly", () => {
    expect(page.examples.map((example) => example.command)).toEqual([
      ...EXPECTED_COMMANDS,
    ]);
  });

  test("states mentor purpose and help references in the description", () => {
    expect(page.description).toMatch(/mentor/i);
    expect(page.description).toContain("vibe --help");
    expect(page.description).toContain("vibe <command> --help");
  });

  test("describes settings prerequisites without claiming credential configuration", () => {
    const description = page.examples[0]?.description ?? "";

    expect(description).toMatch(/provider/i);
    expect(description).toMatch(/api key/i);
    expect(description).not.toMatch(
      /configures? (your )?(credentials|api keys?)/i,
    );
  });

  test("names the default skills path for explicit-target installs", () => {
    expect(page.examples[2]?.description ?? "").toContain("~/.agents/skills");
  });

  test("documents the no-proceed exit code for plan review", () => {
    const description = page.examples[7]?.description ?? "";

    expect(description).toMatch(/exit 2/i);
    expect(description).toMatch(/no-proceed/i);
  });

  test("documents the safety backup for duplicate deletion", () => {
    expect(page.examples[10]?.description ?? "").toMatch(/backup/i);
  });

  test("confines --json promises to the doctor diagnostics example", () => {
    page.examples.forEach((example, index) => {
      expect(example.command.includes("--json")).toBe(index === 11);
      expect(example.description.includes("--json")).toBe(false);
    });
    expect(page.description.includes("--json")).toBe(false);
  });

  test("keeps every example description terse and non-empty", () => {
    for (const example of page.examples) {
      expect(example.description.length).toBeGreaterThan(0);
      expect(example.description.length).toBeLessThan(120);
    }
  });

  test.each([
    [1, /connectivity/i],
    [3, /current directory/i],
    [4, /live walkthrough/i],
    [5, /stored/i],
    [6, /type/i],
    [8, /read-only/i],
    [9, /duplicate/i],
    [11, /json/i],
  ] as const)(
    "describes example %i with its workflow semantics",
    (index, pattern) => {
      expect(page.examples[index]?.description ?? "").toMatch(pattern);
    },
  );
});

describe("formatTldr", () => {
  const page = parseTldr(syntheticPage);

  test("omits ANSI sequences when color is disabled", () => {
    const plain = formatTldr(page, { color: false });

    expect(plain.includes(ESC)).toBe(false);
  });

  test("renders commands verbatim in order when color is disabled", () => {
    const plain = formatTldr(page, { color: false });

    expect(plain.split("\n")[0]).toBe("demo");
    expect(plain).toContain("First description line. Second description line.");
    let cursor = -1;
    for (const example of page.examples) {
      const next = plain.indexOf(example.command, cursor + 1);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  test("adds ANSI styling without altering content when color is enabled", () => {
    const plain = formatTldr(page, { color: false });
    const styled = formatTldr(page, { color: true });

    expect(styled.includes(ESC)).toBe(true);
    expect(stripAnsi(styled)).toBe(plain);
  });

  test("keeps rendering independent of environment settings", () => {
    const saved = {
      forceColor: process.env["FORCE_COLOR"],
      noColor: process.env["NO_COLOR"],
      term: process.env["TERM"],
    };
    const plain = formatTldr(page, { color: false });
    const styled = formatTldr(page, { color: true });

    try {
      process.env["FORCE_COLOR"] = "1";
      process.env["NO_COLOR"] = "";
      process.env["TERM"] = "xterm-256color";
      expect(formatTldr(page, { color: false })).toBe(plain);
      expect(formatTldr(page, { color: true })).toBe(styled);
    } finally {
      restoreEnv("FORCE_COLOR", saved.forceColor);
      restoreEnv("NO_COLOR", saved.noColor);
      restoreEnv("TERM", saved.term);
    }
  });

  test("renders a page without examples as title and description only", () => {
    const solo = parseTldr("# demo\n\n> Solo page.\n");
    const plain = formatTldr(solo, { color: false });
    const styled = formatTldr(solo, { color: true });

    expect(plain).toBe("demo\n\nSolo page.");
    expect(styled.split("\n")).toEqual([
      `${ESC}[1mdemo${ESC}[0m`,
      "",
      "Solo page.",
    ]);
  });

  test("styles title and examples bold, commands cyan, and leaves descriptions plain", () => {
    const lines = formatTldr(page, { color: true }).split("\n");

    expect(lines[0]).toBe(`${ESC}[1mdemo${ESC}[0m`);
    expect(lines[2]).toBe("First description line. Second description line.");
    expect(lines[4]).toBe(`${ESC}[1m- First example:${ESC}[0m`);
    expect(lines[6]).toBe(
      `${ESC}[36m\`vibe check --goal "{{goal}}" --plan "{{steps}}"\`${ESC}[0m`,
    );
  });

  test("exports only parse and format rendering", async () => {
    const module = await import("../src/utils/tldr.js");

    expect(Object.keys(module).sort()).toEqual(["formatTldr", "parseTldr"]);
  });

  test("performs no I/O or environment access in source", async () => {
    const source = await readFile(tldrModulePath, "utf8");

    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\bBun\./);
  });
});
