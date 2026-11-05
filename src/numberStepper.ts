export function clampNumberStepperValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Empty text is an editing state, not an instruction to insert the minimum. */
export function parseNumberStepperInput(text: string, min: number, max: number): number | null {
  const digits = text.replace(/\D/g, "");
  return digits ? clampNumberStepperValue(Number(digits), min, max) : null;
}
