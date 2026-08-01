import { describe, expect, test } from "bun:test";
import type { InstallGuideResult } from "../src/tools/guideInstaller.js";
import type { InstallResult } from "../src/tools/skillsInstaller.js";
import {
  formatGuideInstall,
  formatGuideList,
  formatSkillsInstall,
  formatSkillsList,
} from "../src/utils/skillsGuideFormatters.js";

describe("skillsGuideFormatters", () => {
  describe("formatSkillsList", () => {
    test("prints Skills section with aligned name and status columns", () => {
      const result = {
        target: "/home/user/.agents/skills",
        skills: [
          { name: "vibe-check", status: "missing" },
          { name: "vibe-constitution", status: "up-to-date" },
          { name: "vibe-learn", status: "modified" },
        ],
      };

      const formatted = formatSkillsList(result);

      expect(formatted).toContain("Skills");
      expect(formatted).toContain("-----");
      expect(formatted).toContain("name");
      expect(formatted).toContain("status");
      expect(formatted).toContain("vibe-check");
      expect(formatted).toContain("missing");
      expect(formatted).toContain("vibe-constitution");
      expect(formatted).toContain("up-to-date");
      expect(formatted).toContain("vibe-learn");
      expect(formatted).toContain("modified");
    });

    test("renders empty inventories deterministically without malformed rows", () => {
      const result = {
        target: "/home/user/.agents/skills",
        skills: [],
      };

      const formatted = formatSkillsList(result);

      expect(formatted).toContain("Skills");
      expect(formatted).toContain("-----");
      expect(formatted).toContain("(none)");
    });

    test("handles single skill row", () => {
      const result = {
        target: "/home/user/.agents/skills",
        skills: [{ name: "vibe-check", status: "missing" }],
      };

      const formatted = formatSkillsList(result);

      expect(formatted).toContain("Skills");
      expect(formatted).toContain("-----");
      expect(formatted).toContain("name");
      expect(formatted).toContain("status");
      expect(formatted).toContain("vibe-check");
      expect(formatted).toContain("missing");
    });
  });

  describe("formatSkillsInstall", () => {
    test("prints dryRun, force, ok, plus name, status, and action columns", () => {
      const result: InstallResult = {
        target: "/home/user/.agents/skills",
        dryRun: true,
        force: false,
        ok: true,
        skills: [
          {
            name: "vibe-check",
            status: "missing",
            action: "would-install",
          },
          {
            name: "vibe-constitution",
            status: "missing",
            action: "would-install",
          },
        ],
      };

      const formatted = formatSkillsInstall(result);

      expect(formatted).toContain("Skills Install");
      expect(formatted).toContain("------------");
      expect(formatted).toContain("dryRun: true");
      expect(formatted).toContain("force: false");
      expect(formatted).toContain("ok: true");
      expect(formatted).toContain("name");
      expect(formatted).toContain("status");
      expect(formatted).toContain("action");
      expect(formatted).toContain("vibe-check");
      expect(formatted).toContain("missing");
      expect(formatted).toContain("would-install");
    });

    test("includes error column only when failed rows carry detail", () => {
      const result: InstallResult = {
        target: "/home/user/.agents/skills",
        dryRun: false,
        force: false,
        ok: false,
        skills: [
          {
            name: "vibe-check",
            status: "missing",
            action: "installed",
          },
          {
            name: "vibe-constitution",
            status: "missing",
            action: "failed",
            error: "Permission denied",
          },
        ],
      };

      const formatted = formatSkillsInstall(result);

      expect(formatted).toContain("Skills Install");
      expect(formatted).toContain("error");
      expect(formatted).toContain("Permission denied");
      expect(formatted).toContain("failed");
    });

    test("omits error column when no failed rows have detail", () => {
      const result: InstallResult = {
        target: "/home/user/.agents/skills",
        dryRun: false,
        force: false,
        ok: true,
        skills: [
          {
            name: "vibe-check",
            status: "missing",
            action: "installed",
          },
          {
            name: "vibe-constitution",
            status: "up-to-date",
            action: "unchanged",
          },
        ],
      };

      const formatted = formatSkillsInstall(result);

      expect(formatted).toContain("Skills Install");
      expect(formatted).not.toContain("error");
    });

    test("renders empty inventories deterministically", () => {
      const result: InstallResult = {
        target: "/home/user/.agents/skills",
        dryRun: true,
        force: false,
        ok: true,
        skills: [],
      };

      const formatted = formatSkillsInstall(result);

      expect(formatted).toContain("Skills Install");
      expect(formatted).toContain("dryRun: true");
      expect(formatted).toContain("force: false");
      expect(formatted).toContain("ok: true");
      expect(formatted).toContain("(none)");
    });

    test("handles blocked skills with force option", () => {
      const result: InstallResult = {
        target: "/home/user/.agents/skills",
        dryRun: false,
        force: true,
        ok: false,
        skills: [
          {
            name: "vibe-check",
            status: "modified",
            action: "blocked",
          },
        ],
      };

      const formatted = formatSkillsInstall(result);

      expect(formatted).toContain("Skills Install");
      expect(formatted).toContain("force: true");
      expect(formatted).toContain("ok: false");
      expect(formatted).toContain("blocked");
      expect(formatted).toContain("modified");
    });
  });

  describe("formatGuideList", () => {
    test("prints target and status fields", () => {
      const result = {
        target: "/home/user/project",
        status: "missing",
      };

      const formatted = formatGuideList(result);

      expect(formatted).toContain("Guide");
      expect(formatted).toContain("-----");
      expect(formatted).toContain("target: /home/user/project");
      expect(formatted).toContain("status: missing");
    });

    test("handles identical status", () => {
      const result = {
        target: "/home/user/project",
        status: "identical",
      };

      const formatted = formatGuideList(result);

      expect(formatted).toContain("Guide");
      expect(formatted).toContain("target: /home/user/project");
      expect(formatted).toContain("status: identical");
    });

    test("handles outdated status", () => {
      const result = {
        target: "/home/user/project",
        status: "outdated",
      };

      const formatted = formatGuideList(result);

      expect(formatted).toContain("Guide");
      expect(formatted).toContain("target: /home/user/project");
      expect(formatted).toContain("status: outdated");
    });
  });

  describe("formatGuideInstall", () => {
    test("prints target, status, action, and ok fields", () => {
      const result: InstallGuideResult = {
        target: "/home/user/project",
        dryRun: false,
        ok: true,
        status: "missing",
        action: "installed",
      };

      const formatted = formatGuideInstall(result);

      expect(formatted).toContain("Guide Install");
      expect(formatted).toContain("-------------");
      expect(formatted).toContain("target: /home/user/project");
      expect(formatted).toContain("dryRun: false");
      expect(formatted).toContain("ok: true");
      expect(formatted).toContain("status: missing");
      expect(formatted).toContain("action: installed");
    });

    test("handles dry-run mode", () => {
      const result: InstallGuideResult = {
        target: "/home/user/project",
        dryRun: true,
        ok: true,
        status: "missing",
        action: "would-install",
      };

      const formatted = formatGuideInstall(result);

      expect(formatted).toContain("Guide Install");
      expect(formatted).toContain("dryRun: true");
      expect(formatted).toContain("ok: true");
      expect(formatted).toContain("status: missing");
      expect(formatted).toContain("action: would-install");
    });

    test("handles identical status with skip action", () => {
      const result: InstallGuideResult = {
        target: "/home/user/project",
        dryRun: false,
        ok: true,
        status: "identical",
        action: "skipped",
      };

      const formatted = formatGuideInstall(result);

      expect(formatted).toContain("Guide Install");
      expect(formatted).toContain("status: identical");
      expect(formatted).toContain("action: skipped");
    });

    test("handles outdated status with replace action", () => {
      const result: InstallGuideResult = {
        target: "/home/user/project",
        dryRun: false,
        ok: true,
        status: "outdated",
        action: "replaced",
      };

      const formatted = formatGuideInstall(result);

      expect(formatted).toContain("Guide Install");
      expect(formatted).toContain("status: outdated");
      expect(formatted).toContain("action: replaced");
    });
  });
});
