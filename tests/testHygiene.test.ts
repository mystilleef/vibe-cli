import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const testsDir = import.meta.dir;

/**
 * Blocking calls stall the worker's event loop, starving hook and test
 * timeouts: a stuck child or sleep hangs the whole run instead of failing
 * one test. Spawn children with `helpers/childProcess.ts` and control time
 * with `setSystemTime` or stubs.
 */
const BLOCKING_CALL =
  /\b(?:spawnSync|execSync|execFileSync|sleepSync)\s*\(|\bAtomics\.wait\s*\(/;

describe("test suite hygiene", () => {
  test("test sources never call blocking process or sleep APIs", async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: testsDir })) {
      const lines = (await Bun.file(join(testsDir, file)).text()).split("\n");
      lines.forEach((line, index) => {
        if (BLOCKING_CALL.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
