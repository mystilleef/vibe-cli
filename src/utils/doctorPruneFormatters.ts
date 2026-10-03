/**
 * Pure presentation for doctor and prune success payloads.
 *
 * Formatters consume supplied payload fields only: no storage access, no
 * health or policy recomputation, and no payload mutation. JSON emission
 * stays in `src/cli.ts`.
 */

import type { DoctorSuccessPayload } from "../tools/doctor.js";
import type { PruneSuccessPayload } from "../tools/prune.js";
import type { DoctorFindings } from "./doctorStorage.js";
import type { ListClock } from "./listDataTypes.js";
import {
  formatAlignedRows,
  formatListSection,
  formatRelativeTime,
  truncateText,
} from "./listDataUtilsFormatting.js";

/** Placeholder for diagnostics the payload marks unavailable. */
const UNAVAILABLE = "unavailable";

/** Placeholder for an available diagnostic with no recorded path. */
const NONE = "none";

/** Render a count with a singular/plural noun. */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One findings label/value row. */
function findingsRows(findings: DoctorFindings): string[][] {
  const integrity =
    findings.integrityCheck === null
      ? UNAVAILABLE
      : findings.integrityCheck.ok
        ? "ok"
        : "failed";
  const foreignKeys =
    findings.foreignKeyCheck === null
      ? UNAVAILABLE
      : countOf(findings.foreignKeyCheck.length, "violation");
  const freePages =
    findings.freelistCount === null
      ? UNAVAILABLE
      : String(findings.freelistCount);
  const excessBackups =
    findings.excessBackups === null
      ? UNAVAILABLE
      : String(findings.excessBackups);
  // A missing path is only unknowable while backup inventory is unavailable.
  const latestBackup =
    findings.latestBackupPath ??
    (findings.excessBackups === null ? UNAVAILABLE : NONE);
  const legacyCopies =
    findings.legacyBackups === null
      ? UNAVAILABLE
      : `${countOf(findings.legacyBackups.candidates.length, "candidate")}, ${
          findings.legacyBackups.rejected.length
        } rejected`;
  const strandedOriginals =
    findings.strandedOriginals === null
      ? UNAVAILABLE
      : countOf(findings.strandedOriginals.length, "original");

  return [
    ["integrity", integrity],
    ["foreign keys", foreignKeys],
    ["free pages", freePages],
    ["excess backups", excessBackups],
    ["latest backup", latestBackup],
    ["legacy copies", legacyCopies],
    ["stranded originals", strandedOriginals],
  ];
}

/** Integrity failure detail; healthy or rowless findings stay hidden. */
function integrityDetailSection(
  integrity: DoctorFindings["integrityCheck"],
): string[] {
  if (integrity === null || integrity.ok || integrity.rows.length === 0) {
    return [];
  }
  return [formatListSection("Integrity", integrity.rows.join("\n"))];
}

/** Foreign-key violation table; findings without violations stay hidden. */
function foreignKeyDetailSection(
  violations: DoctorFindings["foreignKeyCheck"],
): string[] {
  if (violations === null || violations.length === 0) return [];
  return [
    formatListSection(
      "Foreign keys",
      formatAlignedRows(
        ["table", "rowid"],
        violations.map((violation) => [
          violation.table,
          violation.rowid === null ? "null" : String(violation.rowid),
        ]),
      ),
    ),
  ];
}

/** Legacy-copy tables; candidate and rejected lists render independently. */
function legacyDetailSections(
  legacy: DoctorFindings["legacyBackups"],
): string[] {
  if (legacy === null) return [];
  const sections: string[] = [];
  if (legacy.candidates.length > 0) {
    sections.push(
      formatListSection(
        "Legacy copies",
        formatAlignedRows(
          ["artifact", "path"],
          legacy.candidates.map((record) => [record.artifact, record.path]),
        ),
      ),
    );
  }
  if (legacy.rejected.length > 0) {
    sections.push(
      formatListSection(
        "Rejected legacy copies",
        formatAlignedRows(
          ["artifact", "path", "message"],
          legacy.rejected.map((record) => [
            record.artifact,
            record.path,
            record.message,
          ]),
        ),
      ),
    );
  }
  return sections;
}

