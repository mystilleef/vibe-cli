# Testing

`Bun` ships a built-in test runner, `bun:test`, with `Jest`-compatible
`APIs`, native `TypeScript`, snapshots, mocks, and fake timers.

## Requirements

- `Bun` 1.4.3 or later; check with `bun --version`.
  - Older releases accept `--check` but silently skip type checking;
    upgrade or run `tsc --noEmit` instead.
- `bun:test` exports `jest` and `vi` as built-in compatibility objects;
  never install `jest`, `vitest`, or `@types/jest`.
  - `@testing-library/jest-dom` runs without them.

## Scope

- Prefer unit tests.
- Escalate to integration tests only when behavior crosses a system
  boundary.
- Reserve end-to-end tests for critical user flows.

## Commands

```bash
bun test                        # Run every discovered test file
bun test src/parser             # Run files whose paths match a filter
bun test -t "parses ports"      # Run tests whose names match a regex
bun test --check                # Type-check tests and imports, then run
bun test --isolate              # Give each file fresh globals and modules
bun test --parallel             # Run files across workers; implies --isolate
bun test --randomize            # Shuffle test order; prints the seed
bun test --randomize --seed=42  # Replay a shuffled order
bun test --rerun-each=20        # Rerun each file to expose flakiness
bun test --coverage             # Report coverage
bun test --update-snapshots     # Rewrite stored snapshots (-u)
```

- Discovery: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`.
- A `-t` pattern matching zero tests fails the run.
- `--check` requires `@types/bun` and `"types": ["bun"]` in
  `tsconfig.json`; type errors stop the run.
- `CI=true` fails runs containing `.only` or unrecorded snapshots.

## Configuration

```toml
# bunfig.toml
[test]
preload = ["./test/setup.ts"] # Runs before every test file
coverageThreshold = 0.9       # Fails --coverage runs below 90%
```

Restore shared state after every test from the preload file:

```ts
// test/setup.ts
import {afterEach, jest, mock, setSystemTime} from "bun:test";

afterEach(() => {
  mock.restore(); // Restores spied methods
  mock.clearAllMocks(); // Clears recorded calls on every mock
  jest.useRealTimers();
  setSystemTime();
});
```

## Structure

- Name tests `verb + subject + condition + outcome`.
- Group related cases with `describe`.
- Extract repeated setup into helpers or hooks; keep bodies lean.
- Extend existing suites for established units; add files only for new
  modules or distinct boundaries.
- Use `test.each` for input tables sharing one invariant; never
  copy-paste test bodies.

```ts
import {describe, expect, test} from "bun:test";
import {parsePort} from "./config.ts";

describe("parsePort", () => {
  test.each([
    ["80", 80],
    ["65535", 65535]
  ])("parses %p as port %p", (input, port) => {
    expect(parsePort(input)).toBe(port);
  });

  test.each(["0", "65536", "-1"])("throws RangeError for %p", input => {
    expect(() => parsePort(input)).toThrow(RangeError);
  });
});
```

| Token  | Interpolates           |
| :----- | :--------------------- |
| `%p`   | Pretty-formatted value |
| `%s`   | String                 |
| `%d`   | Number                 |
| `%i`   | Integer                |
| `%f`   | Float                  |
| `%j`   | `JSON`                 |
| `%o`   | Object                 |
| `%#`   | Case index             |
| `%%`   | Literal `%`            |
| `$key` | Object row property    |

## Modifiers

| Modifier                                | Rule                                             |
| :-------------------------------------- | :----------------------------------------------- |
| `test.only`, `describe.only`            | Local focus only; never commit                   |
| `test.skip`, `describe.skip`            | Never commit                                     |
| `test.todo`                             | Planned coverage; `bun test --todo` runs it      |
| `test.failing`                          | Known bug; fails once fixed, prompting removal   |
| `test.if`, `test.skipIf`, `test.todoIf` | Environment guards; `describe` supports them too |

Guard tests needing optional environment:

```ts
const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(!databaseUrl)("OrderRepository", () => {
  // Integration tests against a real database
});
```

