import { describe, expect, test } from "bun:test";
import { cycleSortMode } from "./sort";

describe("cycleSortMode", () => {
  test("walks name↑ → size↓ → mtime↑ → type↑ → name↑ (menu naturals)", () => {
    expect(cycleSortMode("name")).toEqual({ sortBy: "size", sortAsc: false });
    expect(cycleSortMode("size")).toEqual({ sortBy: "mtime", sortAsc: true });
    expect(cycleSortMode("mtime")).toEqual({ sortBy: "type", sortAsc: true });
    expect(cycleSortMode("type")).toEqual({ sortBy: "name", sortAsc: true });
  });
});
