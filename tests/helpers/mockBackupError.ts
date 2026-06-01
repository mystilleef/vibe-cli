/**
 * Preload: wraps createPruneDatabaseBackup to inject backup errors
 * for coverage. Controlled by VIBE_MOCK_BACKUP_ERROR:
 *   - "memory" → throws "cannot back up an in-memory database"
 *   - "checkpoint" → throws "database checkpoint could not complete"
 */
const backupErrorMode = process.env.VIBE_MOCK_BACKUP_ERROR;
if (backupErrorMode) {
  const fs = require("node:fs");
  const storagePath = require("node:path").resolve(
    process.cwd(),
    "src/utils/storage.ts",
  );

  Bun.plugin({
    name: "mock-backup-error",
    setup(build: Bun.PluginBuilder) {
      build.onLoad(
        {
          filter: new RegExp(
            storagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          ),
        },
        () => {
          const original = fs.readFileSync(storagePath, "utf-8");
          const errorMsg =
            backupErrorMode === "memory"
              ? "cannot back up an in-memory database"
              : "database checkpoint could not complete before backup";
          return {
            contents: `${original}

(function() {
  var _orig = createPruneDatabaseBackup;
  createPruneDatabaseBackup = function(opts) {
    throw new Error(${JSON.stringify(errorMsg)});
  };
})();
`,
            loader: "ts",
          };
        },
      );
    },
  });
}
