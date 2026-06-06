# Mocks

## Basic function mocks

```ts
import {test, expect, mock} from "bun:test";

const random = mock(() => Math.random());

test("random", () => {
  const val = random();
  expect(val).toBeGreaterThan(0);
  expect(random).toHaveBeenCalled();
  expect(random).toHaveBeenCalledTimes(1);
});
```

`jest.fn()` is an alias for `mock()`:

```ts
import {test, expect, jest} from "bun:test";

const random = jest.fn(() => Math.random());
```

## Mock function properties

`mock()` returns a function decorated with extra properties:

```ts
import {mock} from "bun:test";

const random = mock((multiplier: number) => multiplier * Math.random());
random(2);
random(10);

random.mock.calls; // [[ 2 ], [ 10 ]]
random.mock.results; // [{ type: "return", value: 0.65 }, ...]
```

### Available properties and methods

| Method                              | Description                         |
| ----------------------------------- | ----------------------------------- |
| `mockFn.getMockName()`              | Returns the mock name.              |
| `mockFn.mock.calls`                 | Call arguments array.               |
| `mockFn.mock.results`               | Return values array.                |
| `mockFn.mock.instances`             | `this` contexts array.              |
| `mockFn.mock.contexts`              | `this` contexts array.              |
| `mockFn.mock.lastCall`              | Arguments of last call.             |
| `mockFn.mockClear()`                | Clears call history.                |
| `mockFn.mockReset()`                | Clears history and implementation.  |
| `mockFn.mockRestore()`              | Restores original implementation.   |
| `mockFn.mockImplementation(fn)`     | Sets new implementation.            |
| `mockFn.mockImplementationOnce(fn)` | Sets implementation for next call.  |
| `mockFn.mockName(name)`             | Sets the mock name.                 |
| `mockFn.mockReturnThis()`           | Returns `this`.                     |
| `mockFn.mockReturnValue(val)`       | Sets a return value.                |
| `mockFn.mockReturnValueOnce(val)`   | Sets return for next call.          |
| `mockFn.mockResolvedValue(val)`     | Sets resolved Promise.              |
| `mockFn.mockResolvedValueOnce(val)` | Sets resolved for next.             |
| `mockFn.mockRejectedValue(val)`     | Sets rejected Promise.              |
| `mockFn.mockRejectedValueOnce(val)` | Sets rejected for next.             |
| `mockFn.withImplementation(fn, cb)` | Temporarily changes implementation. |

### Basic mock usage

```ts
import {test, expect, mock} from "bun:test";

test("mock function behavior", () => {
  const mockFn = mock((x: number) => x * 2);

  expect(mockFn(5)).toBe(10);
  expect(mockFn(10)).toBe(20);
  expect(mockFn).toHaveBeenCalledTimes(2);
  expect(mockFn).toHaveBeenCalledWith(5);
  expect(mockFn.mock.calls).toEqual([[5], [10]]);
});
```

### Dynamic implementations

```ts
import {test, expect, mock} from "bun:test";

test("dynamic mock implementations", () => {
  const mockFn = mock();
  mockFn.mockImplementationOnce(() => "first");
  mockFn.mockImplementationOnce(() => "second");
  mockFn.mockImplementation(() => "default");

  expect(mockFn()).toBe("first");
  expect(mockFn()).toBe("second");
  expect(mockFn()).toBe("default");
  expect(mockFn()).toBe("default");
});
```

### Asynchronous mocks

```ts
import {test, expect, mock} from "bun:test";

test("async mock functions", async () => {
  const asyncMock = mock();
  asyncMock.mockResolvedValueOnce("first result");
  asyncMock.mockResolvedValue("default result");

  expect(await asyncMock()).toBe("first result");
  expect(await asyncMock()).toBe("default result");

  const rejectMock = mock();
  rejectMock.mockRejectedValue(new Error("Mock error"));
  await expect(rejectMock()).rejects.toThrow("Mock error");
});
```

## Spies with `spyOn()`

Track calls without replacing the implementation. Supports
`.toHaveBeenCalled()` and `.toHaveBeenCalledTimes()`.

```ts
import {test, expect, spyOn} from "bun:test";

const ringo = {
  name: "Ringo",
  sayHi() {
    console.log(`Hello I'm ${this.name}`);
  }
};

const spy = spyOn(ringo, "sayHi");

test("spyon", () => {
  expect(spy).toHaveBeenCalledTimes(0);
  ringo.sayHi();
  expect(spy).toHaveBeenCalledTimes(1);
});
```

### Advanced spy usage

```ts
import {test, expect, spyOn, afterEach} from "bun:test";

class UserService {
  async getUser(id: string) {
    return {id, name: `User ${id}`};
  }
  async saveUser(user: any) {
    return {...user, saved: true};
  }
}

const userService = new UserService();

afterEach(() => jest.restoreAllMocks());

test("spy on service methods", async () => {
  const getUserSpy = spyOn(userService, "getUser");
  const saveUserSpy = spyOn(userService, "saveUser");

  const user = await userService.getUser("123");
  await userService.saveUser(user);

  expect(getUserSpy).toHaveBeenCalledWith("123");
  expect(saveUserSpy).toHaveBeenCalledWith(user);
});

test("spy with mock implementation", async () => {
  const getUserSpy = spyOn(userService, "getUser").mockResolvedValue({
    id: "123",
    name: "Mocked User"
  });

  const result = await userService.getUser("123");
  expect(result.name).toBe("Mocked User");
  expect(getUserSpy).toHaveBeenCalledWith("123");
});
```

## Module mocks with `mock.module()`

`mock.module(path, callback)` overrides a module's exports. Supports
both `import` and `require`.

```ts
import {test, expect, mock} from "bun:test";