## Isolation

- Each test passes alone and in any order; verify with `--randomize`.
- `bun test` shares one process across files by default; globals, the
  module cache, and `mock.module()` replacements leak between files.
  - Run with `--isolate` or `--parallel` for fresh globals and modules
    per file.
- Reset shared registries and stores in `beforeEach`.
- Restore mutated globals (`process.env`, `globalThis`) in `afterEach`.

## CI parity

| Hazard                           | Remedy                                                       |
| :------------------------------- | :----------------------------------------------------------- |
| Absolute paths                   | `join(import.meta.dir, "fixtures", "input.json")`            |
| Read-only working directory      | Temp directories under `tmpdir()`                            |
| Undeclared environment variables | Defaults or `skipIf` guards; `bun test` sets `NODE_ENV=test` |
| Running services                 | Mock in unit tests; skip-guard integration tests             |
| Live network                     | Mock `fetch` and `node:dns`; bind `Bun.serve({port: 0})`     |
| Timezone                         | Runs in `UTC` unless `TZ` overrides; freeze time             |
| Locale                           | Pass explicit locales: `toLocaleString("en-US")`             |
| OS commands, separators          | `node:path` helpers; spawn `process.execPath`                |
| Case sensitivity                 | Normalize paths and filenames explicitly                     |

Create and remove temp directories per test:

```ts
import {afterEach, beforeEach} from "bun:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "app-test-"));
});

afterEach(async () => {
  await rm(workDir, {recursive: true, force: true});
});
```

Never assume runner privilege; root and `CAP_DAC_OVERRIDE` bypass mode
bits in containers:

- Simulate `EACCES`/`EPERM` in unit tests with stubs; never via `chmod`.
- Never assert mode-bit denial in integration or end-to-end tests.
- Assert permission-setting behavior through `stat` mode values.

## Asynchronous

- Use `async`/`await`; avoid `done` callbacks.
- Always `await` `.resolves` and `.rejects` assertions.
- Await events through promises; never poll or sleep:

```ts
test("emits drained after the last job completes", async () => {
  const queue = new JobQueue();
  const {promise: drained, resolve} = Promise.withResolvers<void>();
  queue.once("drained", resolve);

  queue.push(async () => {});
  await drained;

  expect(queue.size).toBe(0);
});
```

- Drive cancellation with `AbortController`; never rely on real
  timeouts:

```ts
test("rejects with AbortError when the caller aborts", async () => {
  const controller = new AbortController();
  const pending = exportReport({signal: controller.signal});

  controller.abort();

  await expect(pending).rejects.toMatchObject({name: "AbortError"});
});
```

### Timeouts, retries, and repeats

- Set timeouts via the third argument (milliseconds) or `--timeout`;
  default `5000`.
- Never mask flakiness with `retry` (`{retry: n}`, `--retry`); fix the
  root cause.
- Expose flakiness with `{repeats: n}` (runs `n + 1` times) or
  `--rerun-each=n`.
- `retry` and `repeats` conflict; setting both fails the file.

```ts
test(
  "drains every job under concurrent pushes",
  async () => {
    const queue = new JobQueue();
    const {promise: drained, resolve} = Promise.withResolvers<void>();
    queue.once("drained", resolve);

    queue.push(async () => {});
    queue.push(async () => {});
    await drained;

    expect(queue.completed).toBe(2);
  },
  {repeats: 50}
);
```

## Time and timers

Use fake timers for time-dependent logic; never introduce real delays:

```ts
import {expect, jest, mock, test} from "bun:test";

test("retries the request after one second of backoff", () => {
  jest.useFakeTimers({now: new Date("2026-01-01T00:00:00.000Z")});
  const send = mock();

  scheduleRetry(send, 1000);
  jest.advanceTimersByTime(999);
  expect(send).not.toHaveBeenCalled();

  jest.advanceTimersByTime(1);
  expect(send).toHaveBeenCalledTimes(1);
});
```

- `jest.useFakeTimers()` controls `setTimeout`, `setInterval`, and
  `Date`; `{now}` sets the starting clock.
