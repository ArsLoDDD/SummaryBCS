import { describe, expect, it } from "vitest";
import {
  BLOCK_TYPES,
  LOCATIONS,
  QUICK_BLOCK_TYPES,
  STRUCTURE_TYPES,
  createBlock,
  createDefaultCompanyBlocks,
  deduplicateSingletonBlocks,
  emptyPerson,
  formatBlockName,
  formatFullName,
  formatReportDateForExport,
  isRequiredManagementBlock,
  missingRequiredPersonFields,
  normalizeLegacyBlockName,
  peopleForExport,
  personHasAnyData,
  quickBlockTypesForStructure,
  reconcileBlocksForStructure,
  sortBlocksByBcsOrder,
  totalSlots,
  validateWorkspace,
  withDefaultBlockNames,
  type StructureBlock,
} from "./structure";

const blocks: StructureBlock[] = [
  { id: "management", kind: "companyManagement", name: "Управління", positionName: "", slots: 2, status: "", uavType: "", bro: "", workSector: "", uavName: "", crewActual: 0 },
  { id: "crew", kind: "crew", name: "Екіпаж 1", positionName: "Позиція 1", slots: 3, status: "Працюючий", uavType: "ФПВ", bro: "", workSector: "", uavName: "", crewActual: 4 },
];

