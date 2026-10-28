# Testing

`Bun` provides a built-in test runner via the `bun:test` module. The
runner delivers high-performance execution, `Jest`-compatible `APIs`,
native `TypeScript` support, snapshot testing, mocking, fake timers, and
`DOM` integration.

## Test execution

Run test suites using the `Bun` `CLI`:

```bash
bun test                          # Run all tests
bun test --only                   # Run tests marked with .only
bun test --todo                   # Run tests marked with .todo
bun test --update-snapshots       # Update stored snapshots
bun test --preload ./setup.ts     # Preload setup scripts
TZ=America/Los_Angeles bun test   # Set suite timezone
```

Configure default test options in `bunfig.toml`:

```toml
[test]
preload = ["./setup.ts"]
```

## Test definition

Import test primitives directly from `bun:test`:

```ts
import {describe, expect, test} from "bun:test";

test("adds numbers", () => {
  expect(2 + 2).toBe(4);
});

describe("math operations", () => {
  test("multiplies numbers", () => {
    expect(2 * 3).toBe(6);
  });
});
```

### Asynchronous tests

Return a `Promise` or use `async`/`await`:

```ts
test("fetches user data", async () => {
  const data = await Promise.resolve({id: 1});
  expect(data.id).toBe(1);
});
```

Or invoke the `done` callback upon completion:

```ts
test("callback completes", done => {
  setTimeout(() => {
    expect(true).toBe(true);
    done();
  }, 10);
});
```

### Timeouts

Pass a duration in milliseconds as the third parameter (default:
`5000ms`). Expiring timeouts throw an `uncatchable` exception and cancel
child processes:

```ts
test("slow query completes within threshold", async () => {
  const result = await slowOperation();
  expect(result).toBeDefined();
}, 500);
```

### Retries and repeats

Supply execution options via the options argument. `retry` and `repeats`
conflict—never combine them in one test:

```ts
// Retries on failure up to N times; passes on first success
test(
  "unstable network query",
  async () => {
    const response = await fetch("https://example.com");
    expect(response.ok).toBe(true);
  },
  {retry: 3}
);

// Executes N + 1 times; fails if any run fails
test(
  "verifies deterministic output",
  () => {
    expect(Math.random()).toBeLessThan(1);
  },
  {repeats: 5}
);
```

## Modifiers and conditionals

Control test execution through chaining modifiers:

```ts
test.skip("skipped test", () => {});
test.todo("unimplemented test", () => {});
test.only("exclusive test", () => {});
test.failing("known failure", () => {
  expect(1 + 1).toBe(3); // Inverts outcome: failure counts as pass
});
```

Apply conditional predicates to tests or `describe` blocks:

```ts
const darwin = process.platform === "darwin";

test.if(darwin)("runs only on macOS", () => {});
test.skipIf(!darwin)("skips on non-macOS", () => {});
test.todoIf(darwin)("tracks planned macOS support", () => {});

describe.if(darwin)("macOS suite", () => {
  test("feature a", () => {});
});
```

## Parametrized tests

Generate parameterized test suites via `test.each` and `describe.each`:

```ts
// Array rows supply positional arguments
test.each([
  [1, 2, 3],
  [4, 5, 9]
])("%i + %i yields %i", (a, b, expected) => {
  expect(a + b).toBe(expected);
});

// Object rows pass an object argument
test.each([
  {a: 1, b: 2, sum: 3},
  {a: 4, b: 5, sum: 9}
])("$a + $b yields $sum", ({a, b, sum}) => {
  expect(a + b).toBe(sum);
});
```

### Format specifiers

| Token | Interpolated value type |
| :---- | :---------------------- |
| `%p`  | Pretty-format           |
| `%s`  | String                  |
| `%d`  | Number                  |
| `%i`  | Integer                 |
| `%f`  | Floating point          |
| `%j`  | `JSON`                  |
| `%o`  | Object                  |
| `%#`  | Test case index         |
| `%%`  | Literal percent sign    |

## Lifecycle hooks

Manage setup and teardown at file, `describe`, or test level:

```ts
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  onTestFinished,
  test
} from "bun:test";

beforeAll(async () => {
  // Runs once before all tests in scope
});

beforeEach(() => {
  // Runs before each test in scope
});

afterEach(() => {
  // Runs after each test in scope
});

afterAll(async () => {
  // Runs once after all tests in scope
});

test("registers scoped cleanup", () => {
  onTestFinished(() => {
    // Executes after afterEach hooks for this test
  });
});
```