- Advance with `advanceTimersByTime`, `runOnlyPendingTimers`, or
  `runAllTimers`.
- `setSystemTime(date)` moves `Date` and `Intl` clocks without faking
  timers; `setSystemTime()` restores real time.
- Bun lacks `advanceTimersByTimeAsync` and `vi.setSystemTime`; use
  `jest.setSystemTime` or `setSystemTime`.
- Zone-specific cases set `process.env.TZ` at runtime and restore it in
  `afterEach`.

## Mocking

- Unit tests: mock every external process, I/O call, network request,
  and event source.
- Integration and end-to-end tests: use real dependencies; never mix in
  mocks.
- Prefer fakes over spies, spies over stubs.
- Restore every mock after each test; see `test/setup.ts`.

### Fakes

Inject collaborators; pass working in-memory implementations:

```ts
class MemoryStore implements Store {
  readonly #items = new Map<string, string>();

  async get(key: string) {
    return this.#items.get(key);
  }

  async set(key: string, value: string) {
    this.#items.set(key, value);
  }
}

test("returns the stored value on lookup", async () => {
  const cache = new Cache(new MemoryStore());

  await cache.set("user:1", "Ada");

  expect(await cache.get("user:1")).toBe("Ada");
});
```

### Spies

`spyOn` records calls on an existing method; chain a stub to block side
effects:

```ts
test("fetches each profile once across repeated lookups", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({id: 1, name: "Ada"})
  );
  const profiles = createProfileClient();

  await profiles.get(1);
  await profiles.get(1);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
```

### Stubs

`mock(impl)` creates a tracked function; program results with
`mockReturnValue`, `mockResolvedValue`, `mockRejectedValue`,
`mockImplementation`, and their `Once` variants:

```ts
test("reports unreadable config when the read fails with EACCES", async () => {
  const denied = Object.assign(new Error("permission denied"), {
    code: "EACCES"
  });
  const readFile = mock().mockRejectedValue(denied);

  await expect(loadConfig("app.json", {readFile})).rejects.toThrow(
    "unreadable config"
  );
  expect(readFile).toHaveBeenCalledWith("app.json", "utf8");
});
```

`jest.fn`, `vi.fn`, and `vi.spyOn` alias the native `APIs` for
migrations; prefer `mock` and `spyOn`.

### Module mocks

Reserve `mock.module()` for modules lacking an injection seam:

```ts
mock.module("./client.ts", () => ({
  fetchData: mock(async () => ({data: "mocked"}))
}));
```

- Updates live `ESM` bindings, including existing imports.
- Survives `mock.restore()` and leaks into later files; run with
  `--isolate`.
- Register in a preload file to intercept modules with import-time side
  effects.

## Assertions

- Assert observable behavior—return values, output, state—never
  internals.
- Cover the happy path plus every distinct failure and cancellation
  path.
- Never duplicate existing coverage or assertions.
- Fail loudly on bad state:
  - `expect.assertions(n)` or `expect.hasAssertions()` in tests with
    callbacks or branches.
  - `expect.unreachable(message)` on paths that must never run.
  - Throw on missing fixtures; never return early.

### Matcher selection

| Intent               | Matcher                                                   |
| :------------------- | :-------------------------------------------------------- |
| Primitives, identity | `toBe`                                                    |
| Structural equality  | `toEqual`; `toStrictEqual` also checks `undefined`, class |
| Partial objects      | `toMatchObject`, `expect.objectContaining`                |
| Dynamic values       | `expect.any(Type)`, `expect.stringMatching(pattern)`      |
| Errors               | `toThrow(ErrorClass)` or `toThrow("message")`             |
| Promises             | `await expect(promise).resolves` or `.rejects`            |
| Mock calls           | `toHaveBeenCalledWith(...)` over `toHaveBeenCalled()`     |
| Floats               | `toBeCloseTo(value, digits)`                              |
| Object keys, values  | `toContainAllKeys`, `toContainValue`, `toContainValues`   |

