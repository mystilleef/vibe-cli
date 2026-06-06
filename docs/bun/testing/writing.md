# Writing tests

Define tests with a Jest-like API imported from the built-in `bun:test`
module. Bun aims for complete Jest compatibility but currently supports
a limited set of expect `matchers`.

## Basic usage

```ts
import {expect, test} from "bun:test";

test("2 + 2", () => {
  expect(2 + 2).toBe(4);
});
```

### Grouping tests

```ts
import {expect, test, describe} from "bun:test";

describe("arithmetic", () => {
  test("2 + 2", () => {
    expect(2 + 2).toBe(4);
  });

  test("2 * 2", () => {
    expect(2 * 2).toBe(4);
  });
});
```

### Asynchronous tests

```ts
import {expect, test} from "bun:test";

test("2 * 2", async () => {
  const result = await Promise.resolve(2 * 2);
  expect(result).toEqual(4);
});
```

Call the `done` callback to signal completion (omitting it causes the
test to stall):

```ts
test("2 * 2", done => {
  Promise.resolve(2 * 2).then(result => {
    expect(result).toEqual(4);
    done();
  });
});
```

## Timeouts

Pass a timeout in milliseconds as the third argument. Default: `5000ms`.

```ts
import {test} from "bun:test";

test("wat", async () => {
  const data = await slowOperation();
  expect(data).toBe(42);
}, 500); // must complete in <500ms
```

Timeouts throw an `uncatchable` exception and kill any child processes
spawned in the test.

## Retries and repeats

### `test.retry`

Retry on failure up to N times. Passes on first success.

```ts
import {test} from "bun:test";

test(
  "flaky network request",
  async () => {
    const response = await fetch("https://example.com/api");
    expect(response.ok).toBe(true);
  },
  {retry: 3}
);
```

### `test.repeats`

Run N+1 times regardless of result (1 initial + N repeats). Fails if any
iteration fails.

```ts
import {test} from "bun:test";

test(
  "ensure test is stable",
  () => {
    expect(Math.random()).toBeLessThan(1);
  },
  {repeats: 20} // runs 21 times total
);
```

> `retry` and `repeats` don't work together on the same test.

When a test times out, Bun automatically kills any processes spawned via
`Bun.spawn`, `Bun.spawnSync`, or `node:child_process`.

## Test modifiers

### `test.skip`

```ts
import {expect, test} from "bun:test";

test.skip("wat", () => {
  expect(0.1 + 0.2).toEqual(0.3);
});
```

### `test.todo`

```ts
import {expect, test} from "bun:test";

test.todo("fix this", () => {
  myTestFunction();
});
```

Run `todo` tests with `bun test --todo`. Passing `todo` tests get
flagged as failing so you can remove the mark.

### `test.only`

```ts
import {test, describe} from "bun:test";

test("test #1", () => {}); // does not run
test.only("test #2", () => {}); // runs
describe.only("only", () => {
  test("test #3", () => {}); // runs
});
```

```bash
bun test --only  # runs only test #2 and #3
bun test         # runs all tests
```

### `test.if`

Runs when the condition evaluates as `truthy`:

```ts
const macOS = process.platform === "darwin";
test.if(macOS)("runs on macOS", () => {
  // runs if macOS
});
```

### `test.skipIf`

```ts
const macOS = process.platform === "darwin";
test.skipIf(macOS)("runs on non-macOS", () => {});
```

### `test.todoIf`

Use over `skipIf` when you plan the test but haven't implemented it yet
(vs. inapplicable for the target):

```ts
const macOS = process.platform === "darwin";
test.todoIf(macOS)("runs on posix", () => {});
```

### `test.failing`

Inverts the test result. A failing test passes, and a passing test fails
(confirming the fix).

```ts
test.failing("math is broken", () => {
  expect(0.1 + 0.2).toBe(0.3); // fails due to floating point — passes as .failing
});

test.failing("fixed bug", () => {
  expect(1 + 1).toBe(2); // passes — fails as .failing, prompting removal of the mark
});
```