- **Execution order**: outer `beforeAll` → inner `beforeAll` → outer
  `beforeEach` → inner `beforeEach` → test → inner `afterEach` → outer
  `afterEach` → inner `afterAll` → outer `afterAll`.
- **Error isolation**: hook exceptions skip remaining tests within the
  affected scope.
- **Concurrency restriction**: `onTestFinished` requires serial
  execution (`test.serial`).

## Assertions and types

### Assertion counts

Enforce assertion execution within tests containing asynchronous or
conditional branches:

```ts
test("executes expected assertions", async () => {
  expect.hasAssertions(); // Requires at least one assertion
  expect.assertions(2); // Requires exactly two assertions

  const data = await fetchData();
  expect(data).toBeDefined();
  expect(data.valid).toBe(true);
});
```

### Static type assertions

Verify `TypeScript` compile-time types with `expectTypeOf`. The runner
treats calls as runtime no-ops. Check types via `tsc --noEmit`:

```ts
import {expectTypeOf, test} from "bun:test";

test("validates types statically", () => {
  expectTypeOf("hello").toBeString();
  expectTypeOf(123).toBeNumber();
  expectTypeOf([1, 2, 3]).items.toBeNumber();
  expectTypeOf(Promise.resolve("value")).resolves.toBeString();
  expectTypeOf({id: "abc", role: "admin"}).toMatchObjectType<{
    id: string;
  }>();
});
```

## Matchers catalog

`Bun` supports extensive `Jest`-compatible matchers.

### Basic equality and identity

| Matcher            | Verification target                           |
| :----------------- | :-------------------------------------------- |
| `.toBe(val)`       | Strict equality (`Object.is`)                 |
| `.toEqual(val)`    | Deep recursive equality                       |
| `.toStrictEqual()` | Strict equality including types and undefined |
| `.toBeDefined()`   | Value distinguishes from `undefined`          |
| `.toBeUndefined()` | Value equals `undefined`                      |
| `.toBeNull()`      | Value equals `null`                           |
| `.toBeNaN()`       | Value evaluates as `NaN`                      |
| `.toBeTruthy()`    | Value casts to boolean `true`                 |
| `.toBeFalsy()`     | Value casts to boolean `false`                |

### Strings and collections

| Matcher                     | Verification target                |
| :-------------------------- | :--------------------------------- |
| `.toHaveLength(len)`        | Collection matches length          |
| `.toContain(item)`          | Array or string contains substring |
| `.toContainEqual(item)`     | Array contains deep matching item  |
| `.toMatch(pattern)`         | String matches regular expression  |
| `expect.stringContaining()` | Asymmetric substring match         |
| `expect.stringMatching()`   | Asymmetric regular expression      |
| `expect.arrayContaining()`  | Asymmetric array subset match      |

### Objects and properties

| Matcher                     | Verification target             |
| :-------------------------- | :------------------------------ |
| `.toHaveProperty(path)`     | Object contains property path   |
| `.toMatchObject(shape)`     | Object matches partial subset   |
| `.toContainAllKeys(keys)`   | Object contains specified keys  |
| `.toContainValue(val)`      | Object contains specific value  |
| `.toContainValues(vals)`    | Object contains value set       |
| `expect.objectContaining()` | Asymmetric object partial match |

### Numbers and ranges

| Matcher                      | Verification target         |
| :--------------------------- | :-------------------------- |
| `.toBeGreaterThan(n)`        | Value exceeds threshold     |
| `.toBeGreaterThanOrEqual(n)` | Value equals or exceeds     |
| `.toBeLessThan(n)`           | Value stays below threshold |
| `.toBeLessThanOrEqual(n)`    | Value equals or stays below |
| `.toBeCloseTo(n, digits?)`   | Floating point proximity    |

### Exceptions, promises, and utilities

| Matcher                   | Verification target        |
| :------------------------ | :------------------------- |
| `.toThrow(error?)`        | Function throws error      |
| `.toBeInstanceOf(cls)`    | Value inherits prototype   |
| `.resolves`               | Unwraps resolved `Promise` |
| `.rejects`                | Unwraps rejected `Promise` |
| `expect.any(Constructor)` | Matches instance type      |
| `expect.anything()`       | Matches non-nullish value  |

## Mocks and spies

Create mocked functions using `mock()` or the `jest.fn()` alias:

