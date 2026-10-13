import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Link2,
  MapPinPlus,
  Plus,
  Trash2,
  Unlink2,
} from "lucide-react";
import CustomSelect, { type CustomSelectOption } from "./CustomSelect";
import { UAV_TYPES } from "./structure";
import {
  CREW_DUTIES,
  CREW_READINESS,
  POSITION_READINESS,
  attachLooseCrew,
  attachmentProblem,
  createCrew,
  createCrewForPosition,
  createGroup,
  createPosition,
  createPositionForLooseCrew,
  detachCrew,
  readinessDisplay,
  upperUk,
  type CrewDuty,
  type CrewReadiness,
  type PositionReadiness,
  type StripCrew,
  type StripGroup,
  type StripPosition,
  type StripsReport,
  type UavType,
  type WorkStrip,
} from "./strips";

type ConfirmDelete = (label: string, action: () => void) => void;

interface StripsRegistryProps {
  report: StripsReport;
  duplicateCrewNames: ReadonlySet<string>;
  normalizeLabel: (value: string) => string;
  uavOptionsForGroup: (strip: WorkStrip, groupIndex: number) => ReadonlyArray<CustomSelectOption<UavType>>;
  updateStrip: (stripId: string, update: (strip: WorkStrip) => WorkStrip) => void;
  updateGroup: (stripId: string, groupId: string, update: (group: StripGroup) => StripGroup) => void;
  updatePosition: (
    stripId: string,
    groupId: string,
    positionId: string,
    update: (position: StripPosition) => StripPosition,
  ) => void;
  updateCrew: (
    stripId: string,
    groupId: string,
    positionId: string | null,
    crewId: string,
    update: (crew: StripCrew) => StripCrew,
  ) => void;
  updateTypeRun: (stripId: string, groupId: string, uavType: UavType) => void;
  addUnitToType: (stripId: string, groupId: string) => void;
  requestPositionReadiness: (
    stripId: string,
    groupId: string,
    position: StripPosition,
    readiness: PositionReadiness,
  ) => void;
  requestCrewReadiness: (
    stripId: string,
    groupId: string,
    positionId: string | null,
    crew: StripCrew,
    readiness: CrewReadiness,
  ) => void;
  removeStrip: (stripId: string) => void;
  moveStrip: (index: number, direction: -1 | 1) => void;
  confirmDelete: ConfirmDelete;
}

function statusClass(status: string): string {
  if (status === "БГ") return "status-ready";
  if (status === "Не БГ") return "status-not-ready";
  if (status === "Формується") return "status-forming";
  return "status-neutral";
}