describe("structure helpers", () => {
  it("offers only company and platoon structures", () => {
    expect(STRUCTURE_TYPES.map((item) => item.value)).toEqual(["company", "platoon"]);
  });

  it("counts every configured place", () => {
    expect(totalSlots(blocks)).toBe(5);
  });

  it("keeps the configured number and order of personnel rows", () => {
    const filled = { ...emptyPerson("crew"), fullName: "ОСОБА-001", location: "На позиції" };
    const people = peopleForExport(blocks, { "crew:1": filled });

    expect(people).toHaveLength(5);
    expect(people[3]).toEqual(filled);
    expect(people.map((person) => person.blockId)).toEqual([
      "management",
      "management",
      "crew",
      "crew",
      "crew",
    ]);
  });

  it("requires rank, name and location in every configured person row", () => {
    const blank = emptyPerson("crew");
    expect(personHasAnyData(blank)).toBe(false);
    expect(missingRequiredPersonFields(blank)).toEqual(["Звання", "П.І.Б.", "Де знаходиться"]);

    const partial = { ...blank, position: "Оператор", rank: "солдат" };
    expect(personHasAnyData(partial)).toBe(true);
    expect(missingRequiredPersonFields(partial)).toEqual(["П.І.Б.", "Де знаходиться"]);

    const complete = { ...partial, fullName: "ІВАНОВ Іван", location: "На позиції" };
    expect(missingRequiredPersonFields(complete)).toEqual([]);
  });

  it("keeps authorized strength informational and independent from personnel rows", () => {
    expect(validateWorkspace("", "2026-10-08", "company", 5, blocks)).toBe("Вкажіть назву підрозділу.");
    expect(validateWorkspace("Рота", "2026-10-08", "company", 4, blocks)).toBe("");
    expect(validateWorkspace("Рота", "2026-10-08", "company", 79, blocks)).toBe("");
    expect(validateWorkspace("Рота", "2026-10-08", "company", 5, blocks)).toBe("");
  });

  it("keeps actual crew strength independent from configured people", () => {
    expect(blocks[1].slots).toBe(3);
    expect(blocks[1].crewActual).toBe(4);
  });

  it("converts the date to the workbook format", () => {
    expect(formatReportDateForExport("2026-10-08")).toBe("08.10.2026");
  });

  it("keeps only the surname in uppercase", () => {
    expect(formatFullName("іванов іВАН іванович")).toBe("ІВАНОВ Іван Іванович");
    expect(formatFullName("  петренко  о.п. ")).toBe("  ПЕТРЕНКО  О.П. ");
  });

  it("uppercases crew names but only starts other block names with a capital letter", () => {
    expect(formatBlockName("crew", "екіпаж альфа")).toBe("ЕКІПАЖ АЛЬФА");
    expect(formatBlockName("department", "відділення БпАК")).toBe("Відділення БпАК");
    expect(normalizeLegacyBlockName("department", "ВІДДІЛЕННЯ 1")).toBe("Відділення 1");
    expect(normalizeLegacyBlockName("custom", "ІНШІ")).toBe("Інші");
  });

  it("offers every standard block while keeping the main shortcuts simple", () => {
    expect(BLOCK_TYPES).toHaveLength(12);
    expect(BLOCK_TYPES.some((item) => item.value === "informationDepartment")).toBe(true);
    expect(BLOCK_TYPES.some((item) => item.value === "operationalSubordination")).toBe(true);
    expect(QUICK_BLOCK_TYPES.map((item) => item.value)).toEqual([
      "crew",
      "companyManagement",
      "platoonManagement",
      "department",
      "custom",
      "attached",
      "operationalSubordination",
      "temporary",
      "temporaryActing",
    ]);
    expect(quickBlockTypesForStructure("company").map((item) => item.value)).not.toContain("companyManagement");
    expect(quickBlockTypesForStructure("company").map((item) => item.value)).toContain("platoonManagement");
    expect(quickBlockTypesForStructure("platoon").map((item) => item.value)).not.toContain("companyManagement");
    expect(quickBlockTypesForStructure("platoon").map((item) => item.value)).not.toContain("platoonManagement");
  });

  it("creates the default company structure with six crews and singleton blocks", () => {
    const defaults = createDefaultCompanyBlocks();
    expect(defaults).toHaveLength(10);
    expect(defaults.filter((block) => block.kind === "crew")).toHaveLength(6);
    expect(defaults.filter((block) => block.kind === "companyManagement")).toHaveLength(1);
    expect(defaults.filter((block) => block.kind === "platoonManagement")).toHaveLength(1);
    expect(defaults.filter((block) => block.kind === "custom")).toHaveLength(1);
    expect(defaults.find((block) => block.kind === "department")?.name).toBe("Відділення 1");
    expect(defaults.every((block) => block.name.trim())).toBe(true);
    expect(defaults.map((block) => block.kind)).toEqual([
      "crew",
      "crew",
      "crew",
      "crew",
      "crew",
      "crew",
      "companyManagement",
      "platoonManagement",
      "department",
      "custom",
    ]);
  });

  it("keeps the required management block fixed for company and platoon", () => {
    const company = reconcileBlocksForStructure(
      "company",
      createDefaultCompanyBlocks().filter((block) => block.kind !== "companyManagement"),
    );
    expect(company.filter((block) => block.kind === "companyManagement")).toHaveLength(1);
    expect(isRequiredManagementBlock("company", "companyManagement")).toBe(true);

    const platoon = reconcileBlocksForStructure("platoon", createDefaultCompanyBlocks());
    expect(platoon.some((block) => block.kind === "companyManagement")).toBe(false);
    expect(platoon.filter((block) => block.kind === "platoonManagement")).toHaveLength(1);
    expect(isRequiredManagementBlock("platoon", "platoonManagement")).toBe(true);
  });

  it("gives every newly added block a usable default name", () => {
    expect(createBlock("crew").name).toBe("ЕКІПАЖ");
    expect(createBlock("department").name).toBe("Відділення");
    expect(createBlock("temporaryActing").name).toBe("Тимчасові з ТВО");
  });

  it("repairs blank legacy names and removes duplicate singleton blocks", () => {
    const legacy = [
      { ...blocks[0], id: "other-empty", kind: "custom" as const, name: "" },
      { ...blocks[0], id: "other-named", kind: "custom" as const, name: "ІНШІ" },
      blocks[1],
    ];
    const repaired = withDefaultBlockNames(deduplicateSingletonBlocks(legacy));

    expect(repaired.filter((block) => block.kind === "custom")).toHaveLength(1);
    expect(repaired.find((block) => block.kind === "custom")?.id).toBe("other-named");
    expect(repaired.every((block) => block.name.trim())).toBe(true);
  });

  it("keeps reconnaissance and setup as separate location choices", () => {
    expect(LOCATIONS).toContain("Реко");
    expect(LOCATIONS).toContain("Облаштування");
    expect(LOCATIONS).not.toContain("Реко та облаштування");
  });

  it("keeps the same block sequence as the reference BCS", () => {
    const ordered = sortBlocksByBcsOrder([
      { ...blocks[0], id: "temporary", kind: "temporary" },
      { ...blocks[0], id: "temporary-acting", kind: "temporaryActing" },
      { ...blocks[0], id: "other", kind: "custom" },
      blocks[0],
      { ...blocks[0], id: "department", kind: "department" },
      blocks[1],
      { ...blocks[0], id: "attached", kind: "attached" },
      { ...blocks[0], id: "operational", kind: "operationalSubordination" },
      { ...blocks[0], id: "platoon", kind: "platoonManagement" },
    ]);

    expect(ordered.map((block) => block.kind)).toEqual([
      "crew",
      "companyManagement",
      "platoonManagement",
      "department",
      "custom",
      "attached",
      "operationalSubordination",
      "temporary",
      "temporaryActing",
    ]);
  });
});