```ts
import {expect, jest, mock, spyOn, test} from "bun:test";

const add = mock((a: number, b: number) => a + b);
add(2, 3);

expect(add).toHaveBeenCalledTimes(1);
expect(add).toHaveBeenCalledWith(2, 3);
expect(add.mock.calls).toEqual([[2, 3]]);
expect(add.mock.results).toEqual([{type: "return", value: 5}]);
```

### Mock implementations

```ts
const mockedService = mock();

mockedService.mockReturnValue(100);
mockedService.mockReturnValueOnce(50);
mockedService.mockResolvedValue({status: "ok"});
mockedService.mockResolvedValueOnce({status: "queued"});
mockedService.mockRejectedValue(new Error("Network failed"));
mockedService.mockImplementation((x: number) => x * 2);
mockedService.mockImplementationOnce(() => 0);
```

### Spies

Track target method invocations while preserving original behavior:

```ts
const user = {
  getName() {
    return "Alex";
  }
};

const spy = spyOn(user, "getName");
user.getName();

expect(spy).toHaveBeenCalledTimes(1);
spy.mockRestore(); // Restores original behavior
```

### Module mocking

Override module exports across `ESM` and `CommonJS`:

```ts
mock.module("./client.ts", () => ({
  fetchData: mock(async () => ({data: "mocked"}))
}));
```

- **Live bindings**: `mock.module` recursively patches live `ESM`
  exports. Later calls update existing references.
- **Hoisting via preload**: to intercept side-effecting top-level module
  code, mock modules within a `--preload` script.

### Mock cleanup

Reset or restore mock states in `afterEach` hooks:

```ts
afterEach(() => {
  mock.clearAllMocks(); // Resets calls, results, and instances
  mock.restore(); // Restores original implementations on spies
});
```

### Vitest compatibility

The `vi` namespace aliases common mocking utilities:

```ts
import {vi} from "bun:test";

const fn = vi.fn();
const spy = vi.spyOn(console, "log");
vi.restoreAllMocks();
```

## Snapshots

Serialize values and verify regression over time:

```ts
import {expect, test} from "bun:test";

test("matches file snapshot", () => {
  expect({env: "production", port: 8080}).toMatchSnapshot();
});

test("matches inline snapshot", () => {
  expect("config-output").toMatchInlineSnapshot(`"config-output"`);
});

test("matches error snapshot", () => {
  expect(() => {
    throw new Error("Invalid schema");
  }).toThrowErrorMatchingSnapshot();
});
```

### Dynamic masking

Mask variable data (such as timestamps and generated identifiers) using
asymmetric property matchers:

```ts
test("snapshot with dynamic fields", () => {
  const payload = {
    id: Math.random(),
    createdAt: new Date().toISOString(),
    status: "active"
  };

  expect(payload).toMatchSnapshot({
    id: expect.any(Number),
    createdAt: expect.any(String)
  });
});
```

Update snapshot baselines via the `CLI`:

```bash
bun test --update-snapshots
```

## Time and timers

Mock the system clock for `Date.now()`, `new Date()`, and `Intl`:

```ts
import {expect, jest, setSystemTime, test} from "bun:test";

test("manipulates system time", () => {
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  expect(new Date().getFullYear()).toBe(2026);

  expect(Date.now()).toBe(1767225600000);
  expect(jest.now()).toBe(1767225600000);

  // Calling setSystemTime without parameters restores real time
  setSystemTime();
  expect(new Date().getFullYear()).toBeGreaterThan(2025);
});
```

- **Timers restriction**: system clock mocking excludes timer scheduling
  (`setTimeout`, `setInterval`).
- **Timezone control**: configure time zones per run using
  `TZ=<timezone> bun test` or assign `process.env["TZ"]` dynamically at
  runtime.

## Browser and `DOM` environments

Emulate browser `APIs` using `happy-dom`:

```bash
bun add -d @happy-dom/global-registrator @testing-library/react @testing-library/jest-dom
```

Register globals in a preload file (`setup.ts`):

```ts
import {GlobalRegistrator} from "@happy-dom/global-registrator";
import "@testing-library/jest-dom";

GlobalRegistrator.register();
```

Configure `bunfig.toml`:

```toml
[test]
preload = ["./setup.ts"]
```

Inject `DOM` types into test files using the triple-slash directive:

```tsx
/// <reference lib="dom" />

import {afterEach, expect, test} from "bun:test";
import {cleanup, render, screen} from "@testing-library/react";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function Welcome({name}: {name: string}) {
  return <h1>Hello {name}</h1>;
}

test("renders heading", () => {
  render(<Welcome name="World" />);
  expect(screen.getByRole("heading")).toHaveTextContent("Hello World");
});
```
