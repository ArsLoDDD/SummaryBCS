import { describe, expect, it } from "vitest";
import type {
  RegistryAssignment,
  RegistryCrew,
  RegistryPosition,
  StripsRegistryData,
} from "./stripsRegistry";
import {
  buildRegistryGeneralRows,
  collectRegistryTableFilterOptions,
  registryGeneralRowNote,
  viewRegistryCrews,
  viewRegistryGeneralRows,
  viewRegistryPositions,
} from "./registryTableView";

function crew(value: Partial<RegistryCrew> & Pick<RegistryCrew, "id" | "name">): RegistryCrew {
  return {
    id: value.id,
    name: value.name,
    unit: value.unit ?? "",
    uavType: value.uavType ?? "",
    readiness: value.readiness ?? "",
    notReadyReason: value.notReadyReason ?? "",
    duty: value.duty ?? "",
    assets: value.assets ?? "",
    note: value.note ?? "",
  };
}

function position(value: Partial<RegistryPosition> & Pick<RegistryPosition, "id" | "name">): RegistryPosition {
  return {
    id: value.id,
    name: value.name,
    strip: value.strip ?? "",
    unit: value.unit ?? "",
    uavType: value.uavType ?? "",
    readiness: value.readiness ?? "",
    notReadyReason: value.notReadyReason ?? "",
    bro: value.bro ?? "",
    area: value.area ?? "",
    direction: value.direction ?? "",
    note: value.note ?? "",
  };
}

function assignment(id: string, crewId: string, positionId: string): RegistryAssignment {
  return { id, crewId, positionId };
}

function fixture(): StripsRegistryData {
  return {
    version: 2,
    reportDate: "2026-10-14",
    crews: [
      crew({
        id: "c-2",
        name: "СОКІЛ-2",
        unit: "1 РУБАК",
        uavType: "ФПВ",
        readiness: "БГ",
        duty: "БЧ",
        assets: "FPV 10",
        note: "Резервна зміна",
      }),
      crew({
        id: "c-10",
        name: "ГРІМ-10",
        unit: "2 РУБАК",
        uavType: "Бомбер",
        readiness: "Не БГ",
        notReadyReason: "Ремонт антени",
        duty: "Відпочинок після БЧ",
        assets: "Vampire",
      }),
      crew({
        id: "c-1",
        name: "РЕЗЕРВ-1",
        unit: "1 РУБАК",
        uavType: "ФПВ",
        readiness: "Формується",
        duty: "Формується",
        note: "Комплектування",
      }),
    ],
    positions: [
      position({
        id: "p-2",
        name: "ПОЗИЦІЯ СОКІЛ-2",
        strip: "Смуга ПІВНІЧ",
        unit: "1 РУБАК",
        uavType: "ФПВ",
        readiness: "БГ",
        bro: "БРО-2",
        area: "ПІВНІЧНИЙ РАЙОН",
        direction: "Північний напрямок",
      }),
      position({
        id: "p-10",
        name: "ПОЗИЦІЯ ГРІМ-10",
        strip: "Смуга ПІВДЕНЬ",
        unit: "2 РУБАК",
        uavType: "Бомбер",
        readiness: "Не БГ",
        notReadyReason: "Ремонт генератора",
        bro: "БРО-10",
        area: "ПІВДЕННИЙ РАЙОН",
        direction: "Південний напрямок",
      }),
      position({
        id: "p-1",
        name: "ПОЗИЦІЯ МАЯК-1",
        strip: "Смуга СХІД",
        unit: "3 РУБАК",
        uavType: "Коптер",
        readiness: "БГ",
        bro: "БРО-1",
        area: "СХІДНИЙ РАЙОН",
        direction: "Східний напрямок",
        note: "Запасна позиція",
      }),
    ],
    assignments: [
      assignment("a-2", "c-2", "p-2"),
      assignment("a-10", "c-10", "p-10"),
    ],
  };
}

