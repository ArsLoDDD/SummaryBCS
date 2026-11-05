import { describe, expect, it } from "vitest";
import bcsRules from "./shared/bcs-rules.json";
import { buildBcsSheetSummary, canonicalPersonnelKey, isTemporaryActingPosition, type BcsSheetSummary } from "./bcsSummary";
import { editorPersonnelRows, moveEditorPerson, normalizeEditorData } from "./bcsEditorData";
import {
  BLOCK_TYPES, CREW_STATUSES, LOCATIONS, UAV_TYPES, createBlock, emptyPerson,
  missingRequiredPersonFields, peopleForExport, validateWorkspace,
  type BlockKind, type PersonInput, type StructureBlock,
} from "./structure";

type SummaryRecords = Record<"main" | "functional" | "locations", Record<string, number>>;
const absent = ["ВІДП", "ЛІК", "ВЛК", "НАВЧ", "ВІДР", "Відкомандировані", "СЗЧ", "ПТЗ Новостав"];
const external: BlockKind[] = ["attached", "operationalSubordination", "temporary", "temporaryActing"];
const mainLabels = ["По штату", "По списку", "В наявності", "Відпустка", "Шпиталь", "Відрядження", "Відкомандировані", "Прикомандировані", "Оперативне підпорядкування", "ПТЗ Новостав", "СЗЧ", "Тимчасово прибулі", "Тимчасово прибулі з ТВО"];
const fixedSections: Partial<Record<BlockKind, string>> = { companyManagement: "Управління роти", platoonManagement: "Управління взводу", unassigned: "Не розподілені" };
let personSerial = 0;

function block(id: string, kind: BlockKind, patch: Partial<StructureBlock> = {}): StructureBlock {
  return { ...createBlock(kind), id, name: `Блок ${id}`, ...patch };
}

function person(blockId: string, patch: Partial<PersonInput> = {}): PersonInput {
  return { ...emptyPerson(blockId), rank: "солдат", fullName: `ОСОБА-${++personSerial} Іван Іванович`, location: "ПУ", ...patch };
}

function asRecords(summary: BcsSheetSummary): SummaryRecords {
  return { main: Object.fromEntries(summary.main), functional: Object.fromEntries(summary.functional), locations: Object.fromEntries(summary.locations) };
}

// Independent oracle: each physical person is classified once from an explicit
// category table. It does not call production identity/category/status helpers.
function independentSummary(strength: number, blocks: StructureBlock[], people: Record<string, PersonInput>): SummaryRecords {
  const main = Object.fromEntries(mainLabels.map((label) => [label, 0]));
  main["По штату"] = strength;
  const locations = Object.fromEntries([...LOCATIONS, "Не вказано / інше", "Загалом"].map((label) => [label, 0]));
  const functional: Record<string, number> = { "Екіпажів (ос-загально)": 0, "Екіпажів (загально)": 0, "Екіпажів — Формуються": 0, "Екіпажів — Працюючі": 0, "Екіпажів — Не активні": 0 };
  const crewPeople = new Set<string>();
  for (const item of blocks) {
    const crew = item.kind === "crew";
    const own = !external.includes(item.kind);
    const section = fixedSections[item.kind] ?? item.name.trim();
    if (!crew && own && !(section in functional)) functional[section] = 0;
    if (crew) {
      functional["Екіпажів (загально)"]++;
      if (UAV_TYPES.some((type) => type === item.uavType)) functional[`Екіпажів — ${item.uavType}`] = (functional[`Екіпажів — ${item.uavType}`] ?? 0) + 1;
      const status = item.status.toLowerCase().split(/\s+/u).join("");
      functional[status.startsWith("форм") ? "Екіпажів — Формуються" : status.startsWith("прац") || status === "активний" ? "Екіпажів — Працюючі" : "Екіпажів — Не активні"]++;
    }
    for (let index = 0; index < item.slots; index++) {
      const current = people[`${item.id}:${index}`];
      if (!current?.fullName.trim()) continue;
      const words = current.position.toUpperCase().split(/[^\p{L}\p{N}]+/u);
      const acting = item.kind === "temporaryActing" || (item.kind === "temporary" && words.includes("ТВО"));
      const present = !absent.includes(current.location);
      if (own || acting) main["По списку"]++;
      if (own) {
        if (present) main["В наявності"]++;
        if (current.location === "ВІДП") main["Відпустка"]++;
        if (["ЛІК", "ВЛК"].includes(current.location)) main["Шпиталь"]++;
        if (["НАВЧ", "ВІДР"].includes(current.location)) main["Відрядження"]++;
        if (current.location === "Відкомандировані") main["Відкомандировані"]++;
        if (current.location === "ПТЗ Новостав") main["ПТЗ Новостав"]++;
        if (current.location === "СЗЧ") main["СЗЧ"]++;
        if (!crew && present) functional[section]++;
      }
      if (item.kind === "attached") main["Прикомандировані"]++;
      if (item.kind === "operationalSubordination") main["Оперативне підпорядкування"]++;
      if (item.kind === "temporary" || item.kind === "temporaryActing") main["Тимчасово прибулі"]++;
      if (acting) main["Тимчасово прибулі з ТВО"]++;
      if (crew) crewPeople.add(current.fullName.toUpperCase().replace(/\p{White_Space}+/gu, " ").replace(/^ +| +$/gu, ""));
      locations[LOCATIONS.includes(current.location) ? current.location : "Не вказано / інше"]++;
      locations["Загалом"]++;
    }
  }
  functional["Екіпажів (ос-загально)"] = crewPeople.size;
  return { main, functional, locations };
}

