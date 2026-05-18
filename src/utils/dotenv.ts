import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadDotenv(): void {
  try {
    const lines = readFileSync(
      join(homedir(), ".vibe-cli", ".env"),
      "utf8",
    ).split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && val && !process.env[key]) process.env[key] = val;
    }
  } catch {}
}
