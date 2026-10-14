import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RegistryHistoryInput, { getRegistryHistoryKeyAction } from "./RegistryHistoryInput";
import {
  collectRegistryHistory,
  filterRegistryHistoryValues,
  uniqueRegistryHistoryValues,
} from "./registryHistory";
import {
  createEmptyStripsRegistry,
  createRegistryCrew,
  createRegistryPosition,
} from "./stripsRegistry";

describe("registry history fields", () => {
  it("keeps the first spelling of unique non-empty values", () => {
    expect(uniqueRegistryHistoryValues([
      " 1 РУБАК ",
      "1 рубак",
      "",
      "   ",
      "Смуга   ПІВНІЧ",
    ])).toEqual(["1 РУБАК", "Смуга ПІВНІЧ"]);
  });

  it("filters suggestions by a case-insensitive partial match", () => {
    expect(filterRegistryHistoryValues(
      ["1 РУБАК", "Саперний взвод", "2 РУБАК"],
      "руб",
    )).toEqual(["1 РУБАК", "2 РУБАК"]);
  });

  it("collects strips and BROs from positions and units from both registries", () => {
    const data = createEmptyStripsRegistry("2026-10-14");
    data.crews.push({ ...createRegistryCrew(), unit: "1 РУБАК" });
    data.positions.push(
      {
        ...createRegistryPosition(),
        strip: "Смуга ПІВНІЧ",
        unit: "1 рубак",
        bro: "БРО-1",
      },
      {
        ...createRegistryPosition(),
        strip: "смуга північ",
        unit: "2 РУБАК",
        bro: "бро-1",
      },
    );

    expect(collectRegistryHistory(data)).toEqual({
      strips: ["Смуга ПІВНІЧ"],
      units: ["1 РУБАК", "2 РУБАК"],
      bros: ["БРО-1"],
    });
  });

  it("renders a free-text accessible combobox without a native datalist", () => {
    const markup = renderToStaticMarkup(createElement(RegistryHistoryInput, {
      ariaLabel: "Підрозділ",
      value: "руб",
      options: ["1 РУБАК", "Саперний взвод"],
      onChange: () => undefined,
    }));

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-autocomplete="list"');
    expect(markup).toContain('value="руб"');
    expect(markup).not.toContain("<datalist");
    expect(markup).not.toContain(' list=');
  });

  it("opens and cycles through filtered options with the arrow keys", () => {
    expect(getRegistryHistoryKeyAction("ArrowDown", false, -1, 3)).toEqual({
      activeIndex: 0,
      open: true,
      preventDefault: true,
      selectedIndex: null,
    });
    expect(getRegistryHistoryKeyAction("ArrowDown", true, 0, 3)?.activeIndex).toBe(1);
    expect(getRegistryHistoryKeyAction("ArrowUp", true, 0, 3)?.activeIndex).toBe(2);
  });

  it("selects the active suggestion with Enter and closes with Escape", () => {
    expect(getRegistryHistoryKeyAction("Enter", true, 1, 3)).toEqual({
      activeIndex: 1,
      open: false,
      preventDefault: true,
      selectedIndex: 1,
    });
    expect(getRegistryHistoryKeyAction("Escape", true, 1, 3)).toEqual({
      activeIndex: 1,
      open: false,
      preventDefault: true,
      selectedIndex: null,
    });
  });

  it("preserves form Enter when no suggestion is active", () => {
    expect(getRegistryHistoryKeyAction("Enter", false, -1, 0)).toBeNull();
    expect(getRegistryHistoryKeyAction("Enter", true, -1, 0)).toBeNull();
  });
});