function check(name: string, strength: number, blocks: StructureBlock[], people: Record<string, PersonInput>): void {
  const snapshot = JSON.stringify({ blocks, people });
  expect(asRecords(buildBcsSheetSummary(strength, blocks, people)), name).toEqual(independentSummary(strength, blocks, people));
  expect(JSON.stringify({ blocks, people }), `${name}: source data must not change`).toBe(snapshot);
}

function seededRandom(initial: number): (max: number) => number {
  let seed = initial;
  return (max) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
}

describe("BCS editor calculation simulations", () => {
  it("checks all 300 category/location combinations including absence, blank and unknown values", () => {
    let checked = 0;
    for (const { value: kind } of BLOCK_TYPES) for (const location of [...LOCATIONS, "", "Невідоме місце"]) {
      const management = block("mgmt", "companyManagement", { name: "Управління роти" });
      const target = kind === "companyManagement" ? management : block("target", kind);
      const blocks = kind === "companyManagement" ? [target] : [management, target];
      check(`${kind}/${location}`, 78, blocks, { "mgmt:0": person("mgmt"), [`${target.id}:0`]: person(target.id, { location }) });
      checked++;
    }
    expect(checked).toBe(300);
  });

  it("checks every supported status/type combination and independent actual crew strength", () => {
    for (const status of CREW_STATUSES) for (const uavType of UAV_TYPES) {
      const crew = block("crew", "crew", { status, uavType, slots: 3, crewActual: 9 });
      check(`${status}/${uavType}`, 1, [crew], { "crew:0": person("crew"), "crew:1": person("crew"), "crew:2": person("crew") });
    }
    for (const crewActual of [0, 1, 3, 2000]) {
      const crew = block("crew", "crew", { slots: 3, crewActual });
      const people = { "crew:0": person("crew"), "crew:1": person("crew", { fullName: "", note: "Частково заповнене місце" }) };
      check(`actual/${crewActual}`, 78, [crew], people);
      expect(asRecords(buildBcsSheetSummary(78, [crew], people)).locations["Загалом"]).toBe(1);
    }
  });

  it("keeps legacy status aliases visible without inventing counts for unknown UAV types", () => {
    for (const status of ["Активний", " Формуються ", "працюють", "НЕ АКТИВНИЙ", "", "Інший"]) {
      check(`legacy status/${status}`, 78, [block("crew", "crew", { status })], { "crew:0": person("crew") });
    }
    for (const uavType of ["фпв", "Літаковий\nРозвідувальний", "", "Невідомий"]) {
      check(`legacy type/${uavType}`, 78, [block("crew", "crew", { uavType })], { "crew:0": person("crew") });
    }
  });

  it("deduplicates crew personnel across case, repeated whitespace and non-breaking spaces", () => {
    for (const secondName of ["ТЕСТОВИЙ Іван", "тестовий іван", "ТЕСТОВИЙ  Іван", "ТЕСТОВИЙ\u00a0Іван"]) {
      const blocks = [block("mgmt", "companyManagement"), block("a", "crew"), block("b", "crew")];
      const people = { "mgmt:0": person("mgmt"), "a:0": person("a", { fullName: "ТЕСТОВИЙ Іван" }), "b:0": person("b", { fullName: secondName }) };
      check(`duplicate/${secondName}`, 78, blocks, people);
      expect(asRecords(buildBcsSheetSummary(78, blocks, people)).functional["Екіпажів (ос-загально)"]).toBe(1);
      expect(validateWorkspace("Рота", "2026-11-05", "company", 78, blocks)).toBe("");
      expect(peopleForExport(blocks, people).every((current) => missingRequiredPersonFields(current).length === 0)).toBe(true);
    }
    expect(canonicalPersonnelKey("\ufeff\u0085тестовий\t \nІван\u2003Іванович\u202f\ufeff")).toBe("ТЕСТОВИЙ ІВАН ІВАНОВИЧ");
  });

  it("excludes whitespace-only names, including NEL and BOM, from all personnel totals", () => {
    const crew = block("crew", "crew");
    for (const fullName of [" ", "\t\n", "\u0085", "\ufeff", "\u0085\ufeff \u2003"]) {
      const current = person("crew", { fullName });
      const summary = asRecords(buildBcsSheetSummary(78, [crew], { "crew:0": current }));
      expect(summary.main["По списку"]).toBe(0);
      expect(summary.main["В наявності"]).toBe(0);
      expect(summary.locations["Загалом"]).toBe(0);
      expect(summary.functional["Екіпажів (ос-загально)"]).toBe(0);
      expect(missingRequiredPersonFields(current)).toEqual(["П.І.Б."]);
    }
  });

  it("does not include crew or external personnel in a same-named structural section", () => {
    for (const name of ["Екіпаж", "Прикомандировані", "Управління роти"]) {
      const kind = name === "Екіпаж" ? "crew" : name === "Прикомандировані" ? "attached" : "companyManagement";
      const blocks = [block("a", kind, { name }), block("b", "department", { name })];
      const people: Record<string, PersonInput> = { "a:0": person("a"), "b:0": person("b") };
      if (kind !== "companyManagement") { blocks.push(block("mgmt", "companyManagement")); people["mgmt:0"] = person("mgmt"); }
      check(`section collision/${name}`, 78, blocks, people);
      expect(asRecords(buildBcsSheetSummary(78, blocks, people)).functional[name]).toBe(kind === "companyManagement" ? 2 : 1);
    }
  });

  it("requires a separate ТВО token instead of matching letters inside ordinary position words", () => {
    for (const position of ["ТВО командира", "тво-командира", "ТВО: водій", "Відповідальний за діловодство", "Виконавець робіт (будівництво)", "Без ТВО"]) {
      const blocks = [block("mgmt", "companyManagement"), block("temp", "temporary")];
      check(`temporary/${position}`, 78, blocks, { "mgmt:0": person("mgmt"), "temp:0": person("temp", { position }) });
    }
    for (const text of ["діловодство", "будівництво", "ТВО2", "2ТВО", "ПТВО", "ТВОкомандира"]) expect(isTemporaryActingPosition(text), text).toBe(false);
    for (const text of ["ТВО", "тво", "(ТВО)", "ТВО-командира", "ТВО: водій"]) expect(isTemporaryActingPosition(text), text).toBe(true);
    for (const delimiter of bcsRules.tvoDelimiters) {
      expect(isTemporaryActingPosition(`водій${delimiter}ТВО${delimiter}командира`), `shared delimiter ${delimiter.codePointAt(0)}`).toBe(true);
    }
    expect(isTemporaryActingPosition("ТВО‼командира")).toBe(false);
  });

  it("matches an independent oracle for 1000 deterministic generated structures", () => {
    const rand = seededRandom(0x5bc52026);
    const kinds: BlockKind[] = ["crew", "department", "informationDepartment", "attached", "operationalSubordination", "temporary", "temporaryActing", "unassigned"];
    for (let scenario = 0; scenario < 1000; scenario++) {
      const blocks = [block("mgmt", "companyManagement", { name: "Управління роти", slots: 1 + rand(8) })];
      for (let index = 0; index < 1 + rand(20); index++) blocks.push(block(`b${index}`, kinds[rand(kinds.length)], { slots: 1 + rand(8), crewActual: rand(20), status: CREW_STATUSES[rand(3)], uavType: UAV_TYPES[rand(7)] }));
      const people: Record<string, PersonInput> = {};
      for (const item of blocks) for (let index = 0; index < item.slots; index++) {
        if (rand(5) === 0) continue;
        people[`${item.id}:${index}`] = person(item.id, { location: [...LOCATIONS, "", "Невідоме"][rand(LOCATIONS.length + 2)], position: item.kind === "temporary" && rand(3) === 0 ? "ТВО командира" : "Водій" });
      }
      check(`seeded/${scenario}`, 1 + rand(2000), blocks, people);
    }
  });

  it("retains all seven people and correct totals through 1000 cross-category transfers", () => {
    const rand = seededRandom(0x5bc52026);
    let data = normalizeEditorData([block("a", "crew", { slots: 3 }), block("b", "crew", { slots: 3 }), block("c", "department", { slots: 2 }), block("d", "temporaryActing")], {
      "a:0": person("a"), "a:1": person("a"), "a:2": person("a"), "b:0": person("b"), "c:0": person("c"), "c:1": person("c"), "d:0": person("d"),
    });
    for (let operation = 0; operation < 1000; operation++) {
      const rows = editorPersonnelRows(data).filter((row) => row.person.fullName.trim());
      const from = rows[rand(rows.length)];
      data = moveEditorPerson(data, from.block.id, from.index, data.blocks[rand(data.blocks.length)].id);
      check(`move/${operation}`, 1, data.blocks, data.peopleBySlot);
      expect(editorPersonnelRows(data).filter((row) => row.person.fullName.trim())).toHaveLength(7);
    }
  });

  it("reconciles all totals at the 20 000-person capacity regardless of nominal authorized strength", () => {
    const blocks = [block("mgmt", "companyManagement", { slots: 2000 }), ...Array.from({ length: 9 }, (_, index) => block(`large-${index}`, "crew", { slots: 2000, crewActual: 2000 }))];
    const people: Record<string, PersonInput> = {};
    for (const item of blocks) for (let index = 0; index < item.slots; index++) people[`${item.id}:${index}`] = person(item.id);
    check("capacity/20000", 1, blocks, people);
    expect(validateWorkspace("Рота", "2026-11-05", "company", 1, blocks)).toBe("");
    expect(asRecords(buildBcsSheetSummary(1, blocks, people)).functional["Екіпажів (ос-загально)"]).toBe(18000);
  });
});
