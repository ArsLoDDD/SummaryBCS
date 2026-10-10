export interface UnitPreview {
  id: string;
  path: string;
  fileName: string;
  unitName: string;
  date: string;
  rowCount: number;
  personnelCount: number;
  authorizedStrength: number;
}

export interface ImportPreview {
  date: string;
  totalRows: number;
  totalPersonnel: number;
  units: UnitPreview[];
}

export interface ExportRequest {
  paths: string[];
  unitOrder: string[];
  outputPath: string;
}

export interface ComparisonMetric {
  label: string;
  before: number;
  after: number;
  delta: number;
}

export interface ComparisonSection {
  title: string;
  rows: ComparisonMetric[];
}

export interface PersonnelChange {
  kind: "added" | "removed" | "changed";
  personName: string;
  details: string;
}

export interface ComparisonResult {
  scope: "unit" | "general";
  title: string;
  beforeDate: string;
  afterDate: string;
  beforeUnitCount: number;
  afterUnitCount: number;
  highlights: string[];
  headline: ComparisonMetric[];
  sections: ComparisonSection[];
  unitChanges: string[];
  personnelChanges: PersonnelChange[];
  hasChanges: boolean;
}

export function moveUnit<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
