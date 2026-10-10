import { describe, expect, it } from "vitest";
import { moveUnit } from "./model";

describe("moveUnit", () => {
  it("moves a unit while preserving the other relative positions", () => {
    expect(moveUnit(["А", "Б", "В"], 0, 2)).toEqual(["Б", "В", "А"]);
  });

  it("ignores an invalid target", () => {
    const units = ["А", "Б"];
    expect(moveUnit(units, 0, 5)).toBe(units);
  });
});

