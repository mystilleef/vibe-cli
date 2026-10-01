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

/** Detail sections for non-empty findings; empty findings stay hidden. */
function findingDetailSections(findings: DoctorFindings): string[] {
  const sections: string[] = [];

  const integrity = findings.integrityCheck;
  if (integrity !== null && !integrity.ok && integrity.rows.length > 0) {
    sections.push(formatListSection("Integrity", integrity.rows.join("\n")));
  }

  const violations = findings.foreignKeyCheck;
  if (violations !== null && violations.length > 0) {
    sections.push(
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
    );
  }

  const legacy = findings.legacyBackups;
  if (legacy !== null && legacy.candidates.length > 0) {
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
  if (legacy !== null && legacy.rejected.length > 0) {
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

  const stranded = findings.strandedOriginals;
  if (stranded !== null && stranded.length > 0) {
    sections.push(
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
    );
  }

  return sections;
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

/**
 * Detail sections for selected targets. Representatives arrive capped by the
 * payload, so every supplied record renders.
 */
function pruneDetailSections(
  payload: PruneSuccessPayload,
  clock: ListClock,
): string[] {
  const sections: string[] = [];
  const { learnings, duplicates, demos, sessions } =
    payload.representativeDetails;
  const selected = (target: PruneSuccessPayload["targets"][number]) =>
    payload.targets.includes(target);

  if (selected("learnings") && learnings.length > 0) {
    sections.push(
      detailSection(
        "Learnings",
        ["entry", "observation", "age"],
        learnings.map((entry) => [
          `#${entry.id} [${entry.category}]`,
          truncateText(entry.observation, OBSERVATION_PREVIEW_LENGTH),
          formatRelativeTime(entry.timestamp, clock),
        ]),
        payload.candidateCounts.learnings - learnings.length,
      ),
    );
  }

  if (selected("duplicates") && duplicates.length > 0) {
    // Duplicate candidate counts measure prunable entries, not groups.
    const shownEntries = duplicates.reduce(
      (total, group) => total + group.prunableIds.length,
      0,
    );
    sections.push(
      detailSection(
        "Duplicates",
        ["category", "kept", "prunable"],
        duplicates.map((group) => [
          `[${group.category}]`,
          String(group.keptId),
          group.prunableIds.join(", "),
        ]),
        payload.candidateCounts.duplicates - shownEntries,
        "entries",
      ),
    );
  }

  if (selected("demos") && demos.length > 0) {
    const showDemoId = demos.some((demo) => demo.demoId !== undefined);
    sections.push(
      detailSection(
        "Demos",
        showDemoId
          ? ["demo", "observation", "demo id"]
          : ["demo", "observation"],
        demos.map((demo) => [
          `#${demo.id} [${demo.category}]`,
          truncateText(demo.observation, OBSERVATION_PREVIEW_LENGTH),
          ...(showDemoId ? [demo.demoId ?? ""] : []),
        ]),
        payload.candidateCounts.demos - demos.length,
      ),
    );
  }

  if (selected("sessions") && sessions.length > 0) {
    sections.push(
      detailSection(
        "Sessions",
        ["session", "cwd", "last access"],
        sessions.map((session) => [
          session.sessionId,
          session.cwd ?? "(unknown cwd)",
          formatRelativeTime(session.lastAccessedAt, clock),
        ]),
        payload.candidateCounts.sessions - sessions.length,
      ),
    );
  }

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