/** Stranded-original table; findings without records stay hidden. */
function strandedDetailSection(
  stranded: DoctorFindings["strandedOriginals"],
): string[] {
  if (stranded === null || stranded.length === 0) return [];
  return [
    formatListSection(
      "Stranded originals",
      [
        formatAlignedRows(
          ["artifact", "path", "status"],
          stranded.map((record) => [record.artifact, record.path, "kept"]),
        ),
        "doctor never deletes originals",
      ].join("\n"),
    ),
  ];
}

/** Detail sections for non-empty findings; empty findings stay hidden. */
function findingDetailSections(findings: DoctorFindings): string[] {
  return [
    ...integrityDetailSection(findings.integrityCheck),
    ...foreignKeyDetailSection(findings.foreignKeyCheck),
    ...legacyDetailSections(findings.legacyBackups),
    ...strandedDetailSection(findings.strandedOriginals),
  ];
}

/** Maintenance rows for selected targets only; skipped targets stay hidden. */
function maintenanceSection(payload: DoctorSuccessPayload): string | null {
  if (payload.targets.length === 0) return null;
  const rows = payload.targets.map((target) => [
    target,
    maintenanceOutcome(target, payload),
  ]);
  return formatListSection(
    "Maintenance",
    formatAlignedRows(["target", "outcome"], rows),
  );
}

/**
 * Outcome text for one selected target; applied counts carry their unit and
 * stay visible at zero. Every apply creates a safety backup first, so an
 * applied payload without one means preflight or backup failure blocked
 * every target. Failed targets keep their count because purges continue past
 * per-file failures, and failure entries do not map one-to-one to files.
 */
function maintenanceOutcome(
  target: DoctorSuccessPayload["targets"][number],
  payload: DoctorSuccessPayload,
): string {
  if (payload.dryRun) return "pending --yes";
  if (payload.backupPath === null) return "not run";
  const count = payload.appliedCounts[target];
  const applied =
    target === "vacuum" ? countOf(count, "page") : countOf(count, "file");
  const failed = payload.failedTargets.some(
    (failure) => failure.target === target,
  );
  return failed ? `${applied}, see failures` : applied;
}

/** Backup and failure blocks shared by success-report footers. */
function backupFailureSections(payload: {
  backupPath: string | null;
  failedTargets: readonly { target: string; message: string }[];
}): string[] {
  const sections: string[] = [];
  if (payload.backupPath !== null) {
    sections.push(formatListSection("Backup", payload.backupPath));
  }
  if (payload.failedTargets.length > 0) {
    sections.push(
      formatListSection(
        "Failures",
        payload.failedTargets
          .map((failure) => `${failure.target}: ${failure.message}`)
          .join("\n"),
      ),
    );
  }
  return sections;
}

/**
 * Format one doctor success payload as deterministic, uncolored text.
 *
 * `healthy` is the supplied verdict; the report never recomputes it.
 */
export function formatDoctorReport(
  payload: DoctorSuccessPayload,
  healthy: boolean,
): string {
  const blocks = [
    payload.dryRun
      ? "Doctor: report only (apply with --yes)"
      : "Doctor: applied",
    formatListSection(
      "Findings",
      formatAlignedRows(["finding", "value"], findingsRows(payload.findings)),
    ),
    ...findingDetailSections(payload.findings),
  ];

  const maintenance = maintenanceSection(payload);
  if (maintenance !== null) blocks.push(maintenance);

  blocks.push(...backupFailureSections(payload));

  blocks.push(`Status: ${healthy ? "healthy" : "unhealthy"}`);
  return blocks.join("\n\n");
}

/** Observation preview width; keeps typical detail rows within 80 columns. */
const OBSERVATION_PREVIEW_LENGTH = 50;

/**
 * One detail table with an optional `+N more` remainder line.
 * Remainders of zero or less stay hidden.
 */
function detailSection(
  label: string,
  columns: string[],
  rows: string[][],
  remainder: number,
  remainderLabel?: string,
): string {
  const suffix =
    remainder > 0
      ? `\n+${remainder} more${
          remainderLabel === undefined ? "" : ` ${remainderLabel}`
        }`
      : "";
  return formatListSection(
    label,
    `${formatAlignedRows(columns, rows)}${suffix}`,
  );
}

/** Selected-target table; skipped targets and report-only counts stay hidden. */
function pruneTargetsSection(payload: PruneSuccessPayload): string | null {
  if (payload.targets.length === 0) return null;
  const rows = payload.targets.map((target) =>
    payload.dryRun
      ? [target, String(payload.candidateCounts[target])]
      : [
          target,
          String(payload.candidateCounts[target]),
          String(payload.deletedCounts[target]),
        ],
  );
  return formatListSection(
    "Targets",
    formatAlignedRows(
      payload.dryRun
        ? ["target", "candidates"]
        : ["target", "candidates", "deleted"],
      rows,
    ),
  );
}

