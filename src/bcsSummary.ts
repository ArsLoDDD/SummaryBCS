import {
  BLOCK_TYPES,
  LOCATIONS,
  emptyPerson,
  normalizedSlots,
  personKey,
  type BlockKind,
  type PersonInput,
  type StructureBlock,
} from "./structure";
import bcsRules from "./shared/bcs-rules.json";

export interface BcsSheetSummary {
  main: Array<[string, number]>;
  functional: Array<[string, number]>;
  locations: Array<[string, number]>;
  rowCount: number;
}

const ABSENT_LOCATIONS = new Set([
  "ВІДП", "ЛІК", "ВЛК", "НАВЧ", "ВІДР", "Відкомандировані", "СЗЧ", "ПТЗ Новостав",
]);
const SUMMARY_UAV_TYPES = [
  "Бомбер", "Коптер", "Літаковий Розвідувальний", "Літаковий Ударний", "НРК", "ФПВ", "ФПВ Перехоплювач",
] as const;
const TVO_DELIMITERS = new Set(bcsRules.tvoDelimiters);

/** Matches Unicode whitespace normalization used by the XLSX reader and exporter. */
export function canonicalPersonnelKey(value: string): string {
  return value.split(/[\s\u0085]+/u).filter(Boolean).join(" ").toLocaleUpperCase("uk-UA");
}

export function isTemporaryActingPosition(value: string): boolean {
  let token = "";
  for (const character of value.toLocaleUpperCase("uk-UA")) {
    if (TVO_DELIMITERS.has(character)) {
      if (token === "ТВО") return true;
      token = "";
    } else token += character;
  }
  return token === "ТВО";
}

function isExternalBlockKind(kind: BlockKind): boolean {
  return kind === "attached" || kind === "operationalSubordination"
    || kind === "temporary" || kind === "temporaryActing";
}

function sectionForBlock(block: StructureBlock): string {
  if (block.kind === "companyManagement") return "Управління роти";
  if (block.kind === "platoonManagement") return "Управління взводу";
  if (block.kind === "crew") return "Екіпаж";
  if (block.kind === "attached") return "Прикомандировані";
  if (block.kind === "operationalSubordination") return "Оперативне підпорядкування";
  if (block.kind === "temporary") return "Тимчасово прибулі";
  if (block.kind === "temporaryActing") return "Тимчасові з ТВО";
  if (block.kind === "unassigned") return "Не розподілені";
  return block.name.trim() || BLOCK_TYPES.find((item) => item.value === block.kind)?.label || "Блок";
}

/** The editor table and data panel read the same deterministic personnel summary. */
export function buildBcsSheetSummary(
  authorizedStrength: number,
  blocks: ReadonlyArray<StructureBlock>,
  peopleBySlot: Readonly<Record<string, PersonInput>>,
): BcsSheetSummary {
  const populated = blocks.flatMap((block) =>
    Array.from({ length: normalizedSlots(block.slots) }, (_, index) => ({
      block,
      person: peopleBySlot[personKey(block.id, index)] ?? emptyPerson(block.id),
    })),
  ).filter(({ person }) => canonicalPersonnelKey(person.fullName));
  const isOwn = (block: StructureBlock) => !isExternalBlockKind(block.kind);
  const isActing = (block: StructureBlock, person: PersonInput) =>
    block.kind === "temporaryActing"
    || (block.kind === "temporary" && isTemporaryActingPosition(person.position));
  const countOwnLocation = (location: string) => populated.filter(({ block, person }) =>
    isOwn(block) && person.location === location,
  ).length;
  const main: Array<[string, number]> = [
    ["По штату", authorizedStrength],
    ["По списку", populated.filter(({ block, person }) => isOwn(block) || isActing(block, person)).length],
    ["В наявності", populated.filter(({ block, person }) => isOwn(block) && !ABSENT_LOCATIONS.has(person.location)).length],
    ["Відпустка", countOwnLocation("ВІДП")],
    ["Шпиталь", countOwnLocation("ЛІК") + countOwnLocation("ВЛК")],
    ["Відрядження", countOwnLocation("НАВЧ") + countOwnLocation("ВІДР")],
    ["Відкомандировані", countOwnLocation("Відкомандировані")],
    ["Прикомандировані", populated.filter(({ block }) => block.kind === "attached").length],
    ["Оперативне підпорядкування", populated.filter(({ block }) => block.kind === "operationalSubordination").length],
    ["ПТЗ Новостав", countOwnLocation("ПТЗ Новостав")],
    ["СЗЧ", countOwnLocation("СЗЧ")],
    ["Тимчасово прибулі", populated.filter(({ block }) => block.kind === "temporary" || block.kind === "temporaryActing").length],
    ["Тимчасово прибулі з ТВО", populated.filter(({ block, person }) => isActing(block, person)).length],
  ];
  const crews = blocks.filter((block) => block.kind === "crew");
  const uniqueCrewPersonnel = new Set(populated
    .filter(({ block }) => block.kind === "crew")
    .map(({ person }) => canonicalPersonnelKey(person.fullName)),
  ).size;
  const functional = crewFunctionalSummaryRows(crews, SUMMARY_UAV_TYPES, uniqueCrewPersonnel);
  const seenSections = new Set<string>();
  blocks.forEach((block) => {
    if (block.kind === "crew" || !isOwn(block)) return;
    const section = sectionForBlock(block);
    if (seenSections.has(section)) return;
    seenSections.add(section);
    functional.push([section, populated.filter(({ block: candidate, person }) =>
      candidate.kind !== "crew" && isOwn(candidate)
      && sectionForBlock(candidate) === section && !ABSENT_LOCATIONS.has(person.location),
    ).length]);
  });
  const locations: Array<[string, number]> = LOCATIONS.map((location) => [
    location, populated.filter(({ person }) => person.location === location).length,
  ]);
  locations.push(["Не вказано / інше", populated.filter(({ person }) => !LOCATIONS.includes(person.location)).length]);
  locations.push(["Загалом", populated.length]);
  return { main, functional, locations, rowCount: Math.max(main.length, functional.length, locations.length) };
}

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
