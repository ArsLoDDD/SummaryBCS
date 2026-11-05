// Optional private fixture lives outside the repository and is never included in a build.
// @ts-expect-error Node is available in Vitest, not the browser application.
import { readFileSync } from "node:fs";
// @ts-expect-error Node is available in Vitest, not the browser application.
import process from "node:process";
import { describe, expect, it } from "vitest";
import { restoreWorkspaceDraft } from "./bcsWorkspaceDraft";
import { buildBcsSheetSummary } from "./bcsSummary";
import { createBlock, emptyPerson, missingRequiredPersonFields, peopleForExport, totalSlots, type BlockKind } from "./structure";

const referencePath = process.env.BCSEDITOR_IMPORT_JSON_OUTPUT;

function legacyDraft() {
  const block = { ...createBlock("companyManagement"), id: "management", slots: 2 };
  return {
    version: 1, unitName: "Тестова рота", reportDate: "2026-10-08", structureType: "company",
    authorizedStrength: 10, blocks: [block], peopleBySlot: {
      "management:0": { ...emptyPerson("management"), fullName: "тестовий іван", rank: "солдат", location: "ПУ", note: "Перший рядок\nДругий рядок" },
    },
  };
}

describe("BCS imported and saved workspace restoration", () => {
  it("restores legacy drafts and retains every entity and link after save/reopen", () => {
    const raw = legacyDraft();
    const restored = restoreWorkspaceDraft({
      ...raw,
      positions: [
        { id: "used", name: "ПОЗИЦІЯ", bro: "БРО", workSector: "СЕКТОР" },
        { id: "reserve", name: "РЕЗЕРВНА", bro: "", workSector: "" },
      ],
      positionByBlock: { management: "used" }, importWarnings: ["Зауваження до джерела"],
    });
    expect(restored).not.toBeNull();
    const reopened = restoreWorkspaceDraft(JSON.parse(JSON.stringify(restored!.draft)));
    expect(reopened).toEqual(restored);
    expect(reopened!.data.positions).toHaveLength(2);
    expect(reopened!.data.blocks[0]).toMatchObject({ positionName: "ПОЗИЦІЯ", bro: "БРО", workSector: "СЕКТОР" });
    expect(reopened!.data.peopleBySlot["management:0"].note).toBe("Перший рядок\nДругий рядок");
  });

  it("rejects damaged or unsupported data rather than replacing it with defaults", () => {
    for (const raw of [null, {}, { ...legacyDraft(), version: 99 }, { ...legacyDraft(), peopleBySlot: { broken: null } }, { ...legacyDraft(), positions: [{}] }]) {
      expect(restoreWorkspaceDraft(raw)).toBeNull();
    }
  });

  it("preserves obsolete location values and keeps export blocked until they are corrected", () => {
    const raw = legacyDraft();
    raw.peopleBySlot["management:0"].location = "Реко та облаштування";
    const restored = restoreWorkspaceDraft(raw)!;
    expect(restored.data.peopleBySlot["management:0"].location).toBe("Реко та облаштування");
    expect(missingRequiredPersonFields(restored.data.peopleBySlot["management:0"]))
      .toEqual(["Де знаходиться (оберіть зі списку)"]);
  });

  it.each<BlockKind>(["custom", "companyManagement", "platoonManagement"])("preserves every legacy duplicate %s block instead of discarding its metadata", (kind) => {
    const first = { ...createBlock(kind), id: "first", name: "Перший блок", positionName: "ПОЗИЦІЯ А" };
    const duplicate = {
      ...createBlock(kind), id: "duplicate", name: "Другий блок", slots: 3,
      positionName: "ПОЗИЦІЯ Б", bro: "БРО Б", workSector: "СЕКТОР Б", uavName: "Старі дані БпАК",
    };
    const person = { ...emptyPerson(duplicate.id), fullName: "ТЕСТОВИЙ Іван", rank: "солдат", location: "ПУ", note: "Не втратити" };
    const raw = legacyDraft();
    const restored = restoreWorkspaceDraft({
      ...raw,
      blocks: kind === "companyManagement" ? [first, duplicate] : [...raw.blocks, first, duplicate],
      peopleBySlot: { "duplicate:2": person }, importWarnings: ["Попереднє зауваження"],
    })!;
    expect(restored.data.blocks.filter((block) => block.kind === kind)).toHaveLength(1);
    expect(restored.data.blocks.find((block) => block.id === first.id)?.kind).toBe(kind);
    expect(restored.data.blocks.find((block) => block.id === duplicate.id)).toEqual({ ...duplicate, kind: "unassigned" });
    expect(restored.data.peopleBySlot["duplicate:2"]).toEqual(person);
    expect(restored.data.positions.map((position) => position.name)).toContain("ПОЗИЦІЯ Б");
    expect(restored.data.positionByBlock.duplicate).toBeTruthy();
    expect(restored.draft.importWarnings).toHaveLength(2);
    expect(restored.draft.importWarnings?.[1]).toContain("Другий блок");
    expect(restoreWorkspaceDraft(JSON.parse(JSON.stringify(restored.draft)))).toEqual(restored);
  });

  it("retains explicit position links and unused positions while migrating a duplicate singleton", () => {
    const raw = legacyDraft();
    const first = { ...createBlock("custom"), id: "first-other", name: "Інші" };
    const duplicate = { ...createBlock("custom"), id: "second-other", name: "Інші резервні" };
    const positions = [
      { id: "linked", name: "ПОВ’ЯЗАНА ПОЗИЦІЯ", bro: "БРО", workSector: "СЕКТОР" },
      { id: "unused", name: "РЕЗЕРВ", bro: "", workSector: "" },
    ];
    const restored = restoreWorkspaceDraft({
      ...raw, blocks: [...raw.blocks, first, duplicate], positions,
      positionByBlock: { "second-other": "linked" },
    })!;
    expect(restored.data.positions).toEqual(positions);
    expect(restored.data.positionByBlock["second-other"]).toBe("linked");
    expect(restored.data.blocks.find((block) => block.id === "second-other")).toMatchObject({
      kind: "unassigned", name: "Інші резервні", positionName: "ПОВ’ЯЗАНА ПОЗИЦІЯ", bro: "БРО", workSector: "СЕКТОР",
    });
    expect(restoreWorkspaceDraft(JSON.parse(JSON.stringify(restored.draft)))).toEqual(restored);
  });

  it("retains incompatible company management in a platoon alongside existing unassigned blocks", () => {
    const raw = legacyDraft();
    const management = { ...raw.blocks[0], name: "Управління старої роти", positionName: "ПОЗИЦІЯ РОТИ", bro: "БРО РОТИ", workSector: "СЕКТОР РОТИ" };
    const unassigned = { ...createBlock("unassigned"), id: "unassigned-existing", name: "Резерв" };
    const restored = restoreWorkspaceDraft({ ...raw, structureType: "platoon", blocks: [management, unassigned] })!;
    expect(restored.data.blocks.filter((block) => block.kind === "companyManagement")).toHaveLength(0);
    expect(restored.data.blocks.filter((block) => block.kind === "platoonManagement")).toHaveLength(1);
    expect(restored.data.blocks.filter((block) => block.kind === "unassigned")).toHaveLength(2);
    expect(restored.data.blocks.find((block) => block.id === management.id)).toEqual({ ...management, kind: "unassigned" });
    expect(restored.data.peopleBySlot["management:0"]).toMatchObject({ blockId: "management", fullName: "ТЕСТОВИЙ Іван", note: "Перший рядок\nДругий рядок" });
    expect(restored.data.positions.map((position) => position.name)).toContain("ПОЗИЦІЯ РОТИ");
    expect(restored.draft.importWarnings?.[0]).toContain("Управління роти у структурі взводу");
    expect(restoreWorkspaceDraft(JSON.parse(JSON.stringify(restored.draft)))).toEqual(restored);
  });

  it.skipIf(!referencePath)("reopens all fields of the actual imported reference without losing personnel, positions or notes", () => {
    const imported = JSON.parse(readFileSync(referencePath!, "utf8"));
    const restored = restoreWorkspaceDraft({ ...imported, importWarnings: imported.warnings })!;
    const reopened = restoreWorkspaceDraft(JSON.parse(JSON.stringify(restored.draft)))!;
    expect(Boolean(restored && reopened)).toBe(true);
    expect(JSON.stringify(reopened) === JSON.stringify(restored)).toBe(true);
    expect(totalSlots(reopened.data.blocks)).toBe(74);
    expect(reopened.data.blocks).toHaveLength(19);
    expect(reopened.data.positions).toHaveLength(8);
    expect(Object.keys(reopened.data.positionByBlock)).toHaveLength(12);
    const people = peopleForExport(reopened.data.blocks, reopened.data.peopleBySlot);
    expect(people.filter((person) => person.fullName)).toHaveLength(74);
    expect(people.filter((person) => person.note)).toHaveLength(46);
    expect(people.filter((person) => person.duties)).toHaveLength(50);
    expect(people.filter((person) => missingRequiredPersonFields(person).length > 0)).toHaveLength(0);
    const crews = reopened.data.blocks.filter((block) => block.kind === "crew");
    expect(crews).toHaveLength(12);
    expect(crews.reduce((sum, block) => sum + block.crewActual, 0)).toBe(47);
    expect(crews.reduce((sum, block) => sum + block.slots, 0)).toBe(46);
    const summary = buildBcsSheetSummary(reopened.draft.authorizedStrength, reopened.data.blocks, reopened.data.peopleBySlot);
    expect(Object.fromEntries(summary.main)).toMatchObject({
      "По штату": 72, "По списку": 71, "В наявності": 53,
      "Прикомандировані": 2, "Тимчасово прибулі": 2, "Тимчасово прибулі з ТВО": 1,
    });
    expect(Object.fromEntries(summary.functional)).toMatchObject({
      "Екіпажів (ос-загально)": 46, "Екіпажів (загально)": 12,
      "Екіпажів — Формуються": 3, "Екіпажів — Працюючі": 7, "Екіпажів — Не активні": 2,
    });
    expect(Object.fromEntries(summary.locations).Загалом).toBe(74);
  });
});
