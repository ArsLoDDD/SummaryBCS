import { describe, expect, it } from "vitest";
import { crewTypeSummaryRows } from "./bcsSummary";

describe("crewTypeSummaryRows", () => {
  it("shows only UAV types that are used by at least one crew", () => {
    const crews = [
      { uavType: "ФПВ" },
      { uavType: "ФПВ" },
      { uavType: "Бомбер" },
    ];

    expect(crewTypeSummaryRows(crews, ["Бомбер", "Коптер", "ФПВ"])).toEqual([
      ["Екіпажів — Бомбер", 1],
      ["Екіпажів — ФПВ", 2],
    ]);
  });

  it("returns no type rows when every configured type has zero crews", () => {
    expect(crewTypeSummaryRows([], ["Бомбер", "ФПВ"])).toEqual([]);
  });
});
