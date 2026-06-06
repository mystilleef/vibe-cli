# Dates and times

`bun:test` lets you mock the system time. Affects `Date.now`,
`new Date()`, and `new Intl.DateTimeFormat().format()`.

> Timers don't fall under fake time control yet; a future release adds
> support.

## `setSystemTime`

```ts
import {setSystemTime, beforeAll, test, expect} from "bun:test";

beforeAll(() => {
  setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
});

test("it is 2020", () => {
  expect(new Date().getFullYear()).toBe(2020);
});
```

Jest-compatible aliases `useFakeTimers` and `useRealTimers` are
supported. Unlike Jest, `useFakeTimers` in Bun doesn't change the `Date`
constructor:

```ts
test("just like in jest", () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
  expect(new Date().getFullYear()).toBe(2020);
  jest.useRealTimers();
  expect(new Date().getFullYear()).toBeGreaterThan(2020);
});

test("unlike in jest", () => {
  const OriginalDate = Date;
  jest.useFakeTimers();
  if (typeof Bun === "undefined") {
    // Jest: Date constructor changes
    expect(Date).not.toBe(OriginalDate);
    expect(Date.now).not.toBe(OriginalDate.now);
  } else {
    // bun:test: Date constructor does not change
    expect(Date).toBe(OriginalDate);
    expect(Date.now).toBe(OriginalDate.now);
  }
});
```

## Reset the system time

Pass no arguments to reset to real time:

```ts
import {setSystemTime, expect, test} from "bun:test";

test("it was 2020, for a moment.", () => {
  setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
  expect(new Date().getFullYear()).toBe(2020);

  setSystemTime(); // reset

  expect(new Date().getFullYear()).toBeGreaterThan(2020);
});
```

## Get mocked time with `jest.now()`

`jest.now()` returns the current mocked timestamp with fake timers
running:

```ts
import {test, expect, jest} from "bun:test";

test("get the current mocked time", () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

  expect(Date.now()).toBe(1577836800000);
  expect(jest.now()).toBe(1577836800000);

  jest.useRealTimers();
});
```

## Set the time zone

All `bun test` runs default to `UTC (ETC/UTC)`. Override via environment
variable:

```bash
TZ=America/Los_Angeles bun test
```

Or set at runtime—unlike Jest, the value can update repeatedly:

```ts
import {test, expect} from "bun:test";

test("Welcome to California!", () => {
  process.env.TZ = "America/Los_Angeles";
  expect(new Date().getTimezoneOffset()).toBe(420);
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
    "America/Los_Angeles"
  );
});

test("Welcome to New York!", () => {
  process.env.TZ = "America/New_York";
  expect(new Date().getTimezoneOffset()).toBe(240);
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
    "America/New_York"
  );
});
```
