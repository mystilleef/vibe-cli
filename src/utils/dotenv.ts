import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_DOTENV_WARNING =
  "Deprecated ~/.vibe-cli/.env ignored. Move provider settings to ~/.vibe-cli/settings.json and provide secrets through the parent process environment.";

export function warnLegacyDotenv(): void {
  const home = process.env["HOME"] ?? homedir();
  if (existsSync(join(home, ".vibe-cli", ".env"))) {
    process.stderr.write(`${LEGACY_DOTENV_WARNING}\n`);
  }
}
