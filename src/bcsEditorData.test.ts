import { describe, expect, it } from "vitest";
import {
  addEditorPerson,
  createEditorPosition,
  editorPersonnelRows,
  moveEditorPerson,
  normalizeEditorData,
  removeEditorBlock,
  removeEditorPerson,
  removeEditorPosition,
  saveEditorPosition,
  setEditorBlockPosition,
  updateEditorBlock,
  updateEditorPerson,
} from "./bcsEditorData";
import { createBlock, emptyPerson, peopleForExport, personKey, type PersonInput, type StructureBlock } from "./structure";

function block(id: string, patch: Partial<StructureBlock> = {}): StructureBlock {
  return { ...createBlock("crew"), id, name: id.toUpperCase(), ...patch };
}

function person(blockId: string, fullName: string, patch: Partial<PersonInput> = {}): PersonInput {
  return { ...emptyPerson(blockId), rank: "солдат", fullName, location: "ПУ", ...patch };
}

describe("BCS editor shared data", () => {
  it("migrates legacy positions by the complete position/BRO/sector tuple without losing export data", () => {
    const blocks = [
      block("alpha", { positionName: "сокіл", bro: "бро 1", workSector: "північ" }),
      block("beta", { positionName: "СОКІЛ", bro: "БРО 1", workSector: "ПІВНІЧ" }),
      block("gamma", { positionName: "сокіл", bro: "бро 2", workSector: "північ" }),
      block("management", { kind: "companyManagement", name: "УПРАВЛІННЯ РОТИ", positionName: "" }),
    ];
    const people = { "alpha:0": person("alpha", "коваль іВАН") };
    const snapshot = structuredClone({ blocks, people });
    const data = normalizeEditorData(blocks, people);

    expect(data.positions).toHaveLength(2);
    expect(data.positionByBlock.alpha).toBe(data.positionByBlock.beta);
    expect(data.positionByBlock.gamma).not.toBe(data.positionByBlock.alpha);
    expect(data.blocks[3].name).toBe("Управління роти");
    expect(data.blocks[0]).toMatchObject({ positionName: "СОКІЛ", bro: "БРО 1", workSector: "ПІВНІЧ" });
    expect(peopleForExport(data.blocks, data.peopleBySlot)[0].fullName).toBe("КОВАЛЬ Іван");
    expect(normalizeEditorData(data.blocks, data.peopleBySlot, data.positions, data.positionByBlock)).toEqual(data);
    expect({ blocks, people }).toEqual(snapshot);
  });

  it("projects saved links authoritatively and repairs missing links from legacy block fields", () => {
    const data = normalizeEditorData([
      block("alpha", { positionName: "застаріле" }),
      block("beta", { positionName: "інша", bro: "бро 2" }),
    ], {}, [{ id: "position-1", name: "нове", bro: "бро 1", workSector: "схід" }], {
      alpha: "position-1", beta: "missing", deletedBlock: "position-1",
    });
    expect(data.blocks[0]).toMatchObject({ positionName: "НОВЕ", bro: "БРО 1", workSector: "СХІД" });
    expect(data.positionByBlock.deletedBlock).toBeUndefined();
    expect(data.positionByBlock.beta).not.toBe("missing");
    expect(data.positions.find((position) => position.id === data.positionByBlock.beta)?.name).toBe("ІНША");
  });

  it("synchronizes a position edited from either table and keeps unlinked blocks independent", () => {
    const initial = normalizeEditorData([
      block("alpha", { positionName: "сокіл", bro: "бро 1" }),
      block("beta", { positionName: "сокіл", bro: "бро 1" }),
    ], {});
    const snapshot = structuredClone(initial);
    const fromTable = updateEditorBlock(initial, "alpha", { positionName: "орел", workSector: "південь" });
    expect(fromTable.blocks.map((item) => item.positionName)).toEqual(["ОРЕЛ", "ОРЕЛ"]);
    expect(fromTable.blocks.map((item) => item.workSector)).toEqual(["ПІВДЕНЬ", "ПІВДЕНЬ"]);
    const position = fromTable.positions[0];
    const fromRegistry = saveEditorPosition(fromTable, { ...position, bro: "бро 3" });
    expect(fromRegistry.blocks.map((item) => item.bro)).toEqual(["БРО 3", "БРО 3"]);
    const detached = setEditorBlockPosition(fromRegistry, "beta", null);
    expect(detached.blocks[1]).toMatchObject({ positionName: "", bro: "", workSector: "" });
    const changed = saveEditorPosition(detached, { ...position, name: "яструб", bro: "бро 4" });
    expect(changed.blocks[0].positionName).toBe("ЯСТРУБ");
    expect(changed.blocks[1].positionName).toBe("");
    expect(initial).toEqual(snapshot);
  });

  it("attaches and removes positions without deleting people or leaving stale exported copies", () => {
    let data = normalizeEditorData([block("alpha"), block("beta")], { "alpha:0": person("alpha", "КОВАЛЬ Іван") });
    const position = { ...createEditorPosition(), name: "сокіл", bro: "бро", workSector: "схід" };
    data = saveEditorPosition(data, position);
    data = setEditorBlockPosition(data, "alpha", position.id);
    data = setEditorBlockPosition(data, "beta", position.id);
    expect(data.blocks.every((item) => item.positionName === "СОКІЛ")).toBe(true);
    const removed = removeEditorPosition(data, position.id);
    expect(removed.positions).toEqual([]);
    expect(removed.positionByBlock).toEqual({});
    expect(removed.blocks.every((item) => !item.positionName && !item.bro && !item.workSector)).toBe(true);
    expect(removed.peopleBySlot).toEqual(data.peopleBySlot);
    expect(() => setEditorBlockPosition(removed, "alpha", "missing")).toThrow("Позицію не знайдено");
  });

  it("does not link unrelated blocks when identical partial position names or BRO values are typed", () => {
    for (const patch of [{ positionName: "с" }, { bro: "бро 1" }]) {
      let data = normalizeEditorData([block("alpha"), block("beta")], {});
      data = updateEditorBlock(data, "alpha", patch);
      data = updateEditorBlock(data, "beta", patch);
      expect(data.positions).toHaveLength(2);
      expect(data.positionByBlock.alpha).not.toBe(data.positionByBlock.beta);
      const alpha = structuredClone(data.blocks[0]);
      data = updateEditorBlock(data, "beta", { positionName: "сокіл", bro: "бро 2", workSector: "схід" });
      expect(data.blocks[0]).toEqual(alpha);
      expect(data.blocks[1]).toMatchObject({ positionName: "СОКІЛ", bro: "БРО 2", workSector: "СХІД" });
      expect(data.positions).toHaveLength(2);
      data = setEditorBlockPosition(data, "beta", data.positionByBlock.alpha);
      data = updateEditorBlock(data, "beta", { positionName: "спільна позиція" });
      expect(data.blocks.map((item) => item.positionName)).toEqual(["СПІЛЬНА ПОЗИЦІЯ", "СПІЛЬНА ПОЗИЦІЯ"]);
    }
  });

  it("prevents hiding any populated tail row, including a row with only a note", () => {
    const data = normalizeEditorData([block("alpha", { slots: 3, crewActual: 9 })], {
      "alpha:0": person("alpha", "КОВАЛЬ Іван"),
      "alpha:2": { ...emptyPerson("alpha"), note: "Відомі лише ці дані" },
    });
    const snapshot = structuredClone(data);
    expect(() => updateEditorBlock(data, "alpha", { slots: 2 })).toThrow("Спочатку перемістіть або видаліть");
    expect(data).toEqual(snapshot);
    const cleared = updateEditorPerson(data, "alpha", 2, { note: "" });
    const smaller = updateEditorBlock(cleared, "alpha", { slots: 1 });
    expect(smaller.blocks[0]).toMatchObject({ slots: 1, crewActual: 9 });
    expect(Object.keys(smaller.peopleBySlot)).toEqual(["alpha:0"]);
  });

  it("moves people into the first truly empty target slot and compacts the source without overwriting", () => {
    const data = normalizeEditorData([block("alpha", { slots: 2 }), block("beta", { slots: 3, crewActual: 8 })], {
      "alpha:0": person("alpha", "КОВАЛЬ Іван"),
      "alpha:1": person("alpha", "ПЕТРЕНКО Петро"),
      "beta:0": { ...emptyPerson("beta"), note: "Слот зайнятий частковими даними" },
      "beta:2": person("beta", "ШЕВЧЕНКО Тарас"),
    });
    const snapshot = structuredClone(data);
    const moved = moveEditorPerson(data, "alpha", 0, "beta");
    expect(moved.blocks.map((item) => item.slots)).toEqual([1, 3]);
    expect(moved.peopleBySlot["alpha:0"].fullName).toBe("ПЕТРЕНКО Петро");
    expect(moved.peopleBySlot["alpha:1"]).toBeUndefined();
    expect(moved.peopleBySlot["beta:1"]).toMatchObject({ blockId: "beta", fullName: "КОВАЛЬ Іван" });
    expect(moved.peopleBySlot["beta:0"]).toEqual(data.peopleBySlot["beta:0"]);
    expect(moved.peopleBySlot["beta:2"]).toEqual(data.peopleBySlot["beta:2"]);
    expect(moved.blocks[1].crewActual).toBe(8);
    expect(peopleForExport(moved.blocks, moved.peopleBySlot).filter((item) => item.fullName)).toHaveLength(3);
    expect(data).toEqual(snapshot);
  });

  it("grows a full target and keeps one empty source row after moving its last person", () => {
    const initial = normalizeEditorData([block("alpha"), block("beta")], {
      "alpha:0": person("alpha", "КОВАЛЬ Іван"), "beta:0": person("beta", "ПЕТРЕНКО Петро"),
    });
    const moved = moveEditorPerson(initial, "alpha", 0, "beta");
    expect(moved.blocks.map((item) => item.slots)).toEqual([1, 2]);
    expect(moved.peopleBySlot["alpha:0"]).toBeUndefined();
    expect(moved.peopleBySlot["beta:1"].blockId).toBe("beta");
    expect(editorPersonnelRows(moved)[0].person).toEqual(emptyPerson("alpha"));
  });

  it("reuses empty slots, grows only when full, and removes people with contiguous keys", () => {
    const initial = normalizeEditorData([block("alpha", { slots: 3 })], {
      "alpha:0": person("alpha", "КОВАЛЬ Іван"), "alpha:2": person("alpha", "ПЕТРЕНКО Петро"),
    });
    expect(addEditorPerson(initial, "alpha").blocks[0].slots).toBe(3);
    const filled = updateEditorPerson(initial, "alpha", 1, { fullName: "шевченко тАРАС", blockId: "wrong" });
    expect(filled.peopleBySlot["alpha:1"]).toMatchObject({ fullName: "ШЕВЧЕНКО Тарас", blockId: "alpha" });
    expect(addEditorPerson(filled, "alpha").blocks[0].slots).toBe(4);
    const removed = removeEditorPerson(filled, "alpha", 1);
    expect(removed.blocks[0].slots).toBe(2);
    expect(removed.peopleBySlot["alpha:1"].fullName).toBe("ПЕТРЕНКО Петро");
    expect(removed.peopleBySlot["alpha:2"]).toBeUndefined();
  });

  it("recovers populated hidden rows and orphaned old-draft people into visible export slots", () => {
    const data = normalizeEditorData([block("alpha"), block("waiting", { kind: "unassigned" })], {
      "alpha:0": person("alpha", "КОВАЛЬ Іван"),
      "alpha:2": person("wrong-id", "ПЕТРЕНКО Петро"),
      "removed:with:colons:1": person("removed:with:colons", "ШЕВЧЕНКО Тарас"),
      "removed:2": emptyPerson("removed"),
    });
    expect(data.blocks.map((item) => item.slots)).toEqual([3, 1]);
    expect(data.peopleBySlot["alpha:2"].blockId).toBe("alpha");
    expect(data.peopleBySlot["waiting:0"]).toMatchObject({ blockId: "waiting", fullName: "ШЕВЧЕНКО Тарас" });
    expect(Object.keys(data.peopleBySlot)).not.toContain("removed:with:colons:1");
    expect(Object.keys(data.peopleBySlot)).not.toContain("removed:2");
    expect(peopleForExport(data.blocks, data.peopleBySlot).filter((item) => item.fullName)).toHaveLength(3);
    const noUnassigned = normalizeEditorData([block("alpha")], { "deleted:0": person("deleted", "КОВАЛЬ Іван") });
    expect(noUnassigned.blocks[1].kind).toBe("unassigned");
    expect(editorPersonnelRows(noUnassigned)[1].person.fullName).toBe("КОВАЛЬ Іван");
  });

  it("removes confirmed blocks and their people without later resurrecting deleted data", () => {
    const initial = normalizeEditorData([block("alpha", { positionName: "сокіл" }), block("alpha-extra")], {
      "alpha:0": person("alpha", "КОВАЛЬ Іван"), "alpha-extra:0": person("alpha-extra", "ПЕТРЕНКО Петро"),
    });
    const removed = removeEditorBlock(initial, "alpha");
    expect(removed.blocks.map((item) => item.id)).toEqual(["alpha-extra"]);
    expect(removed.peopleBySlot).toEqual({ "alpha-extra:0": initial.peopleBySlot["alpha-extra:0"] });
    expect(removed.positionByBlock.alpha).toBeUndefined();
    expect(normalizeEditorData(removed.blocks, removed.peopleBySlot, removed.positions, removed.positionByBlock)).toEqual(removed);
  });

  it("restores BCS block order and places recovered orphan personnel in the final unassigned block", () => {
    const data = normalizeEditorData([
      block("temporary", { kind: "temporary" }),
      block("management", { kind: "companyManagement" }),
      block("alpha"),
    ], { "deleted:0": person("deleted", "КОВАЛЬ Іван") });
    expect(data.blocks.map((item) => item.kind)).toEqual(["crew", "companyManagement", "temporary", "unassigned"]);
    expect(editorPersonnelRows(data).at(-1)?.person.fullName).toBe("КОВАЛЬ Іван");
  });

  it("preserves people and position links when a block changes kind and restores BCS ordering", () => {
    const initial = normalizeEditorData([
      block("management", { kind: "companyManagement", name: "Управління роти" }),
      block("department", { kind: "department", name: "Відділення", slots: 3, positionName: "сокіл", status: "", uavType: "", crewActual: 0 }),
    ], { "department:0": person("department", "КОВАЛЬ Іван") });
    const crew = updateEditorBlock(initial, "department", { kind: "crew", name: "сокіл" });
    expect(crew.blocks[0]).toMatchObject({ id: "department", kind: "crew", name: "СОКІЛ", status: "Працюючий", uavType: "ФПВ", crewActual: 3 });
    expect(crew.positionByBlock.department).toBe(initial.positionByBlock.department);
    expect(crew.peopleBySlot).toEqual(initial.peopleBySlot);
    const department = updateEditorBlock(crew, "department", { kind: "department", name: "відділення БпАК" });
    expect(department.blocks[1]).toMatchObject({ name: "Відділення БпАК", status: "", uavType: "", uavName: "", crewActual: 0, positionName: "СОКІЛ" });
  });

  it("rejects invalid counts and prevents overflow when inserting or moving people", () => {
    const full = block("full", { slots: 2_000 });
    const people = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [personKey(full.id, index), person(full.id, `ОСОБА ${index}`)]));
    const data = normalizeEditorData([block("alpha"), full], { ...people, "alpha:0": person("alpha", "КОВАЛЬ Іван") });
    for (const slots of [0, -1, 1.5, Number.NaN, 2_001]) {
      expect(() => updateEditorBlock(data, "alpha", { slots })).toThrow("від 1 до 2 000");
    }
    expect(() => addEditorPerson(data, "full")).toThrow("від 1 до 2 000");
    expect(() => moveEditorPerson(data, "alpha", 0, "full")).toThrow("2 000 місць");
    const atTotalLimit = normalizeEditorData(Array.from({ length: 10 }, (_, index) => block(`full-${index}`, { slots: 2_000 })), {});
    expect(() => updateEditorBlock(atTotalLimit, "full-0", { slots: 2_000 })).not.toThrow();
    const withExtra = { ...atTotalLimit, blocks: [...atTotalLimit.blocks, block("extra")] };
    expect(() => updateEditorBlock(withExtra, "extra", { slots: 2 })).toThrow("20 000");
  });
});
