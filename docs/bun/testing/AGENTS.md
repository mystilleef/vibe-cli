# Bun test documentation index

Reference docs for `bun:test`. All files use the optimized format: no
icon/theme metadata in code fences, no best-practices padding.

- [writing.md](writing.md): Core API
  - `test` and `describe`
  - `async` tests, timeouts, and retries
  - Modifiers (`skip`/`todo`/`only`/`if`/`failing`)
  - Parametrized tests (`test.each`)
  - Assertion counting and `expectTypeOf`
  - Full matcher reference tables
- [lifecycle.md](lifecycle.md): Lifecycle hooks
  - `beforeAll`, `beforeEach`, `afterEach`, `afterAll`, and
    `onTestFinished`
  - Scope rules and nesting order
  - Global setup via `--preload`
  - `async` hooks and error handling
- [mocks.md](mocks.md): Mocking
  - `mock()` and `jest.fn()`
  - Mock function properties and methods
  - `spyOn()` and `mock.module()`
  - Hoisting and `preload`
  - `mock.clearAllMocks()` and `mock.restore()`
  - `vi` alias and `ESM` live bindings
  - Advanced patterns
- [snapshots.md](snapshots.md): Snapshots
  - `toMatchSnapshot()` and `toMatchInlineSnapshot()`
  - Error snapshots
  - Property `matchers` and custom `serializers`
  - Updating, managing, and organizing snapshot files
  - Troubleshooting
- [date.md](date.md): Date and Time
  - `setSystemTime()`
  - `useFakeTimers()` and `useRealTimers()`
  - `jest.now()`
  - Timezone control via the `TZ` environment variable
- [dom-testing.md](dom-testing.md): DOM testing
  - happy-dom setup via `preload`
  - `/// <reference lib="dom" />`
  - React Testing Library integration
  - Custom elements, event testing, and global setup patterns
