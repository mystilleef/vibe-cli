import { describe, expect, test } from "bun:test";
import type { DoctorSuccessPayload } from "../src/tools/doctor.js";
import type { PruneSuccessPayload } from "../src/tools/prune.js";
import {
  formatDoctorReport,
  formatPruneReport,
} from "../src/utils/doctorPruneFormatters.js";

const FINDINGS_HEADERS = [
  "integrity",
  "foreign keys",
  "free pages",
  "excess backups",
  "latest backup",
  "legacy copies",
  "stranded originals",
] as const;

function makePayload(
  overrides: Partial<DoctorSuccessPayload> = {},
): DoctorSuccessPayload {
  return {
    dryRun: true,
    targets: [],
    findings: {
      integrityCheck: { rows: ["ok"], ok: true },
      foreignKeyCheck: [],
      freelistCount: 0,
      excessBackups: 0,
      latestBackupPath:
        "/home/user/.vibe-cli/backups/vibe-prune-2025-01-07T00:00:00.000Z.db",
      legacyBackups: { candidates: [], rejected: [] },
      strandedOriginals: [],
    },
    backupPath: null,
    appliedCounts: { vacuum: 0, purgeBackups: 0, purgeLegacy: 0 },
    skippedTargets: [],
    failedTargets: [],
    ...overrides,
  };
}

function makeUnavailablePayload(): DoctorSuccessPayload {
  return makePayload({
    findings: {
      integrityCheck: null,
      foreignKeyCheck: null,
      freelistCount: null,
      excessBackups: null,
      latestBackupPath: null,
      legacyBackups: null,
      strandedOriginals: null,
    },
  });
}

/** Safety backup every unblocked apply records before maintenance. */
const SAFETY_BACKUP_PATH = "/data/backups/safety.db";

const FROZEN_CLOCK = { now: new Date("2026-01-01T00:00:00.000Z") };
const DAY_MS = 24 * 60 * 60 * 1000;
const OBSERVATION_PREVIEW_LENGTH = 50;

type PruneCountOverrides = Partial<PruneSuccessPayload["candidateCounts"]>;

function makePrunePayload(
  overrides: Partial<
    Omit<PruneSuccessPayload, "candidateCounts" | "deletedCounts">
  > & {
    candidateCounts?: PruneCountOverrides;
    deletedCounts?: PruneCountOverrides;
  } = {},
): PruneSuccessPayload {
  const { candidateCounts, deletedCounts, ...rest } = overrides;
  return {
    dryRun: true,
    targets: ["learnings", "duplicates", "demos", "sessions"],
    representativeDetails: makePruneDetails(),
    backupPath: null,
    skippedTargets: [],
    failedTargets: [],
    ...rest,
    candidateCounts: {
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
      ...candidateCounts,
    },
    deletedCounts: {
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
      ...deletedCounts,
    },
  };
}

