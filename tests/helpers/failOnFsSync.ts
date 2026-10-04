/**
 * Shared spies for synchronous `fs` path methods that must fail with an
 * errno error. Matching paths throw; everything else passes through to the
 * real implementation. Each helper returns its restore function.
 */
import { spyOn } from "bun:test";

type ErrnoCode = NonNullable<NodeJS.ErrnoException["code"]>;

function errnoError(
  code: ErrnoCode,
  op: string,
  path: string,
): NodeJS.ErrnoException {
  const err = new Error(
    `${code}: injected failure, ${op} '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Fail `fs.lstatSync` with an errno error for paths `match` accepts. */
export async function failOnLstatSync(
  match: (path: string) => boolean,
  code: ErrnoCode,
): Promise<() => void> {
  const fsModule = await import("node:fs");
  const original = fsModule.lstatSync;
  const spy = spyOn(fsModule, "lstatSync");
  spy.mockImplementation(((p: Parameters<typeof fsModule.lstatSync>[0]) => {
    const path = String(p);
    if (match(path)) throw errnoError(code, "lstat", path);
    return original(p);
  }) as typeof fsModule.lstatSync);
  return () => spy.mockRestore();
}

/** Fail `fs.readdirSync` with an errno error for paths `match` accepts. */
export async function failOnReaddirSync(
  match: (path: string) => boolean,
  code: ErrnoCode,
): Promise<() => void> {
  const fsModule = await import("node:fs");
  const original = fsModule.readdirSync;
  const spy = spyOn(fsModule, "readdirSync");
  spy.mockImplementation(((p: Parameters<typeof fsModule.readdirSync>[0]) => {
    const path = String(p);
    if (match(path)) throw errnoError(code, "scandir", path);
    return original(p);
  }) as typeof fsModule.readdirSync);
  return () => spy.mockRestore();
}
