import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHomeContext {
  home: string;
  dataRoot: string;
  cleanup: () => Promise<void>;
}

export async function createTempHome(): Promise<TempHomeContext> {
  const previousHome = process.env["HOME"];
  const home = await mkdtemp(join(tmpdir(), "vibe-cli-test-"));
  const dataRoot = join(home, ".vibe-cli");

  process.env["HOME"] = home;

  return {
    home,
    dataRoot,
    async cleanup() {
      if (previousHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previousHome;
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}
