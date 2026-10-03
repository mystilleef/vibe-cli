/**
 * Direct coverage of the deterministic list-collection helpers shared by
 * storage, prune, and list-data layers: `groupBy` ordering contracts,
 * locale-independent text comparison, and `applyListLimit` boundaries.
 */
import { describe, expect, test } from "bun:test";
import {
  applyListLimit,
  compareListText,
  groupBy,
} from "../src/utils/listDataUtilsCollections.js";

describe("groupBy", () => {
  test("returns an empty map for empty input", () => {
    expect(groupBy([], () => "x")).toEqual(new Map());
  });

  test("preserves first-seen group insertion order", () => {
    const groups = groupBy(
      [{ k: "b" }, { k: "a" }, { k: "b" }],
      (item) => item.k,
    );
    expect([...groups.keys()]).toEqual(["b", "a"]);
  });

  test("preserves item order within each group", () => {
    const groups = groupBy(
      [
        { k: "x", v: 1 },
        { k: "y", v: 2 },
        { k: "x", v: 3 },
      ],
      (item) => item.k,
    );
    expect(groups.get("x")?.map((item) => item.v)).toEqual([1, 3]);
    expect(groups.get("y")?.map((item) => item.v)).toEqual([2]);
  });

  test("separates items across multiple keys", () => {
    const groups = groupBy([1, 2, 3, 4], (n) => (n % 2 === 0 ? "even" : "odd"));
    expect(groups.get("even")).toEqual([2, 4]);
    expect(groups.get("odd")).toEqual([1, 3]);
  });
});

describe("compareListText", () => {
  test.each([
    {
      name: "equal strings compare equal",
      left: "apple",
      right: "apple",
      expected: 0,
    },
    {
      name: "left sorts before right",
      left: "apple",
      right: "banana",
      expected: -1,
    },
    {
      name: "left sorts after right",
      left: "banana",
      right: "apple",
      expected: 1,
    },
    {
      name: "uppercase sorts before lowercase bytes",
      left: "Z",
      right: "a",
      expected: -1,
    },
    {
      name: "lowercase sorts after uppercase bytes",
      left: "a",
      right: "Z",
      expected: 1,
    },
    {
      name: "prefix sorts before extension",
      left: "cat",
      right: "category",
      expected: -1,
    },
  ])("$name", ({ left, right, expected }) => {
    expect(compareListText(left, right)).toBe(expected);
  });
});

describe("applyListLimit", () => {
  test("returns a copy of all items when limit is undefined", () => {
    const source = [1, 2, 3];
    expect(applyListLimit(source)).toEqual([1, 2, 3]);
  });

  test("returns an empty copy for a zero limit", () => {
    expect(applyListLimit([1, 2, 3], 0)).toEqual([]);
  });

  test("returns all items when the limit exceeds the length", () => {
    expect(applyListLimit([1, 2], 5)).toEqual([1, 2]);
  });

  test("caps without mutating the source", () => {
    const source = [1, 2, 3];
    expect(applyListLimit(source, 2)).toEqual([1, 2]);
    expect(source).toEqual([1, 2, 3]);
  });
});
