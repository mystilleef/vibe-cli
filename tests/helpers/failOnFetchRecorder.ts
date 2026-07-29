// fallow-ignore-file unused-file
/**
 * Preload helper: records and fails every attempted network call.
 *
 * Each call is appended to the file named in VIBE_FETCH_RECORD (JSONL, one
 * entry per attempt).  When the variable is unset the recorder still throws
 * but skips file output.
 */
const recordPath = process.env["VIBE_FETCH_RECORD"];
const calls: string[] = [];

globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    if (recordPath) {
      const fs = require("node:fs");
      fs.appendFileSync(
        recordPath,
        `${JSON.stringify({ url, at: Date.now() })}\n`,
        "utf-8",
      );
    }
    throw new Error(`Unexpected network call: ${url}`);
  },
  { preconnect: globalThis.fetch.preconnect },
);
