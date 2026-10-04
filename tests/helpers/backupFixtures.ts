/**
 * Shared backup-name fixture: one fixed timestamp so deterministic backup
 * expectations cannot drift between suites. Expected label strings stay
 * local to each suite as contract pins.
 */

/** Fixed timestamp injected into backup creation under test. */
export const FIXED_TIMESTAMP = new Date("2026-01-02T03:04:05.678Z");
