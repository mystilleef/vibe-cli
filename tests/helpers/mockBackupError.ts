/**
 * Preload: intercepts createPruneDatabaseBackup for per-test error injection.
 * Tests set globalThis.__VIBE_BACKUP_ERROR to the message to throw;
 * when unset, the original function runs normally.
 */
import fs from "node:fs";
import path from "node:path";

const storagePath = path.resolve(process.cwd(), "src/utils/pruneStorage.ts");

Bun.plugin({
  name: "mock-backup-error",
  setup(build: Bun.PluginBuilder) {
    build.onLoad(
      {
        filter: new RegExp(storagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      },
      () => ({
        contents: `${fs.readFileSync(storagePath, "utf-8")}
(function() {
  var _orig = createPruneDatabaseBackup;
  createPruneDatabaseBackup = function(opts) {
    var msg = globalThis.__VIBE_BACKUP_ERROR;
    if (msg) throw new Error(msg);
    return _orig(opts);
  };
})();
`,
        loader: "ts",
      }),
    );
  },
});
