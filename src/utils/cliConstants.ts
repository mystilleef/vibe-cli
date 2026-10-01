/**
 * Shared CLI surface constants.
 *
 * Canonical flag names and descriptions used by Commander option registration
 * and the agent-facing schema payload so both layers stay in sync.
 */

export const JSON_OPTION_FLAG = "--json";
export const JSON_OPTION_DESCRIPTION =
  "Emit machine-readable JSON instead of pretty text";

export const SKILLS_TARGET_DESCRIPTION = "path (default: ~/.agents/skills)";
export const CWD_TARGET_DESCRIPTION = "path (default: cwd)";
export const DRY_RUN_DESCRIPTION = "plan without writing target files";
export const SKILLS_FORCE_DESCRIPTION =
  "replace every existing bundled target, including hash matches";
export const SETTINGS_FORCE_DESCRIPTION = "replace existing settings.json";
export const PROVIDER_OPTION_DESCRIPTION = "settings provider entry name";
