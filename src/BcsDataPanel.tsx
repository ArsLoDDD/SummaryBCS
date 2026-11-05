import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Building2, MapPin, Pencil, Plus, Search, Trash2, Users, X } from "lucide-react";
import CustomSelect from "./CustomSelect";
import {
  addEditorPerson,
  createEditorPosition,
  editorPersonnelRows,
  moveEditorPerson,
  removeEditorBlock,
  removeEditorPerson,
  removeEditorPosition,
  saveEditorPosition,
  setEditorBlockPosition,
  updateEditorBlock,
  updateEditorPerson,
  type BcsEditorData,
  type BcsPosition,
} from "./bcsEditorData";
import {
  BLOCK_TYPES,
  CREW_STATUSES,
  LOCATIONS,
  RANKS,
  UAV_TYPES,
  defaultBlockName,
  emptyPerson,
  isRequiredManagementBlock,
  isSingletonBlockKind,
  missingRequiredPersonFields,
  normalizedSlots,
  personHasAnyData,
  quickBlockTypesForStructure,
  type BlockKind,
  type PersonInput,
  type StructureBlock,
  type StructureType,
} from "./structure";
import "./bcsData.css";

interface Props {
  data: BcsEditorData;
  structureType: StructureType;
  summary: {
    main: Array<[string, number]>;
    functional: Array<[string, number]>;
    locations: Array<[string, number]>;
  };
  onChange: (data: BcsEditorData) => void;
  onError: (message: string) => void;
  onAddBlock: (kind: BlockKind) => void;
}

type DataTab = "people" | "blocks" | "positions";
interface PersonEditor {
  source: { blockId: string; index: number } | null;
  blockId: string;
  person: PersonInput;
}
interface BlockEditor {
  block: StructureBlock;
  positionId: string;
}
interface Confirmation {
  title: string;
  text: string;
  confirm: () => boolean;
}

function kindLabel(kind: BlockKind): string {
  return BLOCK_TYPES.find((item) => item.value === kind)?.label ?? "Підрозділ";
}

function hasEditableBlockName(kind: BlockKind): boolean {
  return kind === "crew"
    || kind === "department"
    || kind === "informationDepartment"
    || kind === "independent"
    || kind === "custom";
}

function textMatches(query: string, ...values: string[]): boolean {
  const words = query.trim().toLocaleLowerCase("uk-UA").split(/\s+/u).filter(Boolean);
  const haystack = values.join(" ").toLocaleLowerCase("uk-UA");
  return words.every((word) => haystack.includes(word));
}

function valueOrDash(value: string): ReactNode {
  return value.trim() || <span className="bcs-data-empty">—</span>;
}

function Status({ value }: { value: string }) {
  const modifier = value === "Працюючий" ? "working" : value === "Формується" ? "forming" : "inactive";
  return value ? <span className={`bcs-data-status bcs-data-status-${modifier}`}>{value}</span> : <span className="bcs-data-empty">—</span>;
}

