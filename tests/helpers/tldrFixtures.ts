/**
 * Shared tldr contract fixture: the canonical command list both tldr
 * suites expect the cheat sheet to cover, so page expectations cannot
 * drift between suites.
 */

/** Every CLI command the tldr page must show. */
export const EXPECTED_COMMANDS: string[] = [
  "vibe settings install",
  "vibe verify",
  "vibe skills install --target ~/.claude/skills",
  "vibe guide install",
  "vibe demo",
  "vibe list all",
  "vibe list learnings --type mistake",
  'vibe check --goal "{{goal}}" --plan "{{steps}}"',
  "vibe doctor",
  "vibe prune --duplicates",
  "vibe prune --duplicates --yes",
  "vibe doctor --json",
];
