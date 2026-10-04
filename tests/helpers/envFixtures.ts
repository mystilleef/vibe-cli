/**
 * Shared environment-mutation fixture: one definition so override and
 * restore semantics cannot drift between suites.
 */
import { spyOn } from "bun:test";

/**
 * Temporarily apply env var overrides (delete on `undefined`), run `fn`, then
 * restore exactly the touched keys to their prior values.
 */
export async function withMutatedEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Run `fn` in the "home directory cannot be determined" scenario: `HOME`
 * removed and `os.homedir()` stubbed empty, both restored afterwards.
 */
export async function withUnavailableHome<T>(fn: () => Promise<T>): Promise<T> {
  return withMutatedEnv({ HOME: undefined }, async () => {
    const osModule = await import("node:os");
    const spy = spyOn(osModule, "homedir");
    spy.mockReturnValue("");
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  });
}