Avoid `toBeTruthy` and `toBeDefined` when a precise expected value
exists.

### Static types

`expectTypeOf` does nothing at runtime; `bun test --check` enforces it:

```ts
test("infers the normalized config shape", () => {
  expectTypeOf(normalizeConfig({port: 80})).toMatchObjectType<{
    port: number;
  }>();
});
```

## Snapshots

- Snapshot large, stable serialized output; assert small values
  explicitly.
- Mask dynamic fields with asymmetric matchers:

```ts
test("serializes a new session with masked dynamic fields", () => {
  expect(createSession("ada")).toMatchSnapshot({
    id: expect.any(String),
    createdAt: expect.any(Date)
  });
});
```

- Review every diff before `bun test -u`; commit `__snapshots__/`
  alongside tests.
- `CI=true` rejects new file and inline snapshots; record them locally.

## Lifecycle hooks

| Placement        | Scope                  |
| :--------------- | :--------------------- |
| Preload file     | Every test in the run  |
| File top level   | Every test in the file |
| `describe` block | Tests in that block    |

Order: outer `beforeAll` → inner `beforeAll` → outer `beforeEach` →
inner `beforeEach` → test → inner `afterEach` → outer `afterEach` →
`onTestFinished` → inner `afterAll` → outer `afterAll`.

- A throwing `beforeAll` skips every test in its scope.
- A throwing `beforeEach` fails each test in its scope.
- `onTestFinished(fn)` registers cleanup for the current test;
  concurrent tests reject it—use `test.serial`.

## Concurrency

- `test.concurrent`, `describe.concurrent`, or `--concurrent` run tests
  concurrently within a file; `--max-concurrency` caps them (default
  `20`).
- Concurrent tests never share mutable state.
- `test.serial` opts a test out of concurrency.

## Output hygiene

- Never commit `console.*` calls or `debugger` statements in tests;
  assert instead of printing.
- Capture intended output and assert on it:

```ts
test("warns when the config omits the port", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});

  normalizeConfig({});

  expect(warn).toHaveBeenCalledWith(expect.stringContaining("port"));
});
```

- Spawn CLIs with `Bun.spawnSync([process.execPath, "src/cli.ts"])`;
  assert on `stdout` and `exitCode`.
- Silence expected logs from code under test; a clean run prints only
  the test report.

## `DOM` testing

```bash
bun add -d @happy-dom/global-registrator @testing-library/dom @testing-library/react @testing-library/jest-dom
```

```toml
# bunfig.toml
[test]
preload = ["./test/happydom.ts", "./test/setup.ts"]
```

```ts
// test/happydom.ts
import {GlobalRegistrator} from "@happy-dom/global-registrator";

GlobalRegistrator.register();
```

Register `jest-dom` matchers in `test/setup.ts`:

```ts
import {expect} from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);
```

Type the matchers:

```ts
// test/matchers.d.ts
import type {TestingLibraryMatchers} from "@testing-library/jest-dom/matchers";
import type {expect} from "bun:test";

declare module "bun:test" {
  interface Matchers<T> extends TestingLibraryMatchers<
    ReturnType<typeof expect.stringContaining>,
    T
  > {}
}
```

Scope `DOM` types per file with a triple-slash directive:

```tsx
/// <reference lib="dom" />

import {expect, test} from "bun:test";
import {render, screen} from "@testing-library/react";
import {Welcome} from "./welcome.tsx";

test("renders the greeting heading with the user name", () => {
  render(<Welcome name="Ada" />);

  expect(screen.getByRole("heading")).toHaveTextContent("Hello Ada");
});
```

Testing Library registers `cleanup` in `afterEach` automatically.

## Verification

Before writing tests, confirm their dependencies appear in
`devDependencies`. Before declaring a task done:

1. `bun test <file>` passes.
2. `bun test <file> -t "<name>"` runs each new or updated test.
3. `bun test --check` reports zero type errors.
4. `CI=true bun test --isolate --randomize` shows zero new failures.
5. Changed test files contain no `console.*`, `debugger`, `.only`, or
   `.skip`.
