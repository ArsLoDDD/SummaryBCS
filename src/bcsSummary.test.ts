import { describe, expect, it } from "vitest";
import { crewFunctionalSummaryRows, crewTypeSummaryRows } from "./bcsSummary";

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

describe("crewFunctionalSummaryRows", () => {
  it("matches the seven-crew export scenario", () => {
    const crews = Array.from({ length: 7 }, (_, index) => ({
      status: index < 4 ? "Працюючий" : "Не активний",
      uavType: "Літаковий Розвідувальний",
    }));

    expect(crewFunctionalSummaryRows(crews, ["Літаковий Розвідувальний", "ФПВ"], 14)).toEqual([
      ["Екіпажів (ос-загально)", 14],
      ["Екіпажів (загально)", 7],
      ["Екіпажів — Літаковий Розвідувальний", 7],
      ["Екіпажів — Формуються", 0],
      ["Екіпажів — Працюючі", 4],
      ["Екіпажів — Не активні", 3],
    ]);
  });
});