function makePruneDetails(
  overrides: Partial<PruneSuccessPayload["representativeDetails"]> = {},
): PruneSuccessPayload["representativeDetails"] {
  return {
    learnings: [],
    duplicates: [],
    demos: [],
    sessions: [],
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

describe("doctorPruneFormatters", () => {
  describe("formatDoctorReport", () => {
    // ── Mode headers ─────────────────────────────────────────────────────

    test("starts report-only header when payload reports dry run", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(
        report.startsWith("Doctor: report only (apply with --yes)\n"),
      ).toBe(true);
    });

    test("starts applied header when payload records an application", () => {
      const report = formatDoctorReport(
        makePayload({ dryRun: false, targets: ["vacuum"] }),
        true,
      );

      expect(report.startsWith("Doctor: applied\n")).toBe(true);
    });

    test("starts applied header even when failures block maintenance", () => {
      const report = formatDoctorReport(
        makePayload({
          dryRun: false,
          targets: ["vacuum"],
          failedTargets: [{ target: "backup", message: "permission denied" }],
        }),
        false,
      );

      expect(report.startsWith("Doctor: applied\n")).toBe(true);
    });

    // ── Supplied verdict ─────────────────────────────────────────────────

    test("ends with healthy status when supplied verdict is healthy", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(report.endsWith("Status: healthy")).toBe(true);
      expect(report.endsWith("\n")).toBe(false);
    });

    test("ends with unhealthy status when supplied verdict is unhealthy", () => {
      const report = formatDoctorReport(makePayload(), false);

      expect(report.endsWith("Status: unhealthy")).toBe(true);
    });

    test.each([
      {
        label: "unavailable findings under a healthy verdict",
        payload: makeUnavailablePayload(),
        healthy: true,
        status: "Status: healthy",
      },
      {
        label: "populated findings under an unhealthy verdict",
        payload: makePayload(),
        healthy: false,
        status: "Status: unhealthy",
      },
    ])(
      "renders supplied status independent of $label",
      ({ payload, healthy, status }) => {
        const report = formatDoctorReport(payload, healthy);

        expect(report.endsWith(status)).toBe(true);
      },
    );

    test("preserves healthy status for stranded originals when verdict allows", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            strandedOriginals: [
              { artifact: "vibe-log.json", path: "/data/vibe-log.json" },
            ],
          },
        }),
        true,
      );

      expect(report).toContain("kept");
      expect(report.endsWith("Status: healthy")).toBe(true);
    });

    // ── Findings rows ────────────────────────────────────────────────────

    test("renders populated findings rows from supplied values", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            integrityCheck: { rows: ["ok"], ok: true },
            foreignKeyCheck: [{ table: "sessions", rowid: 1 }],
            freelistCount: 12,
            excessBackups: 2,
            latestBackupPath:
              "/home/user/.vibe-cli/backups/vibe-prune-2025-01-07T00:00:00.000Z.db",
            legacyBackups: {
              candidates: [
                { artifact: "vibe-log.json", path: "/data/vibe-log.json.bak" },
              ],
              rejected: [
                {
                  artifact: "history.json",
                  path: "/data/history.json.bak",
                  message: "recorded backup path contains path traversal",
                },
              ],
            },
            strandedOriginals: [
              { artifact: "vibe-log.json", path: "/data/vibe-log.json" },
            ],
          },
        }),
        true,
      );

      expect(report).toMatch(/integrity\s+ok/);
      expect(report).toMatch(/foreign keys\s+1 violation/);
      expect(report).toMatch(/free pages\s+12/);
      expect(report).toMatch(/excess backups\s+2/);
      expect(report).toContain(
        "/home/user/.vibe-cli/backups/vibe-prune-2025-01-07T00:00:00.000Z.db",
      );
      expect(report).toContain("1 candidate, 1 rejected");
      expect(report).toContain("1 original");
    });

    test("renders unavailable for null diagnostics", () => {
      const report = formatDoctorReport(makeUnavailablePayload(), false);

      for (const label of FINDINGS_HEADERS) {
        expect(report).toMatch(new RegExp(`${label}\\s+unavailable`));
      }
    });

    test("renders unavailable for null latest backup path with null excess backups", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            excessBackups: null,
            latestBackupPath: null,
          },
        }),
        false,
      );

      expect(report).toMatch(/latest backup\s+unavailable/);
    });

    test("renders none for null latest backup path with supplied excess backups", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            excessBackups: 2,
            latestBackupPath: null,
          },
        }),
        true,
      );

      expect(report).toMatch(/latest backup\s+none/);
      expect(report).not.toContain("unavailable");
    });

    test("keeps zero and empty findings distinct from unavailable", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(report).toMatch(/foreign keys\s+0 violations/);
      expect(report).toMatch(/free pages\s+0/);
      expect(report).toMatch(/excess backups\s+0/);
      expect(report).toMatch(/legacy copies\s+0 candidates, 0 rejected/);
      expect(report).toMatch(/stranded originals\s+0 originals/);
      expect(report).not.toContain("unavailable");
    });

    test("aligns findings rows deterministically", () => {
      const payload = makePayload();

      const first = formatDoctorReport(payload, true);
      const second = formatDoctorReport(payload, true);

      expect(first).toBe(second);
      for (const label of FINDINGS_HEADERS) {
        expect(first).toMatch(new RegExp(`^${label}\\s{2,}\\S`, "m"));
      }
    });

    // ── Detail sections ──────────────────────────────────────────────────

    test("shows non-ok integrity rows in a detail section", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            integrityCheck: {
              rows: ["Database disk image is malformed", "missing page 42"],
              ok: false,
            },
          },
        }),
        false,
      );

      expect(report).toContain("Integrity\n---------");
      expect(report).toContain("Database disk image is malformed");
      expect(report).toContain("missing page 42");
    });

    test("omits the integrity detail section for ok integrity", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(report).not.toContain("Integrity\n---------");
    });

    test("shows foreign-key table and rowid including null rowid", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            foreignKeyCheck: [
              { table: "interactions", rowid: 7 },
              { table: "constitution_rules", rowid: null },
            ],
          },
        }),
        false,
      );

      expect(report).toContain("Foreign keys\n------------");
      expect(report).toContain("interactions");
      expect(report).toContain("constitution_rules");
      expect(report).toContain("null");
      expect(report).toMatch(/interactions\s+7/);
      expect(report).toMatch(/constitution_rules\s+null/);
    });

    test("shows legacy candidate artifact and path", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            legacyBackups: {
              candidates: [
                {
                  artifact: "vibe-log.json",
                  path: "/home/user/.vibe-cli/vibe-log.json.bak",
                },
              ],
              rejected: [],
            },
          },
        }),
        true,
      );

      expect(report).toContain("Legacy copies\n-------------");
      expect(report).toMatch(
        /vibe-log\.json\s+\/home\/user\/\.vibe-cli\/vibe-log\.json\.bak/,
      );
    });

    test("shows rejected legacy artifact path and supplied message", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            legacyBackups: {
              candidates: [],
              rejected: [
                {
                  artifact: "history.json",
                  path: "sessions/../history.json.bak",
                  message: "recorded backup path contains path traversal",
                },
              ],
            },
          },
        }),
        true,
      );

      expect(report).toContain(
        "Rejected legacy copies\n----------------------",
      );
      expect(report).toContain("history.json");
      expect(report).toContain("sessions/../history.json.bak");
      expect(report).toContain("recorded backup path contains path traversal");
    });

    test("labels stranded originals kept and explains deletion policy", () => {
      const report = formatDoctorReport(
        makePayload({
          findings: {
            ...makePayload().findings,
            strandedOriginals: [
              {
                artifact: "vibe-log.json",
                path: "/home/user/.vibe-cli/vibe-log.json",
              },
            ],
          },
        }),
        true,
      );

      expect(report).toContain("Stranded originals\n------------------");
      expect(report).toMatch(
        /vibe-log\.json\s+\/home\/user\/\.vibe-cli\/vibe-log\.json\s+kept/,
      );
      expect(report).toContain("doctor never deletes originals");
    });

    test("omits empty detail sections", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(report).not.toContain("Integrity\n---------");
      expect(report).not.toContain("Foreign keys\n------------");
      expect(report).not.toContain("Legacy copies\n-------------");
      expect(report).not.toContain(
        "Rejected legacy copies\n----------------------",
      );
      expect(report).not.toContain("Stranded originals\n------------------");
    });

    // ── Maintenance ──────────────────────────────────────────────────────

    test("shows pending confirmation rows for selected targets in report-only mode", () => {
      const report = formatDoctorReport(
        makePayload({
          targets: ["vacuum", "purgeLegacy"],
          skippedTargets: ["purgeBackups"],
          appliedCounts: { vacuum: 9, purgeBackups: 9, purgeLegacy: 9 },
        }),
        true,
      );

      expect(report).toContain("Maintenance\n-----------");
      expect(report).toMatch(/vacuum\s+pending --yes/);
      expect(report).toMatch(/purgeLegacy\s+pending --yes/);
      expect(report).not.toMatch(/\d+ pages/);
      expect(report).not.toMatch(/\d+ files/);
    });

    test("shows supplied applied counts with units including zero", () => {
      const report = formatDoctorReport(
        makePayload({
          dryRun: false,
          targets: ["vacuum", "purgeBackups", "purgeLegacy"],
          backupPath: SAFETY_BACKUP_PATH,
          appliedCounts: { vacuum: 12, purgeBackups: 3, purgeLegacy: 0 },
        }),
        true,
      );

      expect(report).toMatch(/vacuum\s+12 pages/);
      expect(report).toMatch(/purgeBackups\s+3 files/);
      expect(report).toMatch(/purgeLegacy\s+0 files/);
    });

    test("shows singular units for one applied count", () => {
      const report = formatDoctorReport(
        makePayload({
          dryRun: false,
          targets: ["purgeLegacy"],
          skippedTargets: ["vacuum", "purgeBackups"],
          backupPath: SAFETY_BACKUP_PATH,
          appliedCounts: { vacuum: 0, purgeBackups: 0, purgeLegacy: 1 },
        }),
        true,
      );

      expect(report).toMatch(/purgeLegacy\s+1 file\b/);
    });

    test("flags applied counts for failed targets while keeping successful rows plain", () => {
      const report = formatDoctorReport(
        makePayload({
          dryRun: false,
          targets: ["vacuum", "purgeBackups", "purgeLegacy"],
          backupPath: SAFETY_BACKUP_PATH,
          appliedCounts: { vacuum: 0, purgeBackups: 2, purgeLegacy: 1 },
          failedTargets: [
            { target: "vacuum", message: "database is locked" },
            { target: "purgeBackups", message: "permission denied" },
          ],
        }),
        false,
      );

      expect(report).toMatch(/^vacuum\s+0 pages, see failures\s*$/m);
      expect(report).toMatch(/^purgeBackups\s+2 files, see failures\s*$/m);
      expect(report).toMatch(/^purgeLegacy\s+1 file\s*$/m);
    });

    test("shows not run for selected targets when no safety backup precedes apply", () => {
      const report = formatDoctorReport(
        makePayload({
          dryRun: false,
          targets: ["vacuum", "purgeLegacy"],
          skippedTargets: ["purgeBackups"],
          failedTargets: [{ target: "backup", message: "permission denied" }],
        }),
        false,
      );

      expect(report).toMatch(/^vacuum\s+not run\s*$/m);
      expect(report).toMatch(/^purgeLegacy\s+not run\s*$/m);
      expect(report).not.toMatch(/\d+ (pages?|files?)\b/);
    });

    test("omits skipped targets from maintenance rows", () => {
      const report = formatDoctorReport(
        makePayload({
          dryRun: false,
          targets: ["vacuum"],
          skippedTargets: ["purgeBackups", "purgeLegacy"],
          appliedCounts: { vacuum: 0, purgeBackups: 0, purgeLegacy: 0 },
        }),
        true,
      );

      expect(report).toContain("Maintenance\n-----------");
      expect(report).not.toContain("purgeBackups");
      expect(report).not.toContain("purgeLegacy");
    });

    test("omits maintenance without selected targets", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(report).not.toContain("Maintenance\n-----------");
    });

    // ── Backup and failures ──────────────────────────────────────────────

    test("renders non-null backup path verbatim", () => {
      const backupPath =
        "/home/user/.vibe-cli/backups/vibe-doctor 2026-02-03T04:05:06.000Z.db";
      const report = formatDoctorReport(
        makePayload({ dryRun: false, targets: ["vacuum"], backupPath }),
        true,
      );

      expect(report).toContain("Backup\n------");
      expect(report).toContain(backupPath);
    });

    test("omits backup section for a null placeholder", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(report).not.toContain("Backup\n------");
    });

    test("renders every target message failure", () => {
      const report = formatDoctorReport(
        makePayload({
          dryRun: false,
          targets: ["vacuum", "purgeLegacy"],
          failedTargets: [
            { target: "backup", message: "permission denied" },
            { target: "purgeLegacy", message: "legacy cleanup refused" },
          ],
        }),
        false,
      );

      expect(report).toContain("Failures\n--------");
      expect(report).toContain("backup: permission denied");
      expect(report).toContain("purgeLegacy: legacy cleanup refused");
    });

    test("omits failures section when empty", () => {
      const report = formatDoctorReport(makePayload(), true);

      expect(report).not.toContain("Failures\n--------");
    });

    // ── Immutability ─────────────────────────────────────────────────────

    test("leaves frozen populated payload unchanged", () => {
      const payload = deepFreeze(
        makePayload({
          dryRun: false,
          targets: ["vacuum", "purgeBackups", "purgeLegacy"],
          findings: {
            integrityCheck: { rows: ["ok"], ok: true },
            foreignKeyCheck: [{ table: "sessions", rowid: null }],
            freelistCount: 4,
            excessBackups: 1,
            latestBackupPath: "/data/backups/latest.db",
            legacyBackups: {
              candidates: [{ artifact: "a.json", path: "/data/a.json.bak" }],
              rejected: [
                {
                  artifact: "b.json",
                  path: "b.json.bak",
                  message: "refused",
                },
              ],
            },
            strandedOriginals: [{ artifact: "a.json", path: "/data/a.json" }],
          },
          backupPath: SAFETY_BACKUP_PATH,
          appliedCounts: { vacuum: 4, purgeBackups: 1, purgeLegacy: 1 },
          failedTargets: [{ target: "vacuum", message: "database is locked" }],
        }),
      );
      const before = structuredClone(payload);

      const report = formatDoctorReport(payload, false);

      expect(report.endsWith("Status: unhealthy")).toBe(true);
      expect(payload).toEqual(before);
    });
  });

  describe("formatPruneReport", () => {
    // ── Mode headers ─────────────────────────────────────────────────────

    test("starts dry-run header when payload reports dry run", () => {
      const report = formatPruneReport(makePrunePayload(), FROZEN_CLOCK);

      expect(report.startsWith("Prune: dry run (delete with --yes)\n")).toBe(
        true,
      );
    });

    test("starts applied header when payload records an application", () => {
      const report = formatPruneReport(
        makePrunePayload({ dryRun: false, targets: ["learnings"] }),
        FROZEN_CLOCK,
      );

      expect(report.startsWith("Prune: applied\n")).toBe(true);
    });

    test("starts applied header when failures block deletion", () => {
      const report = formatPruneReport(
        makePrunePayload({
          dryRun: false,
          targets: ["learnings"],
          failedTargets: [{ target: "backup", message: "permission denied" }],
        }),
        FROZEN_CLOCK,
      );

      expect(report.startsWith("Prune: applied\n")).toBe(true);
    });

    // ── Targets table ────────────────────────────────────────────────────

    test("shows selected targets with supplied candidate counts including zero", () => {
      const report = formatPruneReport(
        makePrunePayload({
          candidateCounts: {
            learnings: 3,
            duplicates: 0,
            demos: 2,
            sessions: 1,
          },
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Targets\n-------");
      expect(report).toMatch(/^learnings\s+3\s*$/m);
      expect(report).toMatch(/^duplicates\s+0\s*$/m);
      expect(report).toMatch(/^demos\s+2\s*$/m);
      expect(report).toMatch(/^sessions\s+1\s*$/m);
    });

    test("omits skipped targets from the targets table", () => {
      const report = formatPruneReport(
        makePrunePayload({
          targets: ["learnings"],
          skippedTargets: ["duplicates", "demos", "sessions"],
          candidateCounts: {
            learnings: 1,
            duplicates: 9,
            demos: 9,
            sessions: 9,
          },
        }),
        FROZEN_CLOCK,
      );

      expect(report).toMatch(/^learnings\s+1\s*$/m);
      expect(report).not.toContain("duplicates");
      expect(report).not.toContain("demos");
      expect(report).not.toContain("sessions");
    });

    test("omits deletion-count noise in report-only mode", () => {
      const report = formatPruneReport(
        makePrunePayload({
          deletedCounts: {
            learnings: 9,
            duplicates: 9,
            demos: 9,
            sessions: 9,
          },
        }),
        FROZEN_CLOCK,
      );

      expect(report).not.toContain("deleted");
    });

    test("shows supplied deleted counts only in applied mode including zero", () => {
      const report = formatPruneReport(
        makePrunePayload({
          dryRun: false,
          candidateCounts: {
            learnings: 3,
            duplicates: 0,
            demos: 2,
            sessions: 1,
          },
          deletedCounts: {
            learnings: 2,
            duplicates: 0,
            demos: 1,
            sessions: 3,
          },
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("candidates  deleted");
      expect(report).toMatch(/^learnings\s+3\s+2\s*$/m);
      expect(report).toMatch(/^duplicates\s+0\s+0\s*$/m);
      expect(report).toMatch(/^demos\s+2\s+1\s*$/m);
      expect(report).toMatch(/^sessions\s+1\s+3\s*$/m);
    });

    test("omits the targets table without selected targets", () => {
      const report = formatPruneReport(
        makePrunePayload({ targets: [], skippedTargets: ["learnings"] }),
        FROZEN_CLOCK,
      );

      expect(report).not.toContain("Targets\n-------");
    });

    // ── Detail sections ──────────────────────────────────────────────────

    test("shows learning details with identity, preview, and relative age", () => {
      const report = formatPruneReport(
        makePrunePayload({
          candidateCounts: { learnings: 1 },
          representativeDetails: makePruneDetails({
            learnings: [
              {
                id: 12,
                category: "mistake",
                observation: "Short observation.",
                timestamp: FROZEN_CLOCK.now.getTime() - 3 * DAY_MS,
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Learnings\n---------");
      expect(report).toContain("#12 [mistake]");
      expect(report).toContain("Short observation.");
      expect(report).toContain("3d ago");
    });

    test("truncates long observations at the preview length", () => {
      const observation = "x".repeat(OBSERVATION_PREVIEW_LENGTH + 80);
      const report = formatPruneReport(
        makePrunePayload({
          representativeDetails: makePruneDetails({
            learnings: [
              {
                id: 1,
                category: "mistake",
                observation,
                timestamp: FROZEN_CLOCK.now.getTime(),
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain(`${"x".repeat(OBSERVATION_PREVIEW_LENGTH)}…`);
      expect(report).not.toContain("x".repeat(OBSERVATION_PREVIEW_LENGTH + 1));
    });

    test("shows duplicate groups with category, kept id, and every prunable id", () => {
      const report = formatPruneReport(
        makePrunePayload({
          representativeDetails: makePruneDetails({
            duplicates: [
              { category: "dup", keptId: 7, prunableIds: [8, 9, 10] },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Duplicates\n----------");
      expect(report).toContain("[dup]");
      expect(report).toMatch(/^\[dup\]\s+7\s+8, 9, 10\s*$/m);
    });

    test("shows demo details with identity, preview, and demo id when present", () => {
      const report = formatPruneReport(
        makePrunePayload({
          representativeDetails: makePruneDetails({
            demos: [
              {
                id: 4,
                category: "demo-cat",
                observation: "Demo observation.",
                demoId: "demo-1",
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Demos\n-----");
      expect(report).toContain("#4 [demo-cat]");
      expect(report).toContain("Demo observation.");
      expect(report).toContain("demo id");
      expect(report).toContain("demo-1");
    });

    test("omits the demo id column when no shown demo carries one", () => {
      const report = formatPruneReport(
        makePrunePayload({
          representativeDetails: makePruneDetails({
            demos: [
              {
                id: 4,
                category: "demo-cat",
                observation: "Demo observation.",
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("#4 [demo-cat]");
      expect(report).not.toContain("demo id");
    });

    test("shows session details with id, full cwd path, and relative access", () => {
      const report = formatPruneReport(
        makePrunePayload({
          representativeDetails: makePruneDetails({
            sessions: [
              {
                sessionId: "session-1",
                cwd: "/home/user/projects/example",
                lastAccessedAt: new Date(
                  FROZEN_CLOCK.now.getTime() - 2 * DAY_MS,
                ).toISOString(),
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Sessions\n--------");
      expect(report).toContain("session-1");
      expect(report).toContain("/home/user/projects/example");
      expect(report).toContain("2d ago");
    });

    test("renders unknown cwd for null session cwd", () => {
      const report = formatPruneReport(
        makePrunePayload({
          representativeDetails: makePruneDetails({
            sessions: [
              {
                sessionId: "session-2",
                cwd: null,
                lastAccessedAt: new Date(
                  FROZEN_CLOCK.now.getTime() - DAY_MS,
                ).toISOString(),
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("(unknown cwd)");
      expect(report).toContain("1d ago");
    });

    test("shows details only for selected targets", () => {
      const report = formatPruneReport(
        makePrunePayload({
          targets: ["learnings"],
          skippedTargets: ["duplicates", "demos", "sessions"],
          representativeDetails: makePruneDetails({
            learnings: [
              {
                id: 1,
                category: "mistake",
                observation: "Shown.",
                timestamp: FROZEN_CLOCK.now.getTime(),
              },
            ],
            duplicates: [{ category: "dup", keptId: 1, prunableIds: [2] }],
            demos: [
              {
                id: 3,
                category: "demo-cat",
                observation: "Hidden.",
              },
            ],
            sessions: [
              {
                sessionId: "session-1",
                cwd: "/home/user/project",
                lastAccessedAt: FROZEN_CLOCK.now.toISOString(),
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Learnings\n---------");
      expect(report).not.toContain("Duplicates\n----------");
      expect(report).not.toContain("Demos\n-----");
      expect(report).not.toContain("Sessions\n--------");
    });

    test("omits empty detail sections", () => {
      const report = formatPruneReport(makePrunePayload(), FROZEN_CLOCK);

      expect(report).not.toContain("Learnings\n---------");
      expect(report).not.toContain("Duplicates\n----------");
      expect(report).not.toContain("Demos\n-----");
      expect(report).not.toContain("Sessions\n--------");
      expect(report).not.toMatch(/\+\d+ more/);
    });

    // ── Remainder suffixes ───────────────────────────────────────────────

    test("appends a positive remainder after shown learnings", () => {
      const learnings = Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        category: "mistake",
        observation: `Observation ${index + 1}.`,
        timestamp: FROZEN_CLOCK.now.getTime(),
      }));
      const report = formatPruneReport(
        makePrunePayload({
          candidateCounts: { learnings: 8 },
          representativeDetails: makePruneDetails({ learnings }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("+3 more");
    });

    test("appends no suffix for an exact-zero remainder", () => {
      const learnings = Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        category: "mistake",
        observation: `Observation ${index + 1}.`,
        timestamp: FROZEN_CLOCK.now.getTime(),
      }));
      const report = formatPruneReport(
        makePrunePayload({
          candidateCounts: { learnings: 5 },
          representativeDetails: makePruneDetails({ learnings }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("#5 [mistake]");
      expect(report).not.toContain("more");
    });

    test("subtracts shown records from demo and session candidate counts", () => {
      const report = formatPruneReport(
        makePrunePayload({
          candidateCounts: { demos: 7, sessions: 3 },
          representativeDetails: makePruneDetails({
            demos: [
              {
                id: 1,
                category: "demo-cat",
                observation: "One.",
              },
              {
                id: 2,
                category: "demo-cat",
                observation: "Two.",
              },
            ],
            sessions: [
              {
                sessionId: "session-1",
                cwd: null,
                lastAccessedAt: FROZEN_CLOCK.now.toISOString(),
              },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("+5 more");
      expect(report).toContain("+2 more");
    });

    test("labels duplicate remainders entries using prunable-id arithmetic", () => {
      const report = formatPruneReport(
        makePrunePayload({
          candidateCounts: { duplicates: 12 },
          representativeDetails: makePruneDetails({
            duplicates: [
              { category: "dup", keptId: 1, prunableIds: [2, 3] },
              { category: "dup", keptId: 4, prunableIds: [5, 6, 7] },
            ],
          }),
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("+7 more entries");
      expect(report).not.toContain("+10 more");
    });

    // ── Backup and failures ──────────────────────────────────────────────

    test("renders non-null backup path verbatim", () => {
      const backupPath =
        "/home/user/.vibe-cli/backups/vibe-prune-2026-02-03T04-05-06-789Z.db";
      const report = formatPruneReport(
        makePrunePayload({ dryRun: false, backupPath }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Backup\n------");
      expect(report).toContain(backupPath);
    });

    test("omits backup section for a null placeholder", () => {
      const report = formatPruneReport(makePrunePayload(), FROZEN_CLOCK);

      expect(report).not.toContain("Backup\n------");
    });

    test("renders every target message failure", () => {
      const report = formatPruneReport(
        makePrunePayload({
          dryRun: false,
          targets: ["learnings", "sessions"],
          failedTargets: [
            { target: "backup", message: "permission denied" },
            { target: "sessions", message: "database is locked" },
          ],
        }),
        FROZEN_CLOCK,
      );

      expect(report).toContain("Failures\n--------");
      expect(report).toContain("backup: permission denied");
      expect(report).toContain("sessions: database is locked");
    });

    test("omits failures section when empty", () => {
      const report = formatPruneReport(makePrunePayload(), FROZEN_CLOCK);

      expect(report).not.toContain("Failures\n--------");
    });

    // ── Immutability and determinism ─────────────────────────────────────

    test("leaves frozen populated payload unchanged", () => {
      const payload = deepFreeze(
        makePrunePayload({
          dryRun: false,
          candidateCounts: {
            learnings: 6,
            duplicates: 3,
            demos: 1,
            sessions: 2,
          },
          representativeDetails: makePruneDetails({
            learnings: [
              {
                id: 1,
                category: "mistake",
                observation: "One.",
                timestamp: FROZEN_CLOCK.now.getTime() - DAY_MS,
              },
              {
                id: 2,
                category: "success",
                observation: "Two.",
                timestamp: FROZEN_CLOCK.now.getTime() - 2 * DAY_MS,
              },
            ],
            duplicates: [{ category: "dup", keptId: 3, prunableIds: [4, 5] }],
            demos: [
              {
                id: 6,
                category: "demo-cat",
                observation: "Six.",
                demoId: "demo-6",
              },
            ],
            sessions: [
              {
                sessionId: "session-1",
                cwd: "/home/user/project",
                lastAccessedAt: FROZEN_CLOCK.now.toISOString(),
              },
            ],
          }),
          backupPath: "/home/user/.vibe-cli/backups/safety.db",
          deletedCounts: { learnings: 1, duplicates: 2, demos: 1, sessions: 0 },
          failedTargets: [
            { target: "sessions", message: "database is locked" },
          ],
        }),
      );
      const before = structuredClone(payload);

      const report = formatPruneReport(payload, FROZEN_CLOCK);

      expect(report.startsWith("Prune: applied\n")).toBe(true);
      expect(payload).toEqual(before);
    });

    test("formats deterministically for the same payload and clock", () => {
      const payload = makePrunePayload({
        candidateCounts: { learnings: 2 },
        representativeDetails: makePruneDetails({
          learnings: [
            {
              id: 1,
              category: "mistake",
              observation: "One.",
              timestamp: FROZEN_CLOCK.now.getTime() - 5 * DAY_MS,
            },
          ],
        }),
      });

      const first = formatPruneReport(payload, FROZEN_CLOCK);
      const second = formatPruneReport(payload, FROZEN_CLOCK);

      expect(first).toBe(second);
      expect(first).toContain("5d ago");
    });
  });
});
