// fallow-ignore-file unused-file
/**
 * Preload helper: forces skills inventory/discovery to use the package root
 * named in VIBE_TEST_SKILLS_PACKAGE_ROOT.
 *
 * Wraps computeSkillsInventory and discoverBundledSkills via Bun.plugin so CLI
 * surface tests can exercise empty inventories and source-validation failures
 * without mutating the real package tree.
 */
const packageRoot = process.env["VIBE_TEST_SKILLS_PACKAGE_ROOT"];

if (packageRoot) {
  const path = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  const skillsPath = path.resolve(process.cwd(), "src/utils/skills.ts");

  Bun.plugin({
    name: "skills-package-root",
    setup(build: Bun.PluginBuilder) {
      build.onLoad(
        {
          filter: new RegExp(skillsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        },
        () => {
          const original = fs.readFileSync(skillsPath, "utf-8");
          const wrapped = `${original}

// Injected by skillsPackageRoot preload
;(function () {
  const _discover = discoverBundledSkills;
  discoverBundledSkills = function (options = {}) {
    return _discover({
      ...options,
      packageRoot: process.env.VIBE_TEST_SKILLS_PACKAGE_ROOT ?? options.packageRoot,
    });
  };

  const _inventory = computeSkillsInventory;
  computeSkillsInventory = function (targetRoot, options = {}) {
    return _inventory(targetRoot, {
      ...options,
      packageRoot: process.env.VIBE_TEST_SKILLS_PACKAGE_ROOT ?? options.packageRoot,
    });
  };
})();
`;
          return { contents: wrapped, loader: "ts" };
        },
      );
    },
  });
}
