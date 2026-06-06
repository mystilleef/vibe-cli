# Testing in the `DOM`

Bun's test runner works with React Testing Library and happy-dom.

## `happy-dom`

happy-dom implements HTML and DOM `APIs` in plain JavaScript, simulating
a browser environment.

```bash
bun add -d @happy-dom/global-registrator
```

Register `globals` via `preload`:

```ts
import {GlobalRegistrator} from "@happy-dom/global-registrator";
GlobalRegistrator.register();
```

```toml
[test]
preload = ["./happydom.ts"]
```

Browser `APIs` like `document` and `window` become available in tests:

```ts
import {test, expect} from "bun:test";

test("dom test", () => {
  document.body.innerHTML = `<button>My button</button>`;
  const button = document.querySelector("button");
  expect(button?.innerText).toEqual("My button");
});
```

### TypeScript support

Add the triple-slash directive to inject DOM types:

```ts
/// <reference lib="dom" />

import {test, expect} from "bun:test";

test("dom test", () => {
  document.body.innerHTML = `<button>My button</button>`;
  const button = document.querySelector("button");
  expect(button?.innerText).toEqual("My button");
});
```

## `React Testing Library`

Requires happy-dom set up as above:

```bash
bun add -d @testing-library/react @testing-library/jest-dom
```

```ts
/// <reference lib="dom" />

import {test, expect} from "bun:test";
import {render, screen} from "@testing-library/react";
import "@testing-library/jest-dom";

function Button({children}: {children: React.ReactNode}) {
  return <button>{children}</button>;
}

test("renders button", () => {
  render(<Button>Click me</Button>);
  expect(screen.getByRole("button")).toHaveTextContent("Click me");
});
```

## Advanced `DOM` testing

### Custom elements

```ts
/// <reference lib="dom" />

import {test, expect} from "bun:test";

test("custom element", () => {
  class MyElement extends HTMLElement {
    constructor() {
      super();
      this.innerHTML = "<p>Custom element content</p>";
    }
  }

  customElements.define("my-element", MyElement);

  document.body.innerHTML = "<my-element></my-element>";
  const element = document.querySelector("my-element");
  expect(element?.innerHTML).toBe("<p>Custom element content</p>");
});
```

### Event testing

```ts
/// <reference lib="dom" />

import {test, expect} from "bun:test";

test("button click event", () => {
  let clicked = false;

  document.body.innerHTML = '<button id="test-btn">Click me</button>';
  const button = document.getElementById("test-btn");

  button?.addEventListener("click", () => {
    clicked = true;
  });

  button?.click();
  expect(clicked).toBe(true);
});
```

## Global setup

For complex setups, use a single `preload` file:

```ts
import {GlobalRegistrator} from "@happy-dom/global-registrator";
import "@testing-library/jest-dom";

GlobalRegistrator.register();

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn()
  }))
});
```

```toml
[test]
preload = ["./test-setup.ts"]
```

Reset DOM state between tests:

```ts
import {afterEach} from "bun:test";
import {cleanup} from "@testing-library/react";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
```

## Troubleshooting

- **TypeScript errors for DOM APIs**: Add `/// <reference lib="dom" />`
  to the top of test files.
- **Missing globals**: Ensure `@happy-dom/global-registrator` imports
  and registers in your `preload` file.
- **React rendering issues**: Install and configure both
  `@testing-library/react` and happy-dom.
