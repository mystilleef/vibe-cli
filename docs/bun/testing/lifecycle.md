# Lifecycle hooks

| Hook             | Description                                     |
| ---------------- | ----------------------------------------------- |
| `beforeAll`      | Runs once before all tests.                     |
| `beforeEach`     | Runs before each test.                          |
| `afterEach`      | Runs after each test.                           |
| `afterAll`       | Runs once after all tests.                      |
| `onTestFinished` | Runs after a test finishes (after `afterEach`). |

## Per-test setup and `teardown`

```ts
import {beforeEach, afterEach, test} from "bun:test";

beforeEach(() => {
  console.log("running test");
});

afterEach(() => {
  console.log("done with test");
});

test("example test", () => {});
```

## Per-scope setup and `teardown`

`beforeAll` and `afterAll` scope to their definition location.

### Scoped to a describe block

```ts
import {describe, beforeAll, afterAll, test} from "bun:test";

describe("test group", () => {
  beforeAll(() => {
    /* setup */
  });
  afterAll(() => {
    /* teardown */
  });
  test("test 1", () => {});
  test("test 2", () => {});
});
```

### Scoped to a test file

```ts
import {describe, beforeAll, afterAll, test} from "bun:test";

beforeAll(() => {
  /* file-level setup */
});
afterAll(() => {
  /* file-level teardown */
});

describe("test group", () => {
  test("test 1", () => {});
});
```

### `onTestFinished`

Runs after all `afterEach` hooks. Not supported in concurrent tests. Use
`test.serial` instead.

```ts
import {test, onTestFinished} from "bun:test";

test("cleanup after test", () => {
  onTestFinished(() => {
    console.log("test finished");
  });
});
```

## Global setup and `teardown`

Define hooks in a separate file and load with `--preload`:

```ts
import {beforeAll, afterAll} from "bun:test";

beforeAll(() => {
  /* global setup */
});
afterAll(() => {
  /* global teardown */
});
```

```bash
bun test --preload ./setup.ts
```

```toml
[test]
preload = ["./setup.ts"]
```

## Examples

### Database setup

```ts
import {beforeAll, afterAll, beforeEach} from "bun:test";
import {createConnection, closeConnection, clearDatabase} from "./db";

let connection;

beforeAll(async () => {
  connection = await createConnection({
    host: "localhost",
    database: "test_db"
  });
});
afterAll(async () => {
  await closeConnection(connection);
});
beforeEach(async () => {
  await clearDatabase(connection);
});
```

### API server setup

```ts
import {beforeAll, afterAll} from "bun:test";
import {startServer, stopServer} from "./server";

let server;

beforeAll(async () => {
  server = await startServer({port: 3001, env: "test"});
});
afterAll(async () => {
  await stopServer(server);
});
```

### Mock setup

```ts
import {beforeEach, afterEach, mock} from "bun:test";

beforeEach(() => {
  mock.module("./api-client", () => ({
    fetchUser: mock(() => Promise.resolve({id: 1, name: "Test User"})),
    createUser: mock(() => Promise.resolve({id: 2}))
  }));
});
afterEach(() => {
  mock.restore();
});
```

## Asynchronous lifecycle hooks

All hooks support `async` functions:

```ts
import {beforeAll, afterAll, test} from "bun:test";

beforeAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
});
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
});

test("async test", async () => {
  await expect(Promise.resolve("test")).resolves.toBe("test");
});
```

## Nested hooks

```ts
import {
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  test
} from "bun:test";

beforeAll(() => console.log("File beforeAll"));
afterAll(() => console.log("File afterAll"));

describe("outer", () => {
  beforeAll(() => console.log("Outer beforeAll"));
  beforeEach(() => console.log("Outer beforeEach"));
  afterEach(() => console.log("Outer afterEach"));
  afterAll(() => console.log("Outer afterAll"));

  describe("inner", () => {
    beforeAll(() => console.log("Inner beforeAll"));
    beforeEach(() => console.log("Inner beforeEach"));
    afterEach(() => console.log("Inner afterEach"));
    afterAll(() => console.log("Inner afterAll"));

    test("nested test", () => console.log("Test running"));
  });
});
```

Output order: `File beforeAll` → `Outer beforeAll` → `Inner beforeAll` →
`Outer beforeEach` → `Inner beforeEach` → `Test running` →
`Inner afterEach` → `Outer afterEach` → `Inner afterAll` →
`Outer afterAll` → `File afterAll`

## Error handling

A throwing hook skips all tests in its scope:

```ts
import {beforeAll, test} from "bun:test";

beforeAll(() => {
  throw new Error("Setup failed"); // All tests in scope will be skipped
});

test("this test will be skipped", () => {});
```

Handle gracefully with try/catch:

```ts
import {beforeAll} from "bun:test";

beforeAll(async () => {
  try {
    await setupDatabase();
  } catch (error) {
    console.error("Database setup failed:", error);
    throw error;
  }
});
```
