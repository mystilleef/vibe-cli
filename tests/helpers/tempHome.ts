import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHomeContext {
  home: string;
  dataRoot: string;
  cleanup: () => Promise<void>;
}

/**
 * Per-file temp-state harness: tracks every temp home and temp cwd root one
 * test file creates, so a single `cleanup()` restores the shared process
 * state they mutate.
 */
export interface TempHarness {
  /** Create a temp home, register it for cleanup, and return its context. */
  useTempHome(): Promise<TempHomeContext>;
  /** Create a temp working directory registered for cleanup. */
  createCwd(label: string): Promise<string>;
  /** Create a temp working directory, chdir into it, and register cleanup. */
  useCwd(label: string): Promise<string>;
  /** Register an externally created temp directory for cleanup. */
  trackCwd(dir: string): void;
  /** Unregister a tracked directory already removed by the test itself. */
  untrackCwd(dir: string): void;
  /** Restore the original cwd, then remove every registered temp path. */
  cleanup(): Promise<void>;
}

export function createTempHarness(): TempHarness {
  const homes: TempHomeContext[] = [];
  const cwdRoots: string[] = [];
  const originalCwd = process.cwd();
  const createCwd = async (label: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), `vibe-cli-${label}-`));
    cwdRoots.push(dir);
    return dir;
  };
  return {
    async useTempHome() {
      const home = await createTempHome();
      homes.push(home);
      return home;
    },
    createCwd,
    async useCwd(label: string) {
      const dir = await createCwd(label);
      process.chdir(dir);
      return dir;
    },
    trackCwd(dir: string) {
      cwdRoots.push(dir);
    },
    untrackCwd(dir: string) {
      const index = cwdRoots.indexOf(dir);
      if (index !== -1) cwdRoots.splice(index, 1);
    },
    async cleanup() {
      process.chdir(originalCwd);
      await Promise.all(
        cwdRoots
          .splice(0)
          .map((dir) => rm(dir, { recursive: true, force: true })),
      );
      await Promise.all(homes.splice(0).map((home) => home.cleanup()));
    },
  };
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
