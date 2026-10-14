import {
  CREW_READINESS,
  type CrewReadiness,
  type StatusCounts,
  type StripCrew,
  type StripPosition,
  type WorkStrip,
} from "./strips";

export interface ReadinessBreakdownRow extends StatusCounts {
  label: string;
  readyRatePercent: number;
}

export interface LinkCoverageCounts {
  crewsTotal: number;
  crewsLinked: number;
  crewsUnlinked: number;
  crewLinkRatePercent: number;
  positionsTotal: number;
  positionsOccupied: number;
  positionsEmpty: number;
  positionStaffingRatePercent: number;
}

export interface LinkCoverageRow extends LinkCoverageCounts {
  label: string;
}

export interface StripsOperationalStats {
  readinessByUnit: ReadinessBreakdownRow[];
  readinessByStrip: ReadinessBreakdownRow[];
  coverageByUnit: LinkCoverageRow[];
  coverageOverall: LinkCoverageCounts;
}

interface LabelValue {
  key: string;
  label: string;
}

interface LinkedCrewFact {
  key: string;
  unit: LabelValue;
  strip: LabelValue;
  readiness: CrewReadiness | "";
}

interface LooseCrewFact {
  key: string;
  unit: LabelValue;
}

interface PositionFact {
  unit: LabelValue;
  occupied: boolean;
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk-UA");
}

function labelValue(value: string, missingLabel: string): LabelValue {
  const label = value.trim().replace(/\s+/g, " ");
  return label
    ? { key: normalizedLabel(label), label }
    : { key: `missing:${normalizedLabel(missingLabel)}`, label: missingLabel };
}

function crewKey(crew: StripCrew): string {
  const name = normalizedLabel(crew.name);
  return name ? `name:${name}` : `id:${crew.id}`;
}

function positionKey(position: StripPosition, fallback: number): string {
  return position.id ? `id:${position.id}` : `missing:${fallback}`;
}

function emptyStatusCounts(): StatusCounts {
  return { ready: 0, notReady: 0, forming: 0, total: 0 };
}

function addReadiness(counts: StatusCounts, readiness: CrewReadiness | "") {
  if (!CREW_READINESS.includes(readiness as CrewReadiness)) return;
  counts.total += 1;
  if (readiness === "БГ") counts.ready += 1;
  else if (readiness === "Не БГ") counts.notReady += 1;
  else counts.forming += 1;
}

function percentage(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1_000) / 10 : 0;
}

function buildReadinessRows(
  facts: Iterable<LinkedCrewFact>,
  labels: LabelValue[],
  labelFor: (fact: LinkedCrewFact) => LabelValue,
): ReadinessBreakdownRow[] {
  const countsByLabel = new Map<string, StatusCounts>();
  for (const fact of facts) {
    const label = labelFor(fact);
    const counts = countsByLabel.get(label.key) ?? emptyStatusCounts();
    addReadiness(counts, fact.readiness);
    countsByLabel.set(label.key, counts);
  }

  return labels.flatMap(({ key, label }) => {
    const counts = countsByLabel.get(key);
    if (!counts || counts.total === 0) return [];
    return [{
      label,
      ...counts,
      readyRatePercent: percentage(counts.ready, counts.total),
    }];
  });
}

function emptyCoverage(): LinkCoverageCounts {
  return {
    crewsTotal: 0,
    crewsLinked: 0,
    crewsUnlinked: 0,
    crewLinkRatePercent: 0,
    positionsTotal: 0,
    positionsOccupied: 0,
    positionsEmpty: 0,
    positionStaffingRatePercent: 0,
  };
}

function finalizeCoverage(counts: LinkCoverageCounts): LinkCoverageCounts {
  return {
    ...counts,
    crewsTotal: counts.crewsLinked + counts.crewsUnlinked,
    crewLinkRatePercent: percentage(
      counts.crewsLinked,
      counts.crewsLinked + counts.crewsUnlinked,
    ),
    positionsTotal: counts.positionsOccupied + counts.positionsEmpty,
    positionStaffingRatePercent: percentage(
      counts.positionsOccupied,
      counts.positionsOccupied + counts.positionsEmpty,
    ),
  };
}

