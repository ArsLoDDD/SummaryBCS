import { type CSSProperties } from "react";
import {
  calculateStripsSummary,
  readinessDisplay,
  type CountMatrix,
  type StripCrew,
  type StripGroup,
  type StripPosition,
  type StripsReport,
  type WorkStrip,
} from "./strips";
import {
  calculateStripsOperationalStats,
  type StripsOperationalStats,
} from "./stripsOperationalStats";

const HEADERS = [
  "Підрозділ",
  "Тип БпЛА",
  "Назва екіпажу",
  "БГ екіпажу",
  "БЧ екіпажу",
  "Засіб",
  "Позиція",
  "БГ позиції",
  "БРО",
  "Район",
  "Напрямок роботи",
  "Примітки",
] as const;

type GroupTableRow =
  | {
      kind: "position";
      position: StripPosition;
      crew: StripCrew | null;
      crewIndex: number;
      positionRowCount: number;
    }
  | { kind: "loose"; crew: StripCrew }
  | { kind: "empty" };

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function statusClass(status: string): string {
  if (status === "БГ") return "status-ready";
  if (status === "Не БГ") return "status-not-ready";
  if (status === "Формується") return "status-forming";
  return "status-neutral";
}

function StripsColGroup() {
  return (
    <colgroup>
      <col className="strips-col-unit" />
      <col className="strips-col-type" />
      <col className="strips-col-crew" />
      <col className="strips-col-crew-ready" />
      <col className="strips-col-duty" />
      <col className="strips-col-assets" />
      <col className="strips-col-position" />
      <col className="strips-col-position-ready" />
      <col className="strips-col-bro" />
      <col className="strips-col-area" />
      <col className="strips-col-direction" />
      <col className="strips-col-note" />
    </colgroup>
  );
}

function groupTableRows(group: StripGroup): GroupTableRow[] {
  const rows: GroupTableRow[] = [];
  group.positions.forEach((position) => {
    const crews: Array<StripCrew | null> = position.crews.length > 0 ? position.crews : [null];
    crews.forEach((crew, crewIndex) => rows.push({
      kind: "position",
      position,
      crew,
      crewIndex,
      positionRowCount: crews.length,
    }));
  });
  group.looseCrews.forEach((crew) => rows.push({ kind: "loose", crew }));
  return rows.length > 0 ? rows : [{ kind: "empty" }];
}

function percent(value: number): string {
  return `${value.toLocaleString("uk-UA", { maximumFractionDigits: 1 })}%`;
}