## Conditional tests for describe blocks

`.if()`, `.skipIf()`, and `.todoIf()` apply to `describe` blocks,
affecting all tests in the suite:

```ts
const isMacOS = process.platform === "darwin";

describe.if(isMacOS)("macOS-specific features", () => {
  test("feature A", () => {});
  test("feature B", () => {});
});

describe.skipIf(process.platform === "win32")("Unix features", () => {
  test("feature C", () => {});
});

describe.todoIf(process.platform === "linux")(
  "Upcoming Linux support",
  () => {
    test("feature D", () => {});
  }
);
```

## Parametrized tests

### Iterations with `test.each` and `describe.each`

```ts
const cases = [
  [1, 2, 3],
  [3, 4, 7]
];

test.each(cases)("%p + %p should be %p", (a, b, expected) => {
  expect(a + b).toBe(expected);
});
```

```ts
describe.each([
  [1, 2, 3],
  [3, 4, 7]
])("add(%i, %i)", (a, b, expected) => {
  test(`returns ${expected}`, () => {
    expect(a + b).toBe(expected);
  });

  test(`sum is greater than each value`, () => {
    expect(a + b).toBeGreaterThan(a);
    expect(a + b).toBeGreaterThan(b);
  });
});
```

### Argument passing

- Array rows: each element passed as an individual argument.
- Object rows: passed as a single argument.

```ts
// Array items → individual arguments
test.each([
  [1, 2, 3],
  [4, 5, 9]
])("add(%i, %i) = %i", (a, b, expected) => {
  expect(a + b).toBe(expected);
});

// Object items → single argument
test.each([
  {a: 1, b: 2, expected: 3},
  {a: 4, b: 5, expected: 9}
])("add($a, $b) = $expected", data => {
  expect(data.a + data.b).toBe(data.expected);
});
```

### Format specifiers

| Specifier | Description             |
| --------- | ----------------------- |
| `%p`      | pretty-format           |
| `%s`      | String                  |
| `%d`      | Number                  |
| `%i`      | Integer                 |
| `%f`      | Floating point          |
| `%j`      | JSON                    |
| `%o`      | Object                  |
| `%#`      | Index of the test case  |
| `%%`      | Single percent sign (%) |

```ts
test.each([
  ["hello", 123],
  ["world", 456]
])("string: %s, number: %i", (str, num) => {});

test.each(["apple", "banana"])("fruit #%# is %s", fruit => {});
```

## Assertion counting

### `expect.hasAssertions()`

Fails the test if no assertions run:

```ts
test("async work calls assertions", async () => {
  expect.hasAssertions();

  const data = await fetchData();
  expect(data).toBeDefined();
});
```

### `expect.assertions(count)`

Fails the test if exactly `count` assertions don't run:

```ts
test("exactly two assertions", () => {
  expect.assertions(2);

  expect(1 + 1).toBe(2);
  expect("hello").toContain("ell");
});
```

## Type testing

### `expectTypeOf`

> **Note**: No-ops at runtime. Run `bunx tsc --noEmit` to verify type
> checks.

```ts
import {expectTypeOf} from "bun:test";

expectTypeOf<string>().toEqualTypeOf<string>();
expectTypeOf(123).toBeNumber();
expectTypeOf("hello").toBeString();

expectTypeOf({a: 1, b: "hello"}).toMatchObjectType<{a: number}>();

function greet(name: string): string {
  return `Hello ${name}`;
}
expectTypeOf(greet).toBeFunction();
expectTypeOf(greet).parameters.toEqualTypeOf<[string]>();
expectTypeOf(greet).returns.toEqualTypeOf<string>();

expectTypeOf([1, 2, 3]).items.toBeNumber();
expectTypeOf(Promise.resolve(42)).resolves.toBeNumber();
```

