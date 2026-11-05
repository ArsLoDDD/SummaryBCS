import { describe, expect, it } from "vitest";
import { clampNumberStepperValue, parseNumberStepperInput } from "./numberStepper";

describe("number stepper text editing", () => {
  it("keeps clearing separate from the minimum and lets 72 be retyped as 72, not 172", () => {
    let display = "72";
    let committed = 72;
    const change = (text: string) => {
      const parsed = parseNumberStepperInput(text, 1, 20000);
      display = parsed === null ? "" : String(parsed);
      if (parsed !== null) committed = parsed;
    };
    change("");
    expect(display).toBe("");
    expect(committed).toBe(72);
    change(`${display}7`);
    change(`${display}2`);
    expect(display).toBe("72");
    expect(committed).toBe(72);
  });

  it("applies the minimum on blur only when the input is still empty", () => {
    expect(parseNumberStepperInput("", 1, 2000)).toBeNull();
    expect(parseNumberStepperInput("", 1, 2000) ?? 1).toBe(1);
    expect(parseNumberStepperInput("", 0, 2000) ?? 0).toBe(0);
  });

  it("keeps zero where allowed and clamps committed values to safe integer limits", () => {
    expect(parseNumberStepperInput("0", 0, 2000)).toBe(0);
    expect(parseNumberStepperInput("0", 1, 2000)).toBe(1);
    expect(parseNumberStepperInput("99999", 1, 2000)).toBe(2000);
    expect(parseNumberStepperInput("9".repeat(1000), 1, 2000)).toBe(2000);
    expect(parseNumberStepperInput("72", 1, 20000)).toBe(72);
    expect(clampNumberStepperValue(3.9, 1, 2000)).toBe(3);
    expect(clampNumberStepperValue(-1, 1, 2000)).toBe(1);
  });
});