describe("registry table views", () => {
  it("builds General rows without cloning or mutating registry records", () => {
    const data = fixture();
    const before = structuredClone(data);
    const rows = buildRegistryGeneralRows(data);

    expect(rows.map((row) => row.key)).toEqual([
      "crew-c-2",
      "crew-c-10",
      "crew-c-1",
      "position-p-1",
    ]);
    expect(rows[0].crew).toBe(data.crews[0]);
    expect(rows[0].position).toBe(data.positions[0]);
    expect(rows[3].position).toBe(data.positions[2]);
    expect(data).toEqual(before);
  });

  it("searches General across multiple visible columns and generated notes", () => {
    const data = fixture();

    expect(viewRegistryGeneralRows(data, { search: "сокіл північ" }).map((row) => row.key))
      .toEqual(["crew-c-2"]);
    expect(viewRegistryGeneralRows(data, { search: "ремонт генератора" }).map((row) => row.key))
      .toEqual(["crew-c-10"]);
    expect(viewRegistryGeneralRows(data, { search: "готовий виконання задач" }).map((row) => row.key))
      .toEqual([]);
    expect(viewRegistryGeneralRows(data, { search: "без позиції" }).map((row) => row.key))
      .toEqual(["crew-c-1"]);
    expect(registryGeneralRowNote(buildRegistryGeneralRows(data)[3]))
      .toContain("Позиція готова до роботи, відсутній екіпаж");
  });

  it("filters General by all supported dimensions", () => {
    const data = fixture();

    expect(viewRegistryGeneralRows(data, { filters: { strips: ["смуга північ"] } }).map((row) => row.key))
      .toEqual(["crew-c-2"]);
    expect(viewRegistryGeneralRows(data, { filters: { units: ["1 рубак"], uavTypes: ["фпв"] } }).map((row) => row.key))
      .toEqual(["crew-c-2", "crew-c-1"]);
    expect(viewRegistryGeneralRows(data, { filters: { crewReadiness: ["Не БГ"] } }).map((row) => row.key))
      .toEqual(["crew-c-10"]);
    expect(viewRegistryGeneralRows(data, { filters: { positionReadiness: ["БГ"] } }).map((row) => row.key))
      .toEqual(["crew-c-2", "position-p-1"]);
    expect(viewRegistryGeneralRows(data, { filters: { assignmentStates: ["assigned"] } }).map((row) => row.key))
      .toEqual(["crew-c-2", "crew-c-10"]);
    expect(viewRegistryGeneralRows(data, { filters: { assignmentStates: ["crew-without-position"] } }).map((row) => row.key))
      .toEqual(["crew-c-1"]);
    expect(viewRegistryGeneralRows(data, { filters: { assignmentStates: ["position-without-crew"] } }).map((row) => row.key))
      .toEqual(["position-p-1"]);
  });

  it("searches and filters Crews using linked position data where appropriate", () => {
    const data = fixture();

    expect(viewRegistryCrews(data, { search: "vampire ремонт" }).map((item) => item.id))
      .toEqual(["c-10"]);
    expect(viewRegistryCrews(data, { filters: { strips: ["Смуга ПІВДЕНЬ"] } }).map((item) => item.id))
      .toEqual(["c-10"]);
    expect(viewRegistryCrews(data, { filters: { positionReadiness: ["БГ"] } }).map((item) => item.id))
      .toEqual(["c-2"]);
    expect(viewRegistryCrews(data, { filters: { assignmentStates: ["crew-without-position"] } }).map((item) => item.id))
      .toEqual(["c-1"]);
  });

  it("searches and filters Positions using linked crew data where appropriate", () => {
    const data = fixture();

    expect(viewRegistryPositions(data, { search: "східний запасна" }).map((item) => item.id))
      .toEqual(["p-1"]);
    expect(viewRegistryPositions(data, { filters: { crewReadiness: ["Не БГ"] } }).map((item) => item.id))
      .toEqual(["p-10"]);
    expect(viewRegistryPositions(data, { filters: { assignmentStates: ["position-without-crew"] } }).map((item) => item.id))
      .toEqual(["p-1"]);
    expect(viewRegistryPositions(data, { filters: { strips: ["смуга північ"], uavTypes: ["фпв"] } }).map((item) => item.id))
      .toEqual(["p-2"]);
  });

  it("sorts naturally, keeps blanks last, and does not modify source order", () => {
    const data = fixture();
    const sourceCrewIds = data.crews.map((item) => item.id);
    const sourcePositionIds = data.positions.map((item) => item.id);

    expect(viewRegistryCrews(data, { sort: { key: "name", direction: "asc" } }).map((item) => item.id))
      .toEqual(["c-10", "c-1", "c-2"]);
    expect(viewRegistryPositions(data, { sort: { key: "bro", direction: "asc" } }).map((item) => item.id))
      .toEqual(["p-1", "p-2", "p-10"]);
    expect(viewRegistryGeneralRows(data, { sort: { key: "position", direction: "desc" } }).map((row) => row.key))
      .toEqual(["crew-c-2", "position-p-1", "crew-c-10", "crew-c-1"]);
    expect(data.crews.map((item) => item.id)).toEqual(sourceCrewIds);
    expect(data.positions.map((item) => item.id)).toEqual(sourcePositionIds);
  });

  it("collects normalized, unique options for every filter", () => {
    const data = fixture();
    data.positions.push(position({
      id: "p-duplicate",
      name: "ДУБЛЬ",
      strip: " смуга   північ ",
      unit: "1 рубак",
      uavType: "ФПВ",
      readiness: "БГ",
    }));

    expect(collectRegistryTableFilterOptions(data)).toEqual({
      strips: ["Екіпажі без позиції", "Смуга ПІВДЕНЬ", "Смуга ПІВНІЧ", "Смуга СХІД"],
      units: ["1 РУБАК", "2 РУБАК", "3 РУБАК"],
      uavTypes: ["Бомбер", "Коптер", "ФПВ"],
      crewReadiness: ["БГ", "Не БГ", "Формується"],
      positionReadiness: ["БГ", "Не БГ"],
      assignmentStates: ["assigned", "crew-without-position", "position-without-crew"],
    });
  });

  it("collects only filter values that are meaningful for the active tab", () => {
    const data = fixture();

    expect(collectRegistryTableFilterOptions(data, "crews")).toEqual({
      strips: ["Екіпажі без позиції", "Смуга ПІВДЕНЬ", "Смуга ПІВНІЧ"],
      units: ["1 РУБАК", "2 РУБАК"],
      uavTypes: ["Бомбер", "ФПВ"],
      crewReadiness: ["БГ", "Не БГ", "Формується"],
      positionReadiness: ["БГ", "Не БГ"],
      assignmentStates: ["assigned", "crew-without-position"],
    });
    expect(collectRegistryTableFilterOptions(data, "positions")).toEqual({
      strips: ["Смуга ПІВДЕНЬ", "Смуга ПІВНІЧ", "Смуга СХІД"],
      units: ["1 РУБАК", "2 РУБАК", "3 РУБАК"],
      uavTypes: ["Бомбер", "Коптер", "ФПВ"],
      crewReadiness: ["БГ", "Не БГ"],
      positionReadiness: ["БГ", "Не БГ"],
      assignmentStates: ["assigned", "position-without-crew"],
    });
  });

  it("uses only the first valid assignment for a crew in every view", () => {
    const data = fixture();
    data.assignments.unshift(
      assignment("invalid", "c-2", "missing-position"),
      assignment("duplicate", "c-2", "p-10"),
    );

    expect(buildRegistryGeneralRows(data).find((row) => row.crew?.id === "c-2")?.position?.id)
      .toBe("p-10");
    expect(viewRegistryPositions(data, {
      filters: { crewReadiness: ["БГ"] },
    }).map((position) => position.id)).toEqual(["p-10"]);
  });
});
