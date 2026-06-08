// fallow-ignore-file unused-file
/**
 * Preload helper: captures the input object passed to runPrune() and
 * writes it to the file named in VIBE_PRUNE_CAPTURE.
 *
 * Uses Bun.plugin to wrap the prune module's runPrune export.
 */
const capturePath = process.env["VIBE_PRUNE_CAPTURE"];

if (capturePath) {
  const path = require("node:path");
  const fs = require("node:fs");
  const prunePath = path.resolve(process.cwd(), "src/tools/prune.ts");

  Bun.plugin({
    name: "capture-prune-input",
    setup(build: Bun.PluginBuilder) {
      build.onLoad(
        {
          filter: new RegExp(prunePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        },
        () => {
          const original = fs.readFileSync(prunePath, "utf-8");
          const wrapped = `${original}

// Injected by capturePruneInput preload
;(function() {
  const _orig = runPrune;
  runPrune = function(input) {
    require("node:fs").writeFileSync(
      process.env.VIBE_PRUNE_CAPTURE,
      JSON.stringify(input),
      "utf-8"
    );
    return _orig(input);
  };
})();
`;
          return { contents: wrapped, loader: "ts" };
        },
      );
    },
  });
}