mock.module("./module", () => ({foo: "bar"}));

test("mock.module", async () => {
  const esm = await import("./module");
  expect(esm.foo).toBe("bar");

  const cjs = require("./module");
  expect(cjs.foo).toBe("bar");
});
```

### Overriding already imported modules

`mock.module()` updates the module cache; later imports and live ES
module bindings reflect the override.

```ts
import {test, expect, mock} from "bun:test";
import {foo} from "./module";

test("mock.module", async () => {
  expect(foo).toBe("bar");

  mock.module("./module", () => ({foo: "baz"}));

  expect(foo).toBe("baz"); // live `ESM` binding updated
  expect(require("./module").foo).toBe("baz");
});
```

### Hoisting and `preloading`

To prevent the original module from evaluating (avoiding side effects),
mock before import using `--preload`:

```ts
import {mock} from "bun:test";
mock.module("./module", () => ({foo: "bar"}));
```

```bash
bun test --preload ./my-preload
```

```toml
[test]
preload = ["./my-preload"]
```

### Module mock examples

```ts
import {test, expect, mock} from "bun:test";

mock.module("./api-client", () => ({
  fetchUser: mock(async (id: string) => ({id, name: `User ${id}`})),
  createUser: mock(async (user: any) => ({...user, id: "new-id"})),
  updateUser: mock(async (id: string, user: any) => ({...user, id}))
}));

test("user service with mocked API", async () => {
  const {fetchUser} = await import("./api-client");
  const {UserService} = await import("./user-service");

  const userService = new UserService();
  const user = await userService.getUser("123");

  expect(fetchUser).toHaveBeenCalledWith("123");
  expect(user.name).toBe("User 123");
});
```

### Mocking external dependencies

```ts
import {test, expect, mock} from "bun:test";

mock.module("pg", () => ({
  Client: mock(function () {
    return {
      connect: mock(async () => {}),
      query: mock(async () => ({rows: [{id: 1, name: "Test User"}]})),
      end: mock(async () => {})
    };
  })
}));

test("database operations", async () => {
  const {Database} = await import("./database");
  const db = new Database();
  const users = await db.getUsers();
  expect(users).toHaveLength(1);
  expect(users[0].name).toBe("Test User");
});
```

## Global mock functions

### Clear all mocks

`mock.clearAllMocks()` resets `.mock.calls`, `.mock.instances`,
`.mock.contexts`, and `.mock.results` without restoring implementations:

```ts
import {expect, mock, test} from "bun:test";

const random1 = mock(() => Math.random());
const random2 = mock(() => Math.random());

test("clearing all mocks", () => {
  random1();
  random2();
  expect(random1).toHaveBeenCalledTimes(1);

  mock.clearAllMocks();

  expect(random1).toHaveBeenCalledTimes(0);
  expect(typeof random1()).toBe("number"); // implementations preserved
});
```

### Restore all mocks

`mock.restore()` restores original implementations for all spies. Does
not reset `mock.module()` overrides. Add to `afterEach` or preload for
global cleanup.

```ts
import {expect, mock, spyOn, test} from "bun:test";
import * as fooModule from "./foo.ts";
import * as barModule from "./bar.ts";
import * as bazModule from "./baz.ts";

test("foo, bar, baz", () => {
  const fooSpy = spyOn(fooModule, "foo");
  const barSpy = spyOn(barModule, "bar");
  const bazSpy = spyOn(bazModule, "baz");

  fooSpy.mockImplementation(() => 42);
  barSpy.mockImplementation(() => 43);
  bazSpy.mockImplementation(() => 44);

  expect(fooModule.foo()).toBe(42);

  mock.restore();

  expect(fooModule.foo()).toBe("foo");
  expect(barModule.bar()).toBe("bar");
  expect(bazModule.baz()).toBe("baz");
});
```

## Compatibility with `Vitest`

`vi` aliases parts of the Jest mocking API:

```ts
import {test, expect, vi} from "bun:test";

test("vitest compatibility", () => {
  const mockFn = vi.fn(() => 42);
  mockFn();
  expect(mockFn).toHaveBeenCalled();
  // vi.fn, vi.spyOn, vi.mock, vi.restoreAllMocks, vi.clearAllMocks
});
```

## Implementation details

- **Cache**: Mocks interact with both `ESM` and CommonJS module caches.
- **Lazy evaluation**: Mock factory runs only on first import/require.
- **Path resolution**: Supports relative paths, absolute paths, and
  package names.
- **Import timing**: Mocking before first import prevents side effects;
  mocking after import retains them.
- **Live bindings**: Mocked `ESM` modules maintain live
  bindings—changing the mock updates all existing imports.

## Advanced patterns

### Factory functions

```ts
import {mock} from "bun:test";

function createMockUser(overrides = {}) {
  return {
    id: "mock-id",
    name: "Mock User",
    email: "mock@example.com",
    ...overrides
  };
}

const mockUserService = {
  getUser: mock(async (id: string) => createMockUser({id})),
  createUser: mock(async (data: any) => createMockUser(data)),
  updateUser: mock(async (id: string, data: any) =>
    createMockUser({id, ...data})
  )
};
```

### Mock cleanup patterns

```ts
import {afterEach, beforeEach, mock} from "bun:test";

beforeEach(() => {
  mock.module("./logger", () => ({
    log: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {})
  }));
});

afterEach(() => {
  mock.restore();
  mock.clearAllMocks();
});
```

## Notes

- **Auto-mocking**: `__mocks__` directory and auto-mocking haven't
  landed yet. [File an issue](https://github.com/oven-sh/bun/issues) if
  this blocks you.
- **`ESM` vs `CommonJS`**: For ES Modules, Bun patches JavaScriptCore to
  override export values and update live bindings recursively.
