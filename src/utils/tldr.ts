/**
 * Pure parsing and presentation for the curated `docs/tldr.md` cheat sheet.
 *
 * The page uses the tldr-pages subset: one `# title`, `>` description
 * lines, and `- description:` / `` `command` `` example pairs. Nothing
 * here touches the filesystem, environment, or terminal state; color
 * stays entirely parameter-driven.
 */

/** One curated workflow example: a terse description and its exact command. */
export interface TldrExample {
  description: string;
  command: string;
}

/** Parsed tldr page: title, joined description, and ordered examples. */
export interface TldrPage {
  title: string;
  description: string;
  examples: TldrExample[];
}

/** Presentation knobs for `formatTldr`; color stays parameter-driven. */
export interface TldrFormatOptions {
  color: boolean;
}

const TITLE_MARKER = "# ";
const DESCRIPTION_MARKER = ">";
const EXAMPLE_MARKER = "- ";
const COMMAND_DELIMITER = "`";
const EXAMPLE_DESCRIPTION_SUFFIX = ":";

const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const bold = ansi(1);
const cyan = ansi(36);
const plain = (text: string) => text;

function fail(message: string): never {
  throw new Error(`tldr page: ${message}`);
}

/** Extract the verbatim command bytes from a backtick-quoted line. */
function parseCommand(line: string): string {
  const closed =
    line.length > 2 * COMMAND_DELIMITER.length &&
    line.startsWith(COMMAND_DELIMITER) &&
    line.endsWith(COMMAND_DELIMITER);
  if (!closed) {
    fail(`command line "${line}" must wrap one backtick-quoted command`);
  }
  return line.slice(COMMAND_DELIMITER.length, -COMMAND_DELIMITER.length);
}

/**
 * Parse the curated tldr page into its title, description, and ordered
 * examples, preserving command bytes and example order exactly.
 *
 * Throws on a missing or malformed title, on incomplete example pairs,
 * and on any line outside the curated subset.
 */
export function parseTldr(page: string): TldrPage {
  const lines = page.split(/\r?\n/);
  let index = 0;

  const nextNonEmptyLine = (): string | undefined => {
    while (index < lines.length) {
      const line = (lines[index] ?? "").trim();
      index += 1;
      if (line !== "") return line;
    }
    return undefined;
  };

  const titleLine = nextNonEmptyLine();
  if (titleLine === undefined || !titleLine.startsWith(TITLE_MARKER)) {
    fail("missing title");
  }
  const title = titleLine.slice(TITLE_MARKER.length).trim();

  const descriptionLines: string[] = [];
  const examples: TldrExample[] = [];
  let pendingDescription: string | undefined;

  for (;;) {
    const line = nextNonEmptyLine();
    if (line === undefined) break;

    if (pendingDescription !== undefined) {
      if (!line.startsWith(COMMAND_DELIMITER)) {
        fail(`example "${pendingDescription}" — missing its command`);
      }
      examples.push({
        description: pendingDescription,
        command: parseCommand(line),
      });
      pendingDescription = undefined;
      continue;
    }

    if (examples.length === 0 && line.startsWith(DESCRIPTION_MARKER)) {
      descriptionLines.push(line.slice(DESCRIPTION_MARKER.length).trim());
      continue;
    }

    if (line.startsWith(EXAMPLE_MARKER)) {
      const entry = line.slice(EXAMPLE_MARKER.length).trim();
      if (!entry.endsWith(EXAMPLE_DESCRIPTION_SUFFIX)) {
        fail(`example description "${entry}" must end with ":"`);
      }
      const description = entry
        .slice(0, -EXAMPLE_DESCRIPTION_SUFFIX.length)
        .trim();
      if (description === "") {
        fail(`example description "${entry}" must name an example`);
      }
      pendingDescription = description;
      continue;
    }

    if (line.startsWith(COMMAND_DELIMITER)) {
      fail(`command "${line}" — missing its example description`);
    }

    fail(`unsupported line "${line}"`);
  }

  if (pendingDescription !== undefined) {
    fail(`example "${pendingDescription}" — missing its command`);
  }

  return {
    title,
    description: descriptionLines.join(" "),
    examples,
  };
}

/**
 * Render the parsed page as readable text. Stripping the ANSI styling
 * from colored text yields the color-disabled text unchanged.
 */
export function formatTldr(
  entries: TldrPage,
  { color }: TldrFormatOptions,
): string {
  const styleTitle = color ? bold : plain;
  const styleExample = color ? bold : plain;
  const styleCommand = color ? cyan : plain;

  const parts = [styleTitle(entries.title), "", entries.description];
  for (const example of entries.examples) {
    parts.push(
      "",
      styleExample(
        `${EXAMPLE_MARKER}${example.description}${EXAMPLE_DESCRIPTION_SUFFIX}`,
      ),
      "",
      styleCommand(
        `${COMMAND_DELIMITER}${example.command}${COMMAND_DELIMITER}`,
      ),
    );
  }
  return parts.join("\n");
}
