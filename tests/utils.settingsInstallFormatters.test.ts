import { describe, expect, test } from "bun:test";
import type { InstallSettingsResult } from "../src/tools/settingsInstaller.js";
import {
  formatSettingsInstall,
  maybeAppendProviderGuidance,
} from "../src/utils/settingsInstallFormatters.js";

const baseResult: InstallSettingsResult = {
  destination: "/home/user/.vibe-cli/settings.json",
  dryRun: false,
  force: false,
  ok: true,
  status: "missing",
  action: "installed",
};

/** Extract the rendered value for a summary label from formatted output. */
function fieldValue(formatted: string, label: string): string | undefined {
  const line = formatted
    .split("\n")
    .find((candidate) => candidate.startsWith(label));
  return line?.split(":").slice(1).join(":").trim();
}

describe("settingsInstallFormatters", () => {
  describe("formatSettingsInstall", () => {
    test("prints Settings Install section with destination path", () => {
      const formatted = formatSettingsInstall(baseResult);

      expect(formatted).toContain("Settings Install");
      expect(formatted).toContain("----------------");
      expect(formatted).toContain(
        "destination: /home/user/.vibe-cli/settings.json",
      );
      expect(fieldValue(formatted, "dryRun")).toBe("false");
      expect(fieldValue(formatted, "force")).toBe("false");
      expect(fieldValue(formatted, "ok")).toBe("true");
      expect(fieldValue(formatted, "status")).toBe("missing");
      expect(fieldValue(formatted, "action")).toBe("installed");
    });

    test("aligns summary fields to a shared value column", () => {
      const formatted = formatSettingsInstall(baseResult);

      const labelLines = formatted
        .split("\n")
        .filter((line) =>
          /^(destination|dryRun|force|ok|status|action)\s*:/.test(line),
        );
      expect(labelLines).toHaveLength(6);
      const valueColumns = labelLines.map((line) => line.indexOf(":"));
      expect(new Set(valueColumns).size).toBe(1);
    });
  });

  describe("maybeAppendProviderGuidance", () => {
    test("appends provider-key guidance for installed", () => {
      const text = formatSettingsInstall(baseResult);

      expect(maybeAppendProviderGuidance(baseResult, text)).toContain(
        "provider API key",
      );
    });

    test("appends provider-key guidance for replaced", () => {
      const result: InstallSettingsResult = {
        ...baseResult,
        status: "present",
        action: "replaced",
      };

      expect(maybeAppendProviderGuidance(result, "text")).toContain(
        "provider API key",
      );
    });

    test("omits provider-key guidance for skipped actions", () => {
      const result: InstallSettingsResult = {
        ...baseResult,
        status: "present",
        action: "skipped",
      };

      expect(maybeAppendProviderGuidance(result, "text")).toBe("text");
    });
  });

  test("formatter module exposes only command-required rendering", async () => {
    const module = await import("../src/utils/settingsInstallFormatters.js");

    expect(Object.keys(module).sort()).toEqual([
      "formatSettingsInstall",
      "maybeAppendProviderGuidance",
    ]);
  });
});
