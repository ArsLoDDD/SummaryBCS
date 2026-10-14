import type { StripsRegistryData } from "./stripsRegistry";

export interface RegistryHistoryOptions {
  strips: string[];
  units: string[];
  bros: string[];
}

function normalizedHistoryValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk-UA");
}

export function uniqueRegistryHistoryValues(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawValue of values) {
    const value = rawValue.trim().replace(/\s+/g, " ");
    const normalized = normalizedHistoryValue(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }

  return result;
}

export function filterRegistryHistoryValues(values: ReadonlyArray<string>, query: string): string[] {
  const normalizedQuery = normalizedHistoryValue(query);
  if (!normalizedQuery) return [...values];
  return values.filter((value) => normalizedHistoryValue(value).includes(normalizedQuery));
}

export function collectRegistryHistory(data: StripsRegistryData): RegistryHistoryOptions {
  return {
    strips: uniqueRegistryHistoryValues(data.positions.map((position) => position.strip)),
    units: uniqueRegistryHistoryValues([
      ...data.crews.map((crew) => crew.unit),
      ...data.positions.map((position) => position.unit),
    ]),
    bros: uniqueRegistryHistoryValues(data.positions.map((position) => position.bro)),
  };
}