function Modal({ title, children, onClose, onSubmit, submitLabel = "Зберегти", destructive = false }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  destructive?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const firstInput = dialogRef.current?.querySelector<HTMLElement>("input, textarea, .custom-select-trigger");
    (firstInput ?? dialogRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]'))?.focus();
    return () => previousFocus?.focus();
  }, []);

  return createPortal(
    <div className="bcs-data-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form
        ref={dialogRef}
        className="bcs-data-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={onSubmit}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          if (event.key !== "Tab") return;
          const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
          const first = elements[0];
          const last = elements[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <div className="bcs-data-modal-heading">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="bcs-data-icon-button" onClick={onClose} aria-label="Закрити"><X size={20} /></button>
        </div>
        <div className="bcs-data-modal-content">{children}</div>
        <div className="bcs-data-modal-actions">
          <button type="button" className="bcs-data-button" onClick={onClose}>Скасувати</button>
          <button type="submit" className={`bcs-data-button ${destructive ? "bcs-data-button-danger" : "bcs-data-button-primary"}`}>{submitLabel}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function NumberField({ label, value, onChange, min = 0 }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  return <label className="bcs-data-field"><span>{label}</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={value} onChange={(event) => {
    const digits = event.target.value.replace(/\D/g, "");
    onChange(Math.min(2_000, Math.max(min, digits ? Number(digits) : min)));
  }} /></label>;
}

function SummaryTable({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  return <section className="bcs-data-summary-card"><h3>{title}</h3><table><tbody>{rows.map(([label, count]) => <tr key={label}><th scope="row">{label}</th><td>{count}</td></tr>)}</tbody></table></section>;
}

export default function BcsDataPanel({ data, structureType, summary, onChange, onError, onAddBlock }: Props) {
  const [tab, setTab] = useState<DataTab>("people");
  const [query, setQuery] = useState("");
  const [blockFilter, setBlockFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [addKind, setAddKind] = useState<BlockKind>("crew");
  const [personEditor, setPersonEditor] = useState<PersonEditor | null>(null);
  const [blockEditor, setBlockEditor] = useState<BlockEditor | null>(null);
  const [positionEditor, setPositionEditor] = useState<BcsPosition | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const personnel = useMemo(() => editorPersonnelRows(data), [data]);
  const positionsById = useMemo(() => new Map(data.positions.map((position) => [position.id, position])), [data.positions]);
  const blockOptions = data.blocks.map((block) => ({ value: block.id, label: block.name || kindLabel(block.kind) }));
  const filledPersonnel = personnel.filter(({ person }) => missingRequiredPersonFields(person).length === 0).length;
  const visiblePeople = personnel.filter(({ block, person }) =>
    (!blockFilter || block.id === blockFilter)
    && (!locationFilter || person.location === locationFilter)
    && textMatches(query, block.name, person.rank, person.fullName, person.position, person.duties, person.location, person.note, block.positionName),
  );
  const visibleBlocks = data.blocks.filter((block) =>
    (!kindFilter || block.kind === kindFilter)
    && textMatches(query, block.name, kindLabel(block.kind), block.positionName, block.uavName, block.uavType, block.status),
  );
  const visiblePositions = data.positions.filter((position) => textMatches(query, position.name, position.bro, position.workSector));
  const quickKinds = quickBlockTypesForStructure(structureType).map((item) => ({
    value: item.value,
    label: item.label,
    disabled: isSingletonBlockKind(item.value) && data.blocks.some((block) => block.kind === item.value),
  }));
  const positionLinks = (id: string) => data.blocks.filter((block) => data.positionByBlock[block.id] === id);

  function apply(action: () => BcsEditorData): boolean {
    try {
      onChange(action());
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : typeof error === "string" ? error : "Не вдалося зберегти зміни.");
      return false;
    }
  }

  function savePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!personEditor) return;
    const editor = personEditor;
    if (!data.blocks.some((block) => block.id === editor.blockId)) { onError("Оберіть підрозділ для військовослужбовця."); return; }
    const saved = apply(() => {
      if (editor.source) {
        let next = updateEditorPerson(data, editor.source.blockId, editor.source.index, editor.person);
        if (editor.source.blockId !== editor.blockId) next = moveEditorPerson(next, editor.source.blockId, editor.source.index, editor.blockId);
        return next;
      }
      const block = data.blocks.find((candidate) => candidate.id === editor.blockId)!;
      const emptyRow = personnel.find((row) => row.block.id === editor.blockId && !personHasAnyData(row.person));
      const index = emptyRow?.index ?? normalizedSlots(block.slots);
      return updateEditorPerson(addEditorPerson(data, editor.blockId), editor.blockId, index, editor.person);
    });
    if (saved) setPersonEditor(null);
  }

  function saveBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!blockEditor) return;
    const { block, positionId } = blockEditor;
    const original = data.blocks.find((candidate) => candidate.id === block.id);
    if (!original) { onError("Підрозділ уже видалено."); return; }
    const nextBlock = {
      ...block,
      name: hasEditableBlockName(block.kind)
        ? block.name
        : original.kind === block.kind ? original.name : defaultBlockName(block.kind),
    };
    if (!nextBlock.name.trim()) { onError("Вкажіть назву підрозділу."); return; }
    if (original.kind !== block.kind) {
      if (isRequiredManagementBlock(structureType, original.kind) || isRequiredManagementBlock(structureType, block.kind)) { onError("Тип обов’язкового управління змінити не можна."); return; }
      if (structureType === "platoon" && block.kind === "companyManagement") { onError("У взводі немає управління роти."); return; }
      if (isSingletonBlockKind(block.kind) && data.blocks.some((candidate) => candidate.id !== block.id && candidate.kind === block.kind)) { onError("Такий підрозділ уже є у структурі."); return; }
    }
    if (apply(() => setEditorBlockPosition(updateEditorBlock(data, block.id, nextBlock), block.id, positionId || null))) setBlockEditor(null);
  }

  function savePosition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!positionEditor) return;
    if (!positionEditor.name.trim()) { onError("Вкажіть назву позиції."); return; }
    if (apply(() => saveEditorPosition(data, positionEditor))) setPositionEditor(null);
  }

  function changeTab(next: DataTab) {
    setTab(next);
    setQuery("");
  }

  const visibleCount = tab === "people" ? visiblePeople.length : tab === "blocks" ? visibleBlocks.length : visiblePositions.length;
  const totalCount = tab === "people" ? personnel.length : tab === "blocks" ? data.blocks.length : data.positions.length;
  const selectedPersonBlock = personEditor ? data.blocks.find((block) => block.id === personEditor.blockId) : undefined;

  return <section className="bcs-data-panel" aria-label="Дані БЧС">
    <nav className="bcs-data-tabs" aria-label="Розділи даних">
      {([
        ["people", "Особовий склад", Users, personnel.length],
        ["blocks", "Підрозділи", Building2, data.blocks.length],
        ["positions", "Позиції", MapPin, data.positions.length],
      ] as const).map(([value, label, Icon, count]) => <button key={value} type="button" className={tab === value ? "active" : ""} aria-current={tab === value ? "page" : undefined} onClick={() => changeTab(value)}><Icon size={17} aria-hidden="true" /><span>{label}</span><span className="bcs-data-tab-count">{count}</span></button>)}
    </nav>

    <div className="bcs-data-toolbar">
      <label className="bcs-data-search"><Search size={17} aria-hidden="true" /><input aria-label="Пошук у даних БЧС" placeholder={tab === "people" ? "ПІБ, підрозділ, посада…" : tab === "blocks" ? "Назва, тип, позиція…" : "Позиція, БРО, сектор…"} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {tab === "people" && <>
        <div className="bcs-data-filter"><CustomSelect portal ariaLabel="Фільтр за підрозділом" value={blockFilter} options={[{ value: "", label: "Усі підрозділи" }, ...blockOptions]} onChange={setBlockFilter} /></div>
        <div className="bcs-data-filter"><CustomSelect portal ariaLabel="Фільтр за місцем перебування" value={locationFilter} options={[{ value: "", label: "Усі місця" }, ...LOCATIONS.map((value) => ({ value, label: value }))]} onChange={setLocationFilter} /></div>
      </>}
      {tab === "blocks" && <div className="bcs-data-filter"><CustomSelect portal ariaLabel="Фільтр за типом підрозділу" value={kindFilter} options={[{ value: "", label: "Усі типи" }, ...BLOCK_TYPES.map((item) => ({ value: item.value, label: item.label }))]} onChange={setKindFilter} /></div>}
      <span className="bcs-data-result-count">{visibleCount === totalCount ? `${totalCount} записів` : `${visibleCount} з ${totalCount}`}</span>
      {tab === "people" && <button type="button" className="bcs-data-button bcs-data-button-primary" disabled={!data.blocks.length} onClick={() => setPersonEditor({ source: null, blockId: blockFilter || data.blocks[0]?.id || "", person: emptyPerson(blockFilter || data.blocks[0]?.id || "") })}><Plus size={17} />Додати людину</button>}
      {tab === "blocks" && <div className="bcs-data-add-block"><CustomSelect portal ariaLabel="Тип нового підрозділу" value={addKind} options={quickKinds} onChange={setAddKind} /><button type="button" className="bcs-data-button bcs-data-button-primary" disabled={quickKinds.find((item) => item.value === addKind)?.disabled ?? true} onClick={() => onAddBlock(addKind)}><Plus size={17} />Додати</button></div>}
      {tab === "positions" && <button type="button" className="bcs-data-button bcs-data-button-primary" onClick={() => setPositionEditor(createEditorPosition())}><Plus size={17} />Додати позицію</button>}
    </div>

    {tab === "people" && <>
      <div className="bcs-data-personnel-count"><span>Заповнено: <strong>{filledPersonnel}</strong> з {personnel.length}</span>{filledPersonnel < personnel.length && <span className="bcs-data-incomplete">Потрібно доповнити: {personnel.length - filledPersonnel}</span>}</div>
      <div className="bcs-data-table-scroll"><table className="bcs-data-table bcs-data-people-table"><thead><tr><th scope="col">№</th><th scope="col">Підрозділ</th><th scope="col">Звання</th><th scope="col">П.І.Б.</th><th scope="col">Посада по штату</th><th scope="col">Обов’язки</th><th scope="col">Де знаходиться</th><th scope="col">Позиція</th><th scope="col">Примітка</th><th scope="col">Дії</th></tr></thead><tbody>
        {visiblePeople.map(({ key, block, index, person }, rowIndex) => {
          const missing = missingRequiredPersonFields(person);
          return <tr key={key} className={missing.length ? "bcs-data-row-incomplete" : ""}><td>{rowIndex + 1}</td><td>{block.name}<small>{kindLabel(block.kind)}</small></td><td>{valueOrDash(person.rank)}</td><td>{person.fullName.trim() || <span className="bcs-data-empty">Не заповнено</span>}{missing.length > 0 && <small className="bcs-data-incomplete" title={`Для експорту заповніть: ${missing.join(", ")}`}>Не заповнено: {missing.join(", ")}</small>}</td><td>{valueOrDash(person.position)}</td><td>{valueOrDash(person.duties)}</td><td>{valueOrDash(person.location)}</td><td>{valueOrDash(block.positionName)}</td><td>{valueOrDash(person.note)}</td><td><div className="bcs-data-row-actions"><button type="button" className="bcs-data-icon-button" aria-label={`Редагувати ${person.fullName || `місце ${index + 1} у ${block.name}`}`} onClick={() => setPersonEditor({ source: { blockId: block.id, index }, blockId: block.id, person: { ...person } })}><Pencil size={17} /></button><button type="button" className="bcs-data-icon-button bcs-data-delete" aria-label={`Видалити місце ${index + 1} у ${block.name}`} onClick={() => setConfirmation({ title: "Видалити місце?", text: `${person.fullName || "Порожнє місце"} буде видалено з підрозділу «${block.name}». ${block.slots > 1 ? "Кількість в/с у цьому підрозділі зменшиться на один." : "У підрозділі залишиться одне порожнє місце."}`, confirm: () => apply(() => removeEditorPerson(data, block.id, index)) })}><Trash2 size={17} /></button></div></td></tr>;
        })}
        {visiblePeople.length === 0 && <tr><td colSpan={10} className="bcs-data-no-results">{personnel.length ? "Нічого не знайдено" : "Додайте підрозділ або людину"}</td></tr>}
      </tbody></table></div>
      <div className="bcs-data-summary"><SummaryTable title="БЧС підрозділу" rows={summary.main} /><SummaryTable title="БЧС по функціоналу" rows={summary.functional} /><SummaryTable title="Де знаходиться" rows={summary.locations} /></div>
    </>}

    {tab === "blocks" && <div className="bcs-data-table-scroll"><table className="bcs-data-table bcs-data-blocks-table"><thead><tr><th scope="col">Тип підрозділу</th><th scope="col">Назва</th><th scope="col">Назва БпАК</th><th scope="col">Тип БпАК</th><th scope="col">Статус екіпажу</th><th scope="col">Фактично в/с в екіпажі</th><th scope="col">Кількість в/с</th><th scope="col">Позиція</th><th scope="col">Дії</th></tr></thead><tbody>
      {visibleBlocks.map((block) => {
        const people = personnel.filter((row) => row.block.id === block.id);
        const completed = people.filter((row) => missingRequiredPersonFields(row.person).length === 0).length;
        const required = isRequiredManagementBlock(structureType, block.kind);
        return <tr key={block.id}><td>{kindLabel(block.kind)}</td><td>{block.name}{required && <small>Обов’язковий підрозділ</small>}</td><td>{block.kind === "crew" ? valueOrDash(block.uavName) : "—"}</td><td>{block.kind === "crew" ? valueOrDash(block.uavType) : "—"}</td><td>{block.kind === "crew" ? <Status value={block.status} /> : "—"}</td><td>{block.kind === "crew" ? block.crewActual : "—"}</td><td><strong>{normalizedSlots(block.slots)}</strong><small>Заповнено: {completed}</small></td><td>{valueOrDash(positionsById.get(data.positionByBlock[block.id])?.name ?? block.positionName)}</td><td><div className="bcs-data-row-actions"><button type="button" className="bcs-data-icon-button" aria-label={`Редагувати ${block.name}`} onClick={() => setBlockEditor({ block: { ...block }, positionId: data.positionByBlock[block.id] ?? "" })}><Pencil size={17} /></button><button type="button" className="bcs-data-icon-button bcs-data-delete" disabled={required} title={required ? "Обов’язкове управління не можна видалити" : "Видалити підрозділ"} aria-label={`Видалити ${block.name}`} onClick={() => setConfirmation({ title: "Видалити підрозділ?", text: `Підрозділ «${block.name}» і всі його місця (${people.length}) буде видалено.`, confirm: () => apply(() => removeEditorBlock(data, block.id)) })}><Trash2 size={17} /></button></div></td></tr>;
      })}
      {visibleBlocks.length === 0 && <tr><td colSpan={9} className="bcs-data-no-results">{data.blocks.length ? "Нічого не знайдено" : "Додайте підрозділ"}</td></tr>}
    </tbody></table></div>}

    {tab === "positions" && <div className="bcs-data-table-scroll"><table className="bcs-data-table bcs-data-positions-table"><thead><tr><th scope="col">Назва позиції</th><th scope="col">БРО</th><th scope="col">Сектор роботи</th><th scope="col">Пов’язані підрозділи</th><th scope="col">Дії</th></tr></thead><tbody>
      {visiblePositions.map((position) => {
        const linked = positionLinks(position.id);
        return <tr key={position.id}><td>{valueOrDash(position.name)}</td><td>{valueOrDash(position.bro)}</td><td>{valueOrDash(position.workSector)}</td><td>{linked.length ? <>{linked.map((block) => block.name).join(", ")}<small>Підрозділів: {linked.length}</small></> : <span className="bcs-data-empty">Без підрозділів</span>}</td><td><div className="bcs-data-row-actions"><button type="button" className="bcs-data-icon-button" aria-label={`Редагувати позицію ${position.name}`} onClick={() => setPositionEditor({ ...position })}><Pencil size={17} /></button><button type="button" className="bcs-data-icon-button bcs-data-delete" aria-label={`Видалити позицію ${position.name}`} onClick={() => setConfirmation({ title: "Видалити позицію?", text: `Позицію «${position.name || "Без назви"}» буде видалено.${linked.length ? ` Зв’язок із підрозділами (${linked.length}) буде знято. Підрозділи та люди залишаться.` : ""}`, confirm: () => apply(() => removeEditorPosition(data, position.id)) })}><Trash2 size={17} /></button></div></td></tr>;
      })}
      {visiblePositions.length === 0 && <tr><td colSpan={5} className="bcs-data-no-results">{data.positions.length ? "Нічого не знайдено" : "Додайте позицію. Пов’язати її з підрозділом можна під час редагування підрозділу."}</td></tr>}
    </tbody></table></div>}

    {personEditor && <Modal title={personEditor.source ? "Військовослужбовець" : "Додати військовослужбовця"} onClose={() => setPersonEditor(null)} onSubmit={savePerson}>
      <div className="bcs-data-form-grid">
        <label className="bcs-data-field bcs-data-wide"><span>Підрозділ</span><CustomSelect portal ariaLabel="Підрозділ військовослужбовця" value={personEditor.blockId} options={blockOptions} onChange={(blockId) => setPersonEditor({ ...personEditor, blockId })} /></label>
        <label className="bcs-data-field"><span>Військове звання</span><CustomSelect portal ariaLabel="Військове звання" value={personEditor.person.rank} options={[{ value: "", label: "Не вказано" }, ...Array.from(new Set([...RANKS, ...(personEditor.person.rank ? [personEditor.person.rank] : [])])).map((value) => ({ value, label: value }))]} onChange={(rank) => setPersonEditor({ ...personEditor, person: { ...personEditor.person, rank } })} /></label>
        <label className="bcs-data-field"><span>П.І.Б.</span><input value={personEditor.person.fullName} onChange={(event) => setPersonEditor({ ...personEditor, person: { ...personEditor.person, fullName: event.target.value } })} /></label>
        <label className="bcs-data-field"><span>Посада по штату</span><input value={personEditor.person.position} onChange={(event) => setPersonEditor({ ...personEditor, person: { ...personEditor.person, position: event.target.value } })} /></label>
        <label className="bcs-data-field"><span>Де знаходиться</span><CustomSelect portal ariaLabel="Де знаходиться військовослужбовець" value={personEditor.person.location} options={[{ value: "", label: "Не вказано" }, ...Array.from(new Set([...LOCATIONS, ...(personEditor.person.location ? [personEditor.person.location] : [])])).map((value) => ({ value, label: value }))]} onChange={(location) => setPersonEditor({ ...personEditor, person: { ...personEditor.person, location } })} /></label>
        <label className="bcs-data-field bcs-data-wide"><span>Функціональні обов’язки</span><textarea rows={2} value={personEditor.person.duties} onChange={(event) => setPersonEditor({ ...personEditor, person: { ...personEditor.person, duties: event.target.value } })} /></label>
        <label className="bcs-data-field bcs-data-wide"><span>Примітка</span><textarea rows={2} value={personEditor.person.note} onChange={(event) => setPersonEditor({ ...personEditor, person: { ...personEditor.person, note: event.target.value } })} /></label>
      </div>
      {selectedPersonBlock?.positionName && <p className="bcs-data-form-note">Позиція підрозділу: <strong>{selectedPersonBlock.positionName}</strong></p>}
      <p className="bcs-data-form-note">Для експорту потрібні звання, П.І.Б. та «Де знаходиться».</p>
    </Modal>}

    {blockEditor && <Modal title="Підрозділ" onClose={() => setBlockEditor(null)} onSubmit={saveBlock}>
      <div className="bcs-data-form-grid">
        <label className="bcs-data-field"><span>Тип підрозділу</span><CustomSelect portal ariaLabel="Тип підрозділу" value={blockEditor.block.kind} disabled={isRequiredManagementBlock(structureType, data.blocks.find((block) => block.id === blockEditor.block.id)?.kind ?? blockEditor.block.kind)} options={BLOCK_TYPES.filter((item) => item.value !== "independent" || item.value === blockEditor.block.kind).filter((item) => structureType !== "platoon" || item.value !== "companyManagement").map((item) => ({ value: item.value, label: item.label, disabled: item.value !== blockEditor.block.kind && (isRequiredManagementBlock(structureType, item.value) || (isSingletonBlockKind(item.value) && data.blocks.some((block) => block.id !== blockEditor.block.id && block.kind === item.value))) }))} onChange={(kind) => setBlockEditor({ ...blockEditor, block: { ...blockEditor.block, kind, name: defaultBlockName(kind), status: kind === "crew" ? (blockEditor.block.status || CREW_STATUSES[0]) : "", uavType: kind === "crew" ? (blockEditor.block.uavType || UAV_TYPES[0]) : "", uavName: kind === "crew" ? blockEditor.block.uavName : "", crewActual: kind === "crew" ? blockEditor.block.kind === "crew" ? blockEditor.block.crewActual : normalizedSlots(blockEditor.block.slots) : 0 } })} /></label>
        <label className="bcs-data-field"><span>{!hasEditableBlockName(blockEditor.block.kind) ? "Назва підрозділу (за типом)" : blockEditor.block.kind === "crew" ? "Назва екіпажу" : "Назва підрозділу"}</span><input readOnly={!hasEditableBlockName(blockEditor.block.kind)} value={blockEditor.block.name} onChange={(event) => setBlockEditor({ ...blockEditor, block: { ...blockEditor.block, name: event.target.value } })} /></label>
        <NumberField label="Кількість в/с (місць)" min={1} value={blockEditor.block.slots} onChange={(slots) => setBlockEditor({ ...blockEditor, block: { ...blockEditor.block, slots } })} />
        <label className="bcs-data-field"><span>Позиція</span><CustomSelect portal ariaLabel="Позиція підрозділу" value={blockEditor.positionId} options={[{ value: "", label: "Без позиції" }, ...data.positions.map((position) => ({ value: position.id, label: [position.name || "Без назви", position.bro].filter(Boolean).join(" · ") }))]} onChange={(positionId) => setBlockEditor({ ...blockEditor, positionId })} /></label>
        {blockEditor.block.kind === "crew" && <>
          <label className="bcs-data-field"><span>Назва БпАК</span><input value={blockEditor.block.uavName} onChange={(event) => setBlockEditor({ ...blockEditor, block: { ...blockEditor.block, uavName: event.target.value } })} /></label>
          <label className="bcs-data-field"><span>Тип БпАК</span><CustomSelect portal ariaLabel="Тип БпАК екіпажу" value={blockEditor.block.uavType} options={Array.from(new Set([...UAV_TYPES, ...(blockEditor.block.uavType ? [blockEditor.block.uavType] : [])])).map((value) => ({ value, label: value }))} onChange={(uavType) => setBlockEditor({ ...blockEditor, block: { ...blockEditor.block, uavType } })} /></label>
          <label className="bcs-data-field"><span>Статус екіпажу</span><CustomSelect portal ariaLabel="Статус екіпажу" value={blockEditor.block.status} options={Array.from(new Set([...CREW_STATUSES, ...(blockEditor.block.status ? [blockEditor.block.status] : [])])).map((value) => ({ value, label: value }))} onChange={(status) => setBlockEditor({ ...blockEditor, block: { ...blockEditor.block, status } })} /></label>
          <NumberField label="Фактично в/с в екіпажі" value={blockEditor.block.crewActual} onChange={(crewActual) => setBlockEditor({ ...blockEditor, block: { ...blockEditor.block, crewActual } })} />
        </>}
      </div>
      <p className="bcs-data-form-note">Кількість в/с визначає кількість рядків людей у БЧС.{blockEditor.block.kind === "crew" && " Фактична кількість в екіпажі задається окремо."}</p>
      {!data.positions.length && <p className="bcs-data-form-note">Позиції додаються в розділі «Позиції».</p>}
      {blockEditor.positionId && positionsById.get(blockEditor.positionId) && <p className="bcs-data-form-note">БРО: {positionsById.get(blockEditor.positionId)?.bro || "—"}. Сектор роботи: {positionsById.get(blockEditor.positionId)?.workSector || "—"}.</p>}
    </Modal>}

    {positionEditor && <Modal title={data.positions.some((position) => position.id === positionEditor.id) ? "Позиція" : "Додати позицію"} onClose={() => setPositionEditor(null)} onSubmit={savePosition}>
      <div className="bcs-data-form-grid">
        <label className="bcs-data-field bcs-data-wide"><span>Назва позиції</span><input value={positionEditor.name} onChange={(event) => setPositionEditor({ ...positionEditor, name: event.target.value })} /></label>
        <label className="bcs-data-field"><span>БРО</span><input value={positionEditor.bro} onChange={(event) => setPositionEditor({ ...positionEditor, bro: event.target.value })} /></label>
        <label className="bcs-data-field"><span>Сектор роботи</span><input value={positionEditor.workSector} onChange={(event) => setPositionEditor({ ...positionEditor, workSector: event.target.value })} /></label>
      </div>
      {positionLinks(positionEditor.id).length > 0 && <p className="bcs-data-form-note">Зміни з’являться у всіх пов’язаних підрозділах: {positionLinks(positionEditor.id).map((block) => block.name).join(", ")}.</p>}
    </Modal>}

    {confirmation && <Modal title={confirmation.title} onClose={() => setConfirmation(null)} submitLabel="Видалити" destructive onSubmit={(event) => { event.preventDefault(); if (confirmation.confirm()) setConfirmation(null); }}><p className="bcs-data-confirmation-text">{confirmation.text}</p></Modal>}
  </section>;
}
