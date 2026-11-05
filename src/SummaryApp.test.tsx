import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComparisonResults } from "./SummaryApp";
import type { ComparisonResult } from "./model";

function result(patch: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    scope: "general", title: "Порівняння БЧС", beforeDate: "08.10.2026", afterDate: "09.10.2026",
    beforeUnitCount: 2, afterUnitCount: 2, highlights: [], headline: [], sections: [],
    unitChanges: [], personnelChanges: [], structureChanges: [], warnings: [], hasChanges: false,
    ...patch,
  };
}

describe("comparison result completeness", () => {
  it("shows crew and position changes even if all aggregate counts are unchanged", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonResults, { result: result({
      hasChanges: true, structureChanges: ["Екіпаж АЛЬФА: фактично 1 → 3"],
    }) }));
    expect(markup).toContain("Зміни екіпажів і позицій");
    expect(markup).toContain("Екіпаж АЛЬФА: фактично 1 → 3");
    expect(markup).not.toContain("Змін не виявлено");
  });

  it("does not claim no changes when duplicate names prevent reliable matching", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonResults, { result: result({
      warnings: ["Однакові ПІБ потребують перевірки"],
    }) }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Однакові ПІБ потребують перевірки");
    expect(markup).not.toContain("Змін не виявлено");
  });

  it("keeps the clear no-change confirmation for an unambiguous unchanged comparison", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonResults, { result: result() }));
    expect(markup).toContain("Змін не виявлено");
    expect(markup).not.toContain('role="alert"');
  });
});