function OperationalSummaryTables({ stats }: { stats: StripsOperationalStats }) {
  return (
    <div className="strips-operational-stats">
      <div className="strips-operational-readiness">
        <table>
          <caption>Готовність екіпажів за підрозділами</caption>
          <thead><tr><th>Підрозділ</th><th>БГ</th><th>Не БГ</th><th>Всього</th><th>БГ, %</th></tr></thead>
          <tbody>
            {stats.readinessByUnit.map((row) => <tr key={row.label}><th>{row.label}</th><td>{row.ready}</td><td>{row.notReady}</td><td>{row.total}</td><td>{percent(row.readyRatePercent)}</td></tr>)}
          </tbody>
        </table>
        <table>
          <caption>Готовність екіпажів за смугами</caption>
          <thead><tr><th>Смуга</th><th>БГ</th><th>Не БГ</th><th>Всього</th><th>БГ, %</th></tr></thead>
          <tbody>
            {stats.readinessByStrip.map((row) => <tr key={row.label}><th>{row.label}</th><td>{row.ready}</td><td>{row.notReady}</td><td>{row.total}</td><td>{percent(row.readyRatePercent)}</td></tr>)}
          </tbody>
        </table>
      </div>
      <table className="strips-coverage-table">
        <caption>Заповнення екіпажів і позицій за підрозділами</caption>
        <thead><tr><th>Підрозділ</th><th>Екіпажів</th><th>З позицією</th><th>Без позиції</th><th>Зв’язано, %</th><th>Позицій</th><th>З екіпажем</th><th>Без екіпажу</th><th>Заповнено, %</th></tr></thead>
        <tbody>
          {stats.coverageByUnit.map((row) => <tr key={row.label}>
            <th>{row.label}</th><td>{row.crewsTotal}</td><td>{row.crewsLinked}</td><td>{row.crewsUnlinked}</td><td>{percent(row.crewLinkRatePercent)}</td>
            <td>{row.positionsTotal}</td><td>{row.positionsOccupied}</td><td>{row.positionsEmpty}</td><td>{percent(row.positionStaffingRatePercent)}</td>
          </tr>)}
          <tr className="strips-total-row">
            <th>Усього</th><td>{stats.coverageOverall.crewsTotal}</td><td>{stats.coverageOverall.crewsLinked}</td><td>{stats.coverageOverall.crewsUnlinked}</td><td>{percent(stats.coverageOverall.crewLinkRatePercent)}</td>
            <td>{stats.coverageOverall.positionsTotal}</td><td>{stats.coverageOverall.positionsOccupied}</td><td>{stats.coverageOverall.positionsEmpty}</td><td>{percent(stats.coverageOverall.positionStaffingRatePercent)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SummaryTables({ summary, stats }: {
  summary: ReturnType<typeof calculateStripsSummary>;
  stats: StripsOperationalStats;
}) {
  return (
    <section className="strips-summary" aria-label="Загальний підсумок">
      <h2>Загальний підсумок</h2>
      <div className="strips-summary-grid">
        <table>
          <caption>Екіпажі за типом БпЛА</caption>
          <thead><tr><th>Тип БпЛА</th><th>БГ</th><th>Не БГ</th><th>Формується</th><th>Всього</th></tr></thead>
          <tbody>
            {summary.crews.map((row) => (
              <tr key={row.uavType}><th>{row.uavType}</th><td>{row.ready}</td><td>{row.notReady}</td><td>{row.forming}</td><td>{row.total}</td></tr>
            ))}
            <tr className="strips-total-row"><th>Усього</th><td>{summary.crewTotals.ready}</td><td>{summary.crewTotals.notReady}</td><td>{summary.crewTotals.forming}</td><td>{summary.crewTotals.total}</td></tr>
          </tbody>
        </table>

        <table>
          <caption>Позиції за типом БпЛА</caption>
          <thead><tr><th>Тип БпЛА</th><th>БГ</th><th>Не БГ</th><th>Всього</th></tr></thead>
          <tbody>
            {summary.positions.map((row) => (
              <tr key={row.uavType}><th>{row.uavType}</th><td>{row.ready}</td><td>{row.notReady}</td><td>{row.total}</td></tr>
            ))}
            <tr className="strips-total-row"><th>Усього</th><td>{summary.positionTotals.ready}</td><td>{summary.positionTotals.notReady}</td><td>{summary.positionTotals.total}</td></tr>
          </tbody>
        </table>

        <table>
          <thead><tr><th>Тип БпЛА</th><th>Екіпажів без позиції</th><th>Позицій без екіпажів</th></tr></thead>
          <tbody>
            {summary.exceptions.map((row) => (
              <tr key={row.uavType}><th>{row.uavType}</th><td>{row.crewsWithoutPosition}</td><td>{row.positionsWithoutCrews}</td></tr>
            ))}
            <tr className="strips-total-row"><th>Усього</th><td>{summary.crewsWithoutPosition}</td><td>{summary.positionsWithoutCrews}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="strips-summary-matrices">
        <SummaryMatrix
          caption="Екіпажі за підрозділами по смугах"
          rowHeader="Підрозділ"
          matrix={summary.crewsByUnitAndStrip}
        />
        <SummaryMatrix
          caption="Екіпажі за підрозділами по типах БпЛА"
          rowHeader="Підрозділ"
          matrix={summary.crewsByUnitAndUavType}
        />
        <SummaryMatrix
          caption="Екіпажі по смугах за типами БпЛА"
          rowHeader="Смуга"
          matrix={summary.crewsByStripAndUavType}
        />
      </div>
      <OperationalSummaryTables stats={stats} />
    </section>
  );
}

function SummaryMatrix({ caption, rowHeader, matrix }: {
  caption: string;
  rowHeader: string;
  matrix: CountMatrix;
}) {
  return (
    <table className="strips-summary-matrix">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th>{rowHeader}</th>
          {matrix.columns.map((column) => <th key={column}>{column}</th>)}
          <th>Усього</th>
        </tr>
      </thead>
      <tbody>
        {matrix.rows.map((row) => (
          <tr key={row.label}>
            <th>{row.label}</th>
            {row.values.map((value, index) => <td key={matrix.columns[index]}>{value}</td>)}
            <td>{row.total}</td>
          </tr>
        ))}
        <tr className="strips-total-row">
          <th>Усього</th>
          {matrix.columnTotals.map((value, index) => <td key={matrix.columns[index]}>{value}</td>)}
          <td>{matrix.total}</td>
        </tr>
      </tbody>
    </table>
  );
}

function StripSummaryRow({ strip }: { strip: WorkStrip }) {
  const summary = calculateStripsSummary([strip]);
  return (
    <table className="strips-strip-summary" aria-label={`Підсумок смуги ${strip.name || "без назви"}`}>
      <thead>
        <tr><th>Показник</th><th>Всього</th><th className="status-ready">БГ</th><th className="status-not-ready">Не БГ</th></tr>
      </thead>
      <tbody>
        <tr>
          <th>Екіпажі</th>
          <td>{summary.crewTotals.total}</td>
          <td className="status-ready">{summary.crewTotals.ready}</td>
          <td className="status-not-ready">{summary.crewTotals.notReady}</td>
        </tr>
        <tr>
          <th>Позиції</th>
          <td>{summary.positionTotals.total}</td>
          <td className="status-ready">{summary.positionTotals.ready}</td>
          <td className="status-not-ready">{summary.positionTotals.notReady}</td>
        </tr>
      </tbody>
    </table>
  );
}

function ReadonlyNote({ crew, position, first }: {
  crew: StripCrew | null;
  position: StripPosition;
  first: boolean;
}) {
  const note = [crew?.note, first ? position.note : ""].filter(Boolean).join("\n");
  return <td className="strips-readonly-note">{note}</td>;
}

export default function StripsReportView({ report, zoom }: { report: StripsReport; zoom: number }) {
  const summary = calculateStripsSummary(report.strips);
  const operationalStats = calculateStripsOperationalStats(report.strips);

  return (
    <div className="strips-table-scale strips-readonly-report" style={{ "--strips-table-zoom": zoom / 100 } as CSSProperties}>
      <div className="strips-sheet-title">
        <strong>Позиції та екіпажі по смугах</strong>
        <span>станом на {formatDate(report.reportDate)}</span>
      </div>

      {report.strips.length === 0 && (
        <p className="strips-readonly-empty">Після додавання екіпажів або позицій тут автоматично з’явиться сформована таблиця.</p>
      )}

      {report.strips.map((strip) => (
        <section className="strips-section" key={strip.id}>
          <div className="strips-section-toolbar strips-readonly-section-title">
            <div className="strips-section-toolbar-inner">
              <strong>{strip.name || "Смуга без назви"}</strong>
            </div>
          </div>

          <table className="strips-editor-table strips-readonly-table">
            <StripsColGroup />
            <thead><tr>{HEADERS.map((header) => <th key={header}>{header}</th>)}</tr></thead>
            <tbody>
              {strip.groups.flatMap((group, groupIndex) => {
                const rows = groupTableRows(group);
                const previousType = strip.groups[groupIndex - 1]?.uavType;
                const isTypeRunStart = !group.uavType || previousType !== group.uavType;
                let typeRunRowCount = rows.length;
                if (isTypeRunStart && group.uavType) {
                  for (let index = groupIndex + 1; index < strip.groups.length; index += 1) {
                    if (strip.groups[index].uavType !== group.uavType) break;
                    typeRunRowCount += groupTableRows(strip.groups[index]).length;
                  }
                }

                return rows.map((row, groupRowIndex) => {
                  const groupCells = groupRowIndex === 0 ? (
                    <>
                      <td rowSpan={rows.length} className="strips-group-rowspan-cell">{group.unit}</td>
                      {isTypeRunStart && <td rowSpan={typeRunRowCount} className="strips-type-rowspan-cell">{group.uavType}</td>}
                    </>
                  ) : null;

                  if (row.kind === "empty") {
                    return (
                      <tr className="strips-unmatched-row" key={`${group.id}-empty`}>
                        {groupCells}
                        <td colSpan={10} className="strips-unmatched-label">Позиції та екіпажі відсутні</td>
                      </tr>
                    );
                  }

                  if (row.kind === "loose") {
                    const note = row.crew.note;
                    return (
                      <tr className="strips-unmatched-row" key={row.crew.id}>
                        {groupCells}
                        <td className="strips-status-band status-neutral">{row.crew.name}</td>
                        <td className="strips-status-band status-neutral">{readinessDisplay(row.crew.readiness, row.crew.notReadyReason)}</td>
                        <td className="strips-status-band status-neutral">{row.crew.duty}</td>
                        <td className="strips-status-band status-neutral">{row.crew.assets}</td>
                        <td colSpan={5} className="strips-status-band status-neutral strips-unmatched-label">Екіпаж без позиції</td>
                        <td className="strips-readonly-note">{note}</td>
                      </tr>
                    );
                  }

                  const first = row.crewIndex === 0;
                  const crewTone = row.crew ? statusClass(row.crew.readiness) : "status-neutral";
                  const positionTone = row.crew ? statusClass(row.position.readiness) : "status-neutral";
                  return (
                    <tr key={row.crew?.id ?? `${row.position.id}-empty`}>
                      {groupCells}
                      {row.crew ? (
                        <>
                          <td className={`strips-status-band ${crewTone}`}>{row.crew.name}</td>
                          <td className={`strips-status-band ${crewTone}`}>{readinessDisplay(row.crew.readiness, row.crew.notReadyReason)}</td>
                          <td className={`strips-status-band ${crewTone}`}>{row.crew.duty}</td>
                          <td className={`strips-status-band ${crewTone}`}>{row.crew.assets}</td>
                        </>
                      ) : (
                        <td colSpan={4} className="strips-status-band status-neutral strips-unmatched-label">Позиція без екіпажу</td>
                      )}
                      {first && (
                        <>
                          <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}`}>{row.position.name}</td>
                          <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}`}>{readinessDisplay(row.position.readiness, row.position.notReadyReason)}</td>
                          <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}`}>{row.position.bro}</td>
                          <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}`}>{row.position.area}</td>
                          <td rowSpan={row.positionRowCount} className={`strips-status-band ${positionTone}`}>{row.position.direction}</td>
                        </>
                      )}
                      <ReadonlyNote crew={row.crew} position={row.position} first={first} />
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
          {strip.name !== "Екіпажі без позиції" && <StripSummaryRow strip={strip} />}
        </section>
      ))}

      <SummaryTables summary={summary} stats={operationalStats} />
    </div>
  );
}
