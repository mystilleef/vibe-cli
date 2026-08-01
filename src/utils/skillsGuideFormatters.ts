/**
 * Skills and guide formatter module.
 *
 * Provides reusable, aligned text rendering for skills and guide installer
 * result shapes. Follows the same patterns as listDataFormatters.ts.
 */

import type { InstallGuideResult } from "../tools/guideInstaller.js";
import type { InstallResult } from "../tools/skillsInstaller.js";
import {
  formatAlignedRows,
  formatListSection,
} from "./listDataUtilsFormatting.js";

/**
 * Format skills list output with aligned name and status columns.
 *
 * @param result - Skills list result containing target and skills array
 * @returns Formatted text with Skills section
 */
export function formatSkillsList(result: {
  target: string;
  skills: Array<{ name: string; status: string }>;
}): string {
  const rows = result.skills.map((skill) => [skill.name, skill.status]);
  const body = rows.length
    ? formatAlignedRows(["name", "status"], rows)
    : "(none)";
  return formatListSection("Skills", body);
}

/**
 * Format skills install output with aligned columns.
 *
 * @param result - Skills install result
 * @returns Formatted text with Skills Install section
 */
export function formatSkillsInstall(result: InstallResult): string {
  const header = [
    `dryRun: ${result.dryRun}`,
    `force: ${result.force}`,
    `ok: ${result.ok}`,
  ].join("  ");

  const hasErrors = result.skills.some((skill) => skill.error !== undefined);
  const headers = hasErrors
    ? ["name", "status", "action", "error"]
    : ["name", "status", "action"];

  const rows = result.skills.map((skill) => {
    const base = [skill.name, skill.status, skill.action];
    if (hasErrors) {
      base.push(skill.error ?? "");
    }
    return base;
  });

  const body = rows.length
    ? `${header}\n${formatAlignedRows(headers, rows)}`
    : `${header}\n(none)`;
  return formatListSection("Skills Install", body);
}

/**
 * Format guide list output with target and status.
 *
 * @param result - Guide list result containing target and status
 * @returns Formatted text with Guide section
 */
export function formatGuideList(result: {
  target: string;
  status: string;
}): string {
  const body = `target: ${result.target}\nstatus: ${result.status}`;
  return formatListSection("Guide", body);
}

/**
 * Format guide install output with target, status, action, and ok.
 *
 * @param result - Guide install result
 * @returns Formatted text with Guide Install section
 */
export function formatGuideInstall(result: InstallGuideResult): string {
  const body = [
    `target: ${result.target}`,
    `dryRun: ${result.dryRun}`,
    `ok: ${result.ok}`,
    `status: ${result.status}`,
    `action: ${result.action}`,
  ].join("\n");
  return formatListSection("Guide Install", body);
}