See the [API Reference](https://bun.com/reference/bun/test/expectTypeOf)
for full matcher docs.

## `Matchers`

Full Jest compatibility arrives in a future release.
[track progress here](https://github.com/oven-sh/bun/issues/1825).

### Basic `matchers`

| Status | Matcher            |
| ------ | ------------------ |
| ✅     | `.not`             |
| ✅     | `.toBe()`          |
| ✅     | `.toEqual()`       |
| ✅     | `.toBeNull()`      |
| ✅     | `.toBeUndefined()` |
| ✅     | `.toBeNaN()`       |
| ✅     | `.toBeDefined()`   |
| ✅     | `.toBeFalsy()`     |
| ✅     | `.toBeTruthy()`    |
| ✅     | `.toStrictEqual()` |

### String and array `matchers`

| Status | Matcher               |
| ------ | --------------------- |
| ✅     | `.toContain()`        |
| ✅     | `.toHaveLength()`     |
| ✅     | `.toMatch()`          |
| ✅     | `.toContainEqual()`   |
| ✅     | `.stringContaining()` |
| ✅     | `.stringMatching()`   |
| ✅     | `.arrayContaining()`  |

### Object `matchers`

| Status | Matcher                 |
| ------ | ----------------------- |
| ✅     | `.toHaveProperty()`     |
| ✅     | `.toMatchObject()`      |
| ✅     | `.toContainAllKeys()`   |
| ✅     | `.toContainValue()`     |
| ✅     | `.toContainValues()`    |
| ✅     | `.toContainAllValues()` |
| ✅     | `.toContainAnyValues()` |
| ✅     | `.objectContaining()`   |

### Number `matchers`

| Status | Matcher                     |
| ------ | --------------------------- |
| ✅     | `.toBeCloseTo()`            |
| ✅     | `.closeTo()`                |
| ✅     | `.toBeGreaterThan()`        |
| ✅     | `.toBeGreaterThanOrEqual()` |
| ✅     | `.toBeLessThan()`           |
| ✅     | `.toBeLessThanOrEqual()`    |

### Function and class `matchers`

| Status | Matcher             |
| ------ | ------------------- |
| ✅     | `.toThrow()`        |
| ✅     | `.toBeInstanceOf()` |

### Promise `matchers`

| Status | Matcher       |
| ------ | ------------- |
| ✅     | `.resolves()` |
| ✅     | `.rejects()`  |

### Mock function `matchers`

| Status | Matcher                       |
| ------ | ----------------------------- |
| ✅     | `.toHaveBeenCalled()`         |
| ✅     | `.toHaveBeenCalledTimes()`    |
| ✅     | `.toHaveBeenCalledWith()`     |
| ✅     | `.toHaveBeenLastCalledWith()` |
| ✅     | `.toHaveBeenNthCalledWith()`  |
| ✅     | `.toHaveReturned()`           |
| ✅     | `.toHaveReturnedTimes()`      |
| ✅     | `.toHaveReturnedWith()`       |
| ✅     | `.toHaveLastReturnedWith()`   |
| ✅     | `.toHaveNthReturnedWith()`    |

### Snapshot `matchers`

| Status | Matcher                                 |
| ------ | --------------------------------------- |
| ✅     | `.toMatchSnapshot()`                    |
| ✅     | `.toMatchInlineSnapshot()`              |
| ✅     | `.toThrowErrorMatchingSnapshot()`       |
| ✅     | `.toThrowErrorMatchingInlineSnapshot()` |

### Utility `matchers`

| Status | Matcher            |
| ------ | ------------------ |
| ✅     | `.extend`          |
| ✅     | `.anything()`      |
| ✅     | `.any()`           |
| ✅     | `.assertions()`    |
| ✅     | `.hasAssertions()` |

### Not yet implemented

| Status | Matcher                    |
| ------ | -------------------------- |
| ❌     | `.addSnapshotSerializer()` |
