# Snapshots

Snapshot testing saves a value's output and compares it on later runs.
Suited for UI components, complex objects, or any output requiring
consistency.

## Basic snapshots

```ts
import {test, expect} from "bun:test";

test("snap", () => {
  expect("foo").toMatchSnapshot();
});
```

On first run, Bun serializes the value to
`__snapshots__/<test-file>.snap`:

```
// Bun Snapshot v1, https://bun.com/docs/test/snapshots

exports[`snap 1`] = `"foo"`;
```

## Updating snapshots

```bash
bun test --update-snapshots
```

## Inline snapshots

`.toMatchInlineSnapshot()` stores the snapshot in the test file. On
first run, Bun inserts the value automatically:

```ts
import {test, expect} from "bun:test";

// Before first run:
test("inline snapshot", () => {
  expect({hello: "world"}).toMatchInlineSnapshot();
});

// After first run (auto-updated):
test("inline snapshot", () => {
  expect({hello: "world"}).toMatchInlineSnapshot(`
{
  "hello": "world",
}
`);
});
```

## Error snapshots

```ts
import {test, expect} from "bun:test";

test("error snapshot", () => {
  expect(() => {
    throw new Error("Something went wrong");
  }).toThrowErrorMatchingSnapshot();

  expect(() => {
    throw new Error("Another error");
  }).toThrowErrorMatchingInlineSnapshot(`"Another error"`);
});
```

## Advanced usage

### Complex objects

```ts
test("complex object snapshot", () => {
  const user = {
    id: 1,
    name: "John Doe",
    email: "john@example.com",
    profile: {
      age: 30,
      preferences: {theme: "dark", notifications: true}
    },
    tags: ["developer", "javascript", "bun"]
  };
  expect(user).toMatchSnapshot();
});
```

### Array snapshots

```ts
test("array snapshot", () => {
  expect([1, 2, 3, 4, 5].map(n => n * 2)).toMatchSnapshot();
});
```

### Function output snapshots

```ts
function generateReport(data: any[]) {
  return {
    total: data.length,
    summary: data.map(item => ({id: item.id, name: item.name})),
    timestamp: "2024-01-01"
  };
}

test("report generation", () => {
  const data = [
    {id: 1, name: "Alice", age: 30},
    {id: 2, name: "Bob", age: 25}
  ];
  expect(generateReport(data)).toMatchSnapshot();
});
```

## React component snapshots

```tsx
import {test, expect} from "bun:test";
import {render} from "@testing-library/react";

function Button({children, variant = "primary"}) {
  return <button className={`btn btn-${variant}`}>{children}</button>;
}

test("Button component snapshots", () => {
  const {container: primary} = render(<Button>Click me</Button>);
  const {container: secondary} = render(
    <Button variant="secondary">Cancel</Button>
  );
  expect(primary.innerHTML).toMatchSnapshot();
  expect(secondary.innerHTML).toMatchSnapshot();
});
```

## Property `matchers`

For dynamic values (timestamps, IDs), use property `matchers`:

```ts
test("snapshot with dynamic values", () => {
  const user = {
    id: Math.random(),
    name: "John",
    createdAt: new Date().toISOString()
  };
  expect(user).toMatchSnapshot({
    id: expect.any(Number),
    createdAt: expect.any(String)
  });
});
```

## Custom `serializers`

```ts
import {test, expect} from "bun:test";

expect.addSnapshotSerializer({
  test: val => val instanceof Date,
  serialize: val => `"${val.toISOString()}"`
});

test("custom serializer", () => {
  const event = {
    name: "Meeting",
    date: new Date("2024-01-01T10:00:00Z")
  };
  expect(event).toMatchSnapshot();
});
```

## Managing snapshots

### Reviewing changes

```bash
git diff __snapshots__/
bun test --update-snapshots
git add __snapshots__/
```

### Unused snapshots

Bun warns about unused snapshots. Remove them by deleting entries from
the snapshot files.

### Organizing snapshot files

Co-locate snapshot files with their tests:

```
tests/
├── components/
│   ├── Button.test.tsx
│   └── __snapshots__/Button.test.tsx.snap
└── utils/
    ├── formatters.test.ts
    └── __snapshots__/formatters.test.ts.snap
```

## Troubleshooting

### Snapshot failures

```diff
- Expected
+ Received

  Object {
-   "name": "John",
+   "name": "Jane",
  }
```

Causes: intentional change (update snapshots), unintentional change (fix
the code), dynamic data (use property `matchers`), environment
differences (normalize data).

### Platform differences

Normalize platform-specific values before `snapshotting`:

```ts
test("file operations", () => {
  const result = processFile("./test.txt");
  expect({
    ...result,
    path: result.path.replace(/\\/g, "/")
  }).toMatchSnapshot();
});
```