/** Representative records supplied per prune target. */
type PruneRepresentatives = PruneSuccessPayload["representativeDetails"];

/** Learning candidates preview; unshown candidates stay counted in the remainder. */
function learningDetailSection(
  learnings: PruneRepresentatives["learnings"],
  candidateCount: number,
  clock: ListClock,
): string | null {
  if (learnings.length === 0) return null;
  return detailSection(
    "Learnings",
    ["entry", "observation", "age"],
    learnings.map((entry) => [
      `#${entry.id} [${entry.category}]`,
      truncateText(entry.observation, OBSERVATION_PREVIEW_LENGTH),
      formatRelativeTime(entry.timestamp, clock),
    ]),
    candidateCount - learnings.length,
  );
}

/** Duplicate-group preview; remainder counts unshown entries, not groups. */
function duplicateDetailSection(
  duplicates: PruneRepresentatives["duplicates"],
  candidateCount: number,
): string | null {
  if (duplicates.length === 0) return null;
  const shownEntries = duplicates.reduce(
    (total, group) => total + group.prunableIds.length,
    0,
  );
  return detailSection(
    "Duplicates",
    ["category", "kept", "prunable"],
    duplicates.map((group) => [
      `[${group.category}]`,
      String(group.keptId),
      group.prunableIds.join(", "),
    ]),
    candidateCount - shownEntries,
    "entries",
  );
}

/** Demo candidates preview; the demo-id column appears only when recorded. */
function demoDetailSection(
  demos: PruneRepresentatives["demos"],
  candidateCount: number,
): string | null {
  if (demos.length === 0) return null;
  const showDemoId = demos.some((demo) => demo.demoId !== undefined);
  return detailSection(
    "Demos",
    showDemoId ? ["demo", "observation", "demo id"] : ["demo", "observation"],
    demos.map((demo) => [
      `#${demo.id} [${demo.category}]`,
      truncateText(demo.observation, OBSERVATION_PREVIEW_LENGTH),
      ...(showDemoId ? [demo.demoId ?? ""] : []),
    ]),
    candidateCount - demos.length,
  );
}

/** Expired-session preview; sessions without a cwd render a placeholder. */
function sessionDetailSection(
  sessions: PruneRepresentatives["sessions"],
  candidateCount: number,
  clock: ListClock,
): string | null {
  if (sessions.length === 0) return null;
  return detailSection(
    "Sessions",
    ["session", "cwd", "last access"],
    sessions.map((session) => [
      session.sessionId,
      session.cwd ?? "(unknown cwd)",
      formatRelativeTime(session.lastAccessedAt, clock),
    ]),
    candidateCount - sessions.length,
  );
}

/**
 * Detail sections for selected targets. Representatives arrive capped by the
 * payload, so every supplied record renders.
 */
function pruneDetailSections(
  payload: PruneSuccessPayload,
  clock: ListClock,
): string[] {
  const { learnings, duplicates, demos, sessions } =
    payload.representativeDetails;
  const counts = payload.candidateCounts;
  const sections: string[] = [];
  const add = (
    target: PruneSuccessPayload["targets"][number],
    section: string | null,
  ) => {
    if (payload.targets.includes(target) && section !== null) {
      sections.push(section);
    }
  };

  add("learnings", learningDetailSection(learnings, counts.learnings, clock));
  add("duplicates", duplicateDetailSection(duplicates, counts.duplicates));
  add("demos", demoDetailSection(demos, counts.demos));
  add("sessions", sessionDetailSection(sessions, counts.sessions, clock));

  return sections;
}

/**
 * Format one prune success payload as deterministic, uncolored text.
 *
 * `clock` freezes relative-age rendering; candidates and outcomes stay
 * supplied values without policy or storage access.
 */
export function formatPruneReport(
  payload: PruneSuccessPayload,
  clock: ListClock = {},
): string {
  const blocks = [
    payload.dryRun ? "Prune: dry run (delete with --yes)" : "Prune: applied",
  ];

  const targets = pruneTargetsSection(payload);
  if (targets !== null) blocks.push(targets);
  blocks.push(...pruneDetailSections(payload, clock));

  blocks.push(...backupFailureSections(payload));

  return blocks.join("\n\n");
}