function RegistryField({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`strips-registry-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

interface CrewRecord {
  crew: StripCrew;
  position: StripPosition | null;
}

export default function StripsRegistry({
  report,
  duplicateCrewNames,
  normalizeLabel,
  uavOptionsForGroup,
  updateStrip,
  updateGroup,
  updatePosition,
  updateCrew,
  updateTypeRun,
  addUnitToType,
  requestPositionReadiness,
  requestCrewReadiness,
  removeStrip,
  moveStrip,
  confirmDelete,
}: StripsRegistryProps) {
  const positionsTotal = report.strips.reduce(
    (total, strip) => total + strip.groups.reduce((sum, group) => sum + group.positions.length, 0),
    0,
  );
  const crewsTotal = report.strips.reduce(
    (total, strip) => total + strip.groups.reduce(
      (sum, group) => sum + group.looseCrews.length + group.positions.reduce(
        (positionSum, position) => positionSum + position.crews.length,
        0,
      ),
      0,
    ),
    0,
  );
  const linkedCrewsTotal = report.strips.reduce(
    (total, strip) => total + strip.groups.reduce(
      (sum, group) => sum + group.positions.reduce(
        (positionSum, position) => positionSum + position.crews.length,
        0,
      ),
      0,
    ),
    0,
  );

  return (
    <div className="strips-registry-scroll">
      <div className="strips-registry">
        <header className="strips-registry-heading">
          <div>
            <h2>Реєстр позицій та екіпажів</h2>
            <p>Усі зміни автоматично відображаються у вкладці «Таблиця».</p>
          </div>
        </header>

        <div className="strips-registry-metrics" aria-label="Короткий підсумок реєстру">
          <div><span>Смуг</span><strong>{report.strips.length}</strong></div>
          <div><span>Позицій</span><strong>{positionsTotal}</strong></div>
          <div><span>Екіпажів</span><strong>{crewsTotal}</strong></div>
          <div><span>Зв’язаних</span><strong>{linkedCrewsTotal}</strong></div>
          <div><span>Без позиції</span><strong>{crewsTotal - linkedCrewsTotal}</strong></div>
        </div>

        {report.strips.map((strip, stripIndex) => (
          <section className="strips-registry-strip" key={strip.id}>
            <header className="strips-registry-strip-header">
              <input
                aria-label={`Назва смуги ${stripIndex + 1}`}
                value={strip.name}
                maxLength={200}
                onChange={(event) => updateStrip(strip.id, (current) => ({
                  ...current,
                  name: event.target.value,
                }))}
              />
              <div>
                <button
                  type="button"
                  disabled={new Set(strip.groups.map((group) => group.uavType).filter(Boolean)).size >= UAV_TYPES.length}
                  onClick={() => updateStrip(strip.id, (current) => ({
                    ...current,
                    groups: [...current.groups, createGroup()],
                  }))}
                ><Plus size={14} /> Тип БпЛА</button>
                <button type="button" aria-label="Перемістити смугу вище" disabled={stripIndex === 0} onClick={() => moveStrip(stripIndex, -1)}><ArrowUp size={15} /></button>
                <button type="button" aria-label="Перемістити смугу нижче" disabled={stripIndex === report.strips.length - 1} onClick={() => moveStrip(stripIndex, 1)}><ArrowDown size={15} /></button>
                <button type="button" className="danger" aria-label="Видалити смугу" onClick={() => removeStrip(strip.id)}><Trash2 size={15} /></button>
              </div>
            </header>

            <div className="strips-registry-groups">
              {strip.groups.map((group, groupIndex) => {
                const crewRecords: CrewRecord[] = [
                  ...group.positions.flatMap((position) => position.crews.map((crew) => ({ crew, position }))),
                  ...group.looseCrews.map((crew) => ({ crew, position: null })),
                ];
                const duplicateUnit = Boolean(group.uavType && group.unit.trim()) && strip.groups.some((candidate, candidateIndex) => (
                  candidateIndex !== groupIndex
                  && candidate.uavType === group.uavType
                  && normalizeLabel(candidate.unit) === normalizeLabel(group.unit)
                ));

                return (
                  <article className="strips-registry-group" key={group.id}>
                    <header className="strips-registry-group-header">
                      <RegistryField label="Підрозділ">
                        <input
                          className={!group.unit.trim() || duplicateUnit ? "invalid" : ""}
                          value={group.unit}
                          maxLength={250}
                          onChange={(event) => updateGroup(strip.id, group.id, (current) => ({
                            ...current,
                            unit: event.target.value,
                          }))}
                        />
                      </RegistryField>
                      <RegistryField label="Тип БпЛА">
                        <CustomSelect<UavType>
                          ariaLabel={`${strip.name}, ${group.unit || `блок ${groupIndex + 1}`}: тип БпЛА`}
                          value={group.uavType}
                          options={uavOptionsForGroup(strip, groupIndex)}
                          onChange={(value) => updateTypeRun(strip.id, group.id, value)}
                        />
                      </RegistryField>
                      <div className="strips-registry-group-actions">
                        {group.uavType && (
                          <button type="button" onClick={() => addUnitToType(strip.id, group.id)}><Plus size={14} /> Підрозділ</button>
                        )}
                        <button type="button" onClick={() => updateGroup(strip.id, group.id, (current) => ({
                          ...current,
                          positions: [...current.positions, createPosition()],
                        }))}><Plus size={14} /> Позиція</button>
                        <button type="button" onClick={() => updateGroup(strip.id, group.id, (current) => ({
                          ...current,
                          looseCrews: [...current.looseCrews, createCrew("loose-crew")],
                        }))}><Plus size={14} /> Екіпаж</button>
                        <button
                          type="button"
                          className="danger"
                          aria-label="Видалити блок"
                          onClick={() => confirmDelete(
                            `Видалити блок «${group.unit || "Без назви"} / ${group.uavType || "Тип не вказано"}»?`,
                            () => updateStrip(strip.id, (current) => ({
                              ...current,
                              groups: current.groups.filter((item) => item.id !== group.id),
                            })),
                          )}
                        ><Trash2 size={14} /></button>
                      </div>
                    </header>

                    <div className="strips-registry-columns">
                      <section className="strips-registry-column">
                        <div className="strips-registry-column-title">
                          <h3>Позиції</h3><span>{group.positions.length}</span>
                        </div>
                        {group.positions.length === 0 && <p className="strips-registry-empty">Позицій ще немає.</p>}
                        {group.positions.map((position, positionIndex) => {
                          const readinessOptions: ReadonlyArray<CustomSelectOption<PositionReadiness>> = POSITION_READINESS.map((value) => ({
                            value,
                            label: value === "Не БГ" ? readinessDisplay(value, position.notReadyReason) : value,
                          }));
                          return (
                            <article className={`strips-registry-card ${statusClass(position.readiness)}`} key={position.id}>
                              <header>
                                <strong>{position.name || `Позиція ${positionIndex + 1}`}</strong>
                                <span>{position.crews.length} екіп.</span>
                              </header>
                              <div className="strips-registry-form">
                                <RegistryField label="Назва позиції" wide>
                                  <input
                                    className={!position.name.trim() ? "invalid" : ""}
                                    value={position.name}
                                    maxLength={250}
                                    onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, name: event.target.value }))}
                                  />
                                </RegistryField>
                                <RegistryField label="БГ позиції">
                                  <CustomSelect
                                    ariaLabel={`${position.name || "Позиція"}: БГ позиції`}
                                    value={position.readiness}
                                    options={readinessOptions}
                                    onChange={(value) => requestPositionReadiness(strip.id, group.id, position, value)}
                                  />
                                </RegistryField>
                                <RegistryField label="БРО">
                                  <input value={position.bro} maxLength={250} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, bro: event.target.value }))} />
                                </RegistryField>
                                <RegistryField label="Район" wide>
                                  <input value={position.area} maxLength={250} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, area: upperUk(event.target.value) }))} />
                                </RegistryField>
                                <RegistryField label="Напрямок роботи" wide>
                                  <textarea value={position.direction} maxLength={500} rows={2} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, direction: event.target.value }))} />
                                </RegistryField>
                                <RegistryField label="Примітки" wide>
                                  <textarea value={position.note} maxLength={1000} rows={2} onChange={(event) => updatePosition(strip.id, group.id, position.id, (current) => ({ ...current, note: event.target.value }))} />
                                </RegistryField>
                              </div>
                              <div className="strips-registry-links">
                                <span>Екіпажі на позиції</span>
                                <div>
                                  {position.crews.length === 0 && <em>Екіпаж не приєднаний</em>}
                                  {position.crews.map((crew) => (
                                    <button
                                      type="button"
                                      title="Відкріпити екіпаж"
                                      key={crew.id}
                                      onClick={() => updateGroup(strip.id, group.id, (current) => detachCrew(current, position.id, crew.id))}
                                    >{crew.name || "Без назви"}<Unlink2 size={13} /></button>
                                  ))}
                                </div>
                              </div>
                              <footer>
                                <button type="button" onClick={() => updatePosition(strip.id, group.id, position.id, (current) => ({
                                  ...current,
                                  crews: [...current.crews, createCrewForPosition(current)],
                                }))}><Plus size={14} /> Новий екіпаж</button>
                                <button
                                  type="button"
                                  className="danger"
                                  onClick={() => confirmDelete(
                                    `Видалити позицію «${position.name || "Без назви"}» разом з її екіпажами?`,
                                    () => updateGroup(strip.id, group.id, (current) => ({
                                      ...current,
                                      positions: current.positions.filter((item) => item.id !== position.id),
                                    })),
                                  )}
                                ><Trash2 size={14} /> Видалити</button>
                              </footer>
                            </article>
                          );
                        })}
                      </section>

                      <section className="strips-registry-column">
                        <div className="strips-registry-column-title">
                          <h3>Екіпажі</h3><span>{crewRecords.length}</span>
                        </div>
                        {crewRecords.length === 0 && <p className="strips-registry-empty">Екіпажів ще немає.</p>}
                        {crewRecords.map(({ crew, position }, crewIndex) => {
                          const readinessOptions: ReadonlyArray<CustomSelectOption<CrewReadiness>> = CREW_READINESS.map((value) => ({
                            value,
                            label: value === "Не БГ" ? readinessDisplay(value, crew.notReadyReason) : value,
                          }));
                          const dutyOptions: ReadonlyArray<CustomSelectOption<CrewDuty>> = crew.readiness === "Формується"
                            ? [{ value: "Формується", label: "Формується" }]
                            : CREW_DUTIES.map((value) => ({ value, label: value }));
                          const duplicateName = duplicateCrewNames.has(normalizeLabel(crew.name));
                          const availablePositions = group.positions.map((candidate, index) => ({
                            value: candidate.id,
                            label: candidate.name || `Позиція ${index + 1}`,
                            disabled: Boolean(attachmentProblem(candidate, crew)),
                          }));
                          return (
                            <article className={`strips-registry-card ${position ? statusClass(crew.readiness) : "status-neutral"}`} key={crew.id}>
                              <header>
                                <strong>{crew.name || `Екіпаж ${crewIndex + 1}`}</strong>
                                <span>{position ? position.name || "Позиція без назви" : "Без позиції"}</span>
                              </header>
                              <div className="strips-registry-form">
                                <RegistryField label="Назва екіпажу" wide>
                                  <input
                                    className={!crew.name.trim() || duplicateName ? "invalid" : ""}
                                    value={crew.name}
                                    maxLength={250}
                                    onChange={(event) => updateCrew(strip.id, group.id, position?.id ?? null, crew.id, (current) => ({ ...current, name: event.target.value }))}
                                  />
                                </RegistryField>
                                <RegistryField label="БГ екіпажу">
                                  <CustomSelect
                                    ariaLabel={`${crew.name || "Екіпаж"}: БГ екіпажу`}
                                    value={crew.readiness}
                                    options={readinessOptions}
                                    onChange={(value) => requestCrewReadiness(strip.id, group.id, position?.id ?? null, crew, value)}
                                  />
                                </RegistryField>
                                <RegistryField label="БЧ екіпажу">
                                  <CustomSelect
                                    ariaLabel={`${crew.name || "Екіпаж"}: БЧ екіпажу`}
                                    value={crew.duty}
                                    options={dutyOptions}
                                    disabled={crew.readiness === "Формується"}
                                    onChange={(value) => updateCrew(strip.id, group.id, position?.id ?? null, crew.id, (current) => ({ ...current, duty: value }))}
                                  />
                                </RegistryField>
                                <RegistryField label="Засіб" wide>
                                  <input value={crew.assets} maxLength={1000} onChange={(event) => updateCrew(strip.id, group.id, position?.id ?? null, crew.id, (current) => ({ ...current, assets: event.target.value }))} />
                                </RegistryField>
                                <RegistryField label="Примітки" wide>
                                  <textarea value={crew.note} maxLength={1000} rows={2} onChange={(event) => updateCrew(strip.id, group.id, position?.id ?? null, crew.id, (current) => ({ ...current, note: event.target.value }))} />
                                </RegistryField>
                              </div>
                              <div className="strips-registry-relation">
                                <span>Зв’язок</span>
                                {position ? (
                                  <button type="button" onClick={() => updateGroup(strip.id, group.id, (current) => detachCrew(current, position.id, crew.id))}>
                                    <Unlink2 size={14} /> Відкріпити від «{position.name || "Без назви"}»
                                  </button>
                                ) : (
                                  <div>
                                    {crew.readiness !== "Формується" && availablePositions.length > 0 && (
                                      <CustomSelect<string>
                                        ariaLabel={`${crew.name || "Екіпаж"}: приєднати до позиції`}
                                        value=""
                                        placeholder="Приєднати до позиції"
                                        options={availablePositions}
                                        onChange={(positionId) => updateGroup(strip.id, group.id, (current) => attachLooseCrew(current, positionId, crew.id))}
                                      />
                                    )}
                                    {crew.readiness !== "Формується" && (
                                      <button type="button" onClick={() => updateGroup(strip.id, group.id, (current) => createPositionForLooseCrew(current, crew.id))}>
                                        <MapPinPlus size={14} /> Створити позицію
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                              <footer>
                                {position && <span><Link2 size={13} /> {position.name || "Позиція без назви"}</span>}
                                {!position && <span>Екіпаж без позиції</span>}
                                <button
                                  type="button"
                                  className="danger"
                                  onClick={() => confirmDelete(
                                    `Видалити екіпаж «${crew.name || "Без назви"}»?`,
                                    () => position
                                      ? updatePosition(strip.id, group.id, position.id, (current) => ({
                                          ...current,
                                          crews: current.crews.filter((item) => item.id !== crew.id),
                                        }))
                                      : updateGroup(strip.id, group.id, (current) => ({
                                          ...current,
                                          looseCrews: current.looseCrews.filter((item) => item.id !== crew.id),
                                        })),
                                  )}
                                ><Trash2 size={14} /> Видалити</button>
                              </footer>
                            </article>
                          );
                        })}
                      </section>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
