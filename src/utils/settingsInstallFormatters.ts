/**
 * Settings install formatter module.
 *
 * Provides aligned text rendering for the settings installer result shape.
 * Follows the same patterns as skillsGuideFormatters.ts.
 */

import type { InstallSettingsResult } from "../tools/settingsInstaller.js";
import { formatListSection } from "./listDataUtilsFormatting.js";

const PROVIDER_KEY_GUIDANCE =
  "Configure your provider API key in the environment before running vibe commands.";

/**
 * Format settings install output with aligned summary fields.
 *
 * @param result - Settings install result
 * @returns Formatted text with Settings Install section
 */
export function formatSettingsInstall(result: InstallSettingsResult): string {
  const rows = [
    ["destination", result.destination],
    ["dryRun", String(result.dryRun)],
    ["force", String(result.force)],
    ["ok", String(result.ok)],
    ["status", result.status],
    ["action", result.action],
  ] as const;
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows
    .map(([label, value]) => `${label.padEnd(labelWidth)}: ${value}`)
    .join("\n");
  return formatListSection("Settings Install", body);
}

/**
 * Append provider-key guidance only for actual installs or replacements.
 *
 * @param result - Settings install result
 * @param text - Previously formatted text output
 * @returns Text with appended guidance when applicable
 */
export function maybeAppendProviderGuidance(
  result: InstallSettingsResult,
  text: string,
): string {
  if (result.action === "installed" || result.action === "replaced") {
    return `${text}\n${PROVIDER_KEY_GUIDANCE}`;
  }
  return text;
}