/**
 * Calculates operational statistics from the generated Strips report.
 *
 * Main readiness tables include only unique crews attached to a position.
 * Loose crews never increase those tables and are shown only in link coverage.
 * A linked occurrence wins over a loose duplicate so damaged legacy data cannot
 * count one crew in both categories.
 */
export function calculateStripsOperationalStats(strips: WorkStrip[]): StripsOperationalStats {
  const linkedCrews = new Map<string, LinkedCrewFact>();
  const looseCrews = new Map<string, LooseCrewFact>();
  const positions = new Map<string, PositionFact>();
  const units: LabelValue[] = [];
  const unitKeys = new Set<string>();
  const stripLabels: LabelValue[] = [];
  const stripKeys = new Set<string>();
  let positionFallback = 0;

  const rememberLabel = (ordered: LabelValue[], keys: Set<string>, value: LabelValue) => {
    if (keys.has(value.key)) return;
    keys.add(value.key);
    ordered.push(value);
  };

  for (const strip of strips) {
    const stripValue = labelValue(strip.name, "Смуга не вказана");
    rememberLabel(stripLabels, stripKeys, stripValue);

    for (const group of strip.groups) {
      const unit = labelValue(group.unit, "Підрозділ не вказано");
      rememberLabel(units, unitKeys, unit);

      for (const position of group.positions) {
        positionFallback += 1;
        const key = positionKey(position, positionFallback);
        if (!positions.has(key)) {
          positions.set(key, { unit, occupied: position.crews.length > 0 });
        }

        for (const crew of position.crews) {
          const key = crewKey(crew);
          if (!linkedCrews.has(key)) {
            linkedCrews.set(key, {
              key,
              unit,
              strip: stripValue,
              readiness: crew.readiness,
            });
          }
        }
      }

      for (const crew of group.looseCrews) {
        const key = crewKey(crew);
        if (!looseCrews.has(key)) looseCrews.set(key, { key, unit });
      }
    }
  }

  const coverageByUnit = new Map<string, LinkCoverageCounts>();
  const coverageFor = (unit: LabelValue) => {
    const existing = coverageByUnit.get(unit.key);
    if (existing) return existing;
    const created = emptyCoverage();
    coverageByUnit.set(unit.key, created);
    return created;
  };

  for (const fact of linkedCrews.values()) coverageFor(fact.unit).crewsLinked += 1;
  for (const fact of looseCrews.values()) {
    if (!linkedCrews.has(fact.key)) coverageFor(fact.unit).crewsUnlinked += 1;
  }
  for (const position of positions.values()) {
    const coverage = coverageFor(position.unit);
    if (position.occupied) coverage.positionsOccupied += 1;
    else coverage.positionsEmpty += 1;
  }

  const coverageRows = units.flatMap(({ key, label }) => {
    const counts = coverageByUnit.get(key);
    if (!counts) return [];
    const finalized = finalizeCoverage(counts);
    if (finalized.crewsTotal === 0 && finalized.positionsTotal === 0) return [];
    return [{ label, ...finalized }];
  });
  const coverageOverall = finalizeCoverage(coverageRows.reduce<LinkCoverageCounts>(
    (total, row) => ({
      ...total,
      crewsLinked: total.crewsLinked + row.crewsLinked,
      crewsUnlinked: total.crewsUnlinked + row.crewsUnlinked,
      positionsOccupied: total.positionsOccupied + row.positionsOccupied,
      positionsEmpty: total.positionsEmpty + row.positionsEmpty,
    }),
    emptyCoverage(),
  ));

  return {
    readinessByUnit: buildReadinessRows(linkedCrews.values(), units, (fact) => fact.unit),
    readinessByStrip: buildReadinessRows(linkedCrews.values(), stripLabels, (fact) => fact.strip),
    coverageByUnit: coverageRows,
    coverageOverall,
  };
}
