export function crewTypeSummaryRows(
  crews: ReadonlyArray<{ uavType: string }>,
  uavTypes: readonly string[],
): Array<[string, number]> {
  return uavTypes.flatMap((uavType) => {
    const count = crews.filter((crew) => crew.uavType === uavType).length;
    return count > 0 ? [[`Екіпажів — ${uavType}`, count] as [string, number]] : [];
  });
}

export type CrewStatusGroup = "forming" | "working" | "inactive";

export function crewStatusGroup(status: string): CrewStatusGroup {
  const normalized = status.toLocaleUpperCase("uk-UA").replace(/\s+/g, "");
  if (normalized.startsWith("ФОРМ")) return "forming";
  if (normalized.startsWith("ПРАЦ") || normalized === "АКТИВНИЙ") return "working";
  return "inactive";
}

export function crewFunctionalSummaryRows(
  crews: ReadonlyArray<{ status: string; uavType: string }>,
  uavTypes: readonly string[],
  uniqueCrewPersonnel: number,
): Array<[string, number]> {
  return [
    ["Екіпажів (ос-загально)", uniqueCrewPersonnel],
    ["Екіпажів (загально)", crews.length],
    ...crewTypeSummaryRows(crews, uavTypes),
    ["Екіпажів — Формуються", crews.filter((crew) => crewStatusGroup(crew.status) === "forming").length],
    ["Екіпажів — Працюючі", crews.filter((crew) => crewStatusGroup(crew.status) === "working").length],
    ["Екіпажів — Не активні", crews.filter((crew) => crewStatusGroup(crew.status) === "inactive").length],
  ];
}
