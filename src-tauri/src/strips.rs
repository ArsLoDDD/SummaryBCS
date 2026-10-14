use crate::xlsx;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    path::PathBuf,
};
use zip::ZipArchive;

const SHEET_NAME: &str = "Позиції по смугах";
const UAV_TYPES: [&str; 7] = [
    "ФПВ",
    "ФПВ Перехоплювач",
    "Коптер",
    "Бомбер",
    "Літаковий Розвідувальний",
    "Літаковий Ударний",
    "НРК",
];
const CREW_READINESS: [&str; 3] = ["БГ", "Не БГ", "Формується"];
const POSITION_READINESS: [&str; 2] = ["БГ", "Не БГ"];
const CREW_DUTIES: [&str; 2] = ["БЧ", "Відпочинок після БЧ"];
const POSITION_WITHOUT_CREW_NOTE: &str = "Позиція готова до роботи, відсутній екіпаж";
const CREW_WITHOUT_POSITION_NOTE: &str = "Екіпаж готовий до виконання задач, відсутня позиція";
const DATA_HEADERS: [&str; 12] = [
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
];
const NOTE_METADATA_MARKER: &str = "__SUMMARYBCS_STRIPS_NOTES_V1__";
const NOTE_METADATA_COLUMNS: usize = 4;

const STYLE_TITLE: usize = 1;
const STYLE_SUBTITLE: usize = 2;
const STYLE_STRIP: usize = 3;
const STYLE_HEADER: usize = 4;
const STYLE_DATA_CENTER: usize = 5;
const STYLE_DATA_LEFT: usize = 6;
const STYLE_READY: usize = 7;
const STYLE_NOT_READY: usize = 8;
const STYLE_FORMING: usize = 9;
const STYLE_NEUTRAL: usize = 10;
const STYLE_NEUTRAL_LEFT: usize = 11;
const STYLE_SUMMARY_TITLE: usize = 12;
const STYLE_SUMMARY_SECTION: usize = 13;
const STYLE_SUMMARY_HEADER: usize = 14;
const STYLE_SUMMARY_LABEL: usize = 15;
const STYLE_SUMMARY_NUMBER: usize = 16;
const STYLE_SUMMARY_TOTAL_LABEL: usize = 17;
const STYLE_SUMMARY_TOTAL_NUMBER: usize = 18;
const STYLE_READY_LEFT: usize = 19;
const STYLE_NOT_READY_LEFT: usize = 20;
const STYLE_FORMING_LEFT: usize = 21;
const STYLE_SUMMARY_PERCENT: usize = 22;
const STYLE_SUMMARY_TOTAL_PERCENT: usize = 23;

const MAX_STRIPS: usize = 200;
const MAX_GROUPS: usize = 10_000;
const MAX_POSITIONS: usize = 10_000;
const MAX_CREWS: usize = 20_000;
const MAX_DATA_ROWS: usize = 25_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StripsExportRequest {
    version: u8,
    report_date: String,
    strips: Vec<WorkStrip>,
    output_path: String,
    #[serde(default)]
    separate_notes: bool,
    #[serde(default)]
    hide_unlinked_summary_caption: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedStripsRegistry {
    version: u8,
    report_date: String,
    crews: Vec<ImportedRegistryCrew>,
    positions: Vec<ImportedRegistryPosition>,
    assignments: Vec<ImportedRegistryAssignment>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ImportedRegistryCrew {
    id: String,
    name: String,
    unit: String,
    uav_type: String,
    readiness: String,
    not_ready_reason: String,
    duty: String,
    assets: String,
    note: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ImportedRegistryPosition {
    id: String,
    name: String,
    strip: String,
    unit: String,
    uav_type: String,
    readiness: String,
    not_ready_reason: String,
    bro: String,
    area: String,
    direction: String,
    note: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ImportedRegistryAssignment {
    id: String,
    crew_id: String,
    position_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkStrip {
    id: String,
    name: String,
    groups: Vec<StripGroup>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StripGroup {
    id: String,
    unit: String,
    uav_type: String,
    positions: Vec<StripPosition>,
    loose_crews: Vec<LooseStripCrew>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StripPosition {
    id: String,
    name: String,
    readiness: String,
    not_ready_reason: String,
    bro: String,
    area: String,
    direction: String,
    note: String,
    crews: Vec<StripCrew>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StripCrew {
    id: String,
    name: String,
    readiness: String,
    not_ready_reason: String,
    duty: String,
    assets: String,
    note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LooseStripCrew {
    id: String,
    name: String,
    readiness: String,
    not_ready_reason: String,
    duty: String,
    assets: String,
    note: String,
}

#[derive(Debug)]
struct PreparedReport {
    report_date: String,
    output_path: PathBuf,
    strips: Vec<PreparedStrip>,
    separate_notes: bool,
    hide_unlinked_summary_caption: bool,
}

#[derive(Debug)]
struct PreparedStrip {
    name: String,
    groups: Vec<PreparedGroup>,
}

#[derive(Debug)]
struct PreparedGroup {
    unit: String,
    uav_type: String,
    positions: Vec<PreparedPosition>,
    loose_crews: Vec<PreparedLooseCrew>,
}

#[derive(Debug)]
struct PreparedPosition {
    id: String,
    name: String,
    readiness: String,
    not_ready_reason: String,
    bro: String,
    area: String,
    direction: String,
    note: String,
    crews: Vec<PreparedCrew>,
}

#[derive(Debug)]
struct PreparedCrew {
    id: String,
    name: String,
    readiness: String,
    not_ready_reason: String,
    duty: String,
    assets: String,
    note: String,
}

#[derive(Debug)]
struct PreparedLooseCrew {
    crew: PreparedCrew,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct StatusCounts {
    ready: usize,
    not_ready: usize,
    forming: usize,
    total: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ExceptionCounts {
    crews_without_position: usize,
    positions_without_crews: usize,
}

impl ExceptionCounts {
    fn total(self) -> usize {
        self.crews_without_position + self.positions_without_crews
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StatusSummaryRow {
    uav_type: &'static str,
    counts: StatusCounts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExceptionSummaryRow {
    uav_type: &'static str,
    counts: ExceptionCounts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CountMatrixRow {
    label: String,
    values: Vec<usize>,
    total: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CountMatrix {
    columns: Vec<String>,
    rows: Vec<CountMatrixRow>,
    column_totals: Vec<usize>,
    total: usize,
}

#[derive(Debug)]
struct LinkedCrewFact {
    strip: String,
    unit: String,
    uav_type: &'static str,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct StripsSummary {
    crews: Vec<StatusSummaryRow>,
    positions: Vec<StatusSummaryRow>,
    crew_totals: StatusCounts,
    position_totals: StatusCounts,
    exceptions: Vec<ExceptionSummaryRow>,
    exception_totals: ExceptionCounts,
    crews_by_unit_and_strip: CountMatrix,
    crews_by_unit_and_uav_type: CountMatrix,
    crews_by_strip_and_uav_type: CountMatrix,
}

#[derive(Debug, Clone, PartialEq)]
struct ReadinessBreakdownRow {
    label: String,
    counts: StatusCounts,
    ready_rate_percent: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct LinkCoverageCounts {
    crews_total: usize,
    crews_linked: usize,
    crews_unlinked: usize,
    crew_link_rate_percent: f64,
    positions_total: usize,
    positions_occupied: usize,
    positions_empty: usize,
    position_staffing_rate_percent: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct LinkCoverageRow {
    label: String,
    counts: LinkCoverageCounts,
}

#[derive(Debug, Default, PartialEq)]
struct StripsOperationalStats {
    readiness_by_unit: Vec<ReadinessBreakdownRow>,
    readiness_by_strip: Vec<ReadinessBreakdownRow>,
    coverage_by_unit: Vec<LinkCoverageRow>,
    coverage_overall: LinkCoverageCounts,
}

#[derive(Debug, Clone)]
struct OperationalLabel {
    key: String,
    label: String,
}

#[derive(Debug)]
struct OperationalLinkedCrewFact {
    unit: OperationalLabel,
    strip: OperationalLabel,
    readiness: String,
}

#[derive(Debug)]
struct OperationalLooseCrewFact {
    unit: OperationalLabel,
}

#[derive(Debug)]
struct OperationalPositionFact {
    unit: OperationalLabel,
    occupied: bool,
}

pub fn import_strips_registry(path: String) -> Result<ImportedStripsRegistry, String> {
    let path = PathBuf::from(path);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("файл")
        .to_string();
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        return Err(format!("«{file_name}»: підтримуються лише файли .xlsx."));
    }
    let metadata = fs::metadata(&path).map_err(|_| format!("«{file_name}»: файл недоступний."))?;
    if !metadata.is_file() {
        return Err(format!("«{file_name}»: обраний шлях не є файлом."));
    }
    if metadata.len() > xlsx::MAX_ARCHIVE_BYTES {
        return Err(format!("«{file_name}»: файл перевищує 25 МБ."));
    }

    let file =
        File::open(&path).map_err(|_| format!("«{file_name}»: не вдалося відкрити файл."))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| format!("«{file_name}»: пошкоджений або невалідний XLSX."))?;
    xlsx::validate_archive(&mut archive).map_err(|message| format!("«{file_name}»: {message}"))?;
    let rows = xlsx::read_sheet(&mut archive, SHEET_NAME)
        .map_err(|message| format!("«{file_name}»: {message}"))?;
    parse_registry_sheet(&rows).map_err(|message| format!("«{file_name}»: {message}"))
}

fn sheet_value(row: &xlsx::SheetRow, column: usize) -> &str {
    sheet_raw_value(row, column).trim()
}

fn sheet_raw_value(row: &xlsx::SheetRow, column: usize) -> &str {
    row.cells
        .get(column)
        .map(|cell| cell.value.as_str())
        .unwrap_or("")
}

struct ImportedNoteMetadata {
    crew_note: String,
    position_note: String,
}

fn imported_note_metadata(row: &xlsx::SheetRow) -> Option<ImportedNoteMetadata> {
    let marker_column = row
        .cells
        .iter()
        .enumerate()
        .skip(DATA_HEADERS.len())
        .find_map(|(column, cell)| (cell.value == NOTE_METADATA_MARKER).then_some(column))?;
    let metadata = row
        .cells
        .get(marker_column..marker_column + NOTE_METADATA_COLUMNS)?;
    if metadata.iter().any(|cell| cell.has_formula) || metadata[3].value != sheet_raw_value(row, 11)
    {
        return None;
    }
    Some(ImportedNoteMetadata {
        crew_note: metadata[1].value.clone(),
        position_note: metadata[2].value.clone(),
    })
}

fn is_data_header(row: &xlsx::SheetRow) -> bool {
    DATA_HEADERS
        .iter()
        .enumerate()
        .all(|(column, expected)| normalize(sheet_value(row, column)) == normalize(expected))
}

fn is_strip_summary_header(row: &xlsx::SheetRow) -> bool {
    normalize(sheet_value(row, 0)) == normalize("Показник")
        && normalize(sheet_value(row, 1)) == normalize("Всього")
        && normalize(sheet_value(row, 2)) == normalize("БГ")
        && normalize(sheet_value(row, 3)) == normalize("Не БГ")
}

fn parse_exported_date(value: &str) -> Result<String, String> {
    for token in value.split_whitespace() {
        let token =
            token.trim_matches(|character: char| !character.is_ascii_digit() && character != '.');
        let parts = token.split('.').collect::<Vec<_>>();
        if parts.len() != 3 || parts[0].len() != 2 || parts[1].len() != 2 || parts[2].len() != 4 {
            continue;
        }
        let iso = format!("{}-{}-{}", parts[2], parts[1], parts[0]);
        if validate_iso_date(&iso).is_ok() {
            return Ok(iso);
        }
    }
    Err("не вдалося визначити дату звіту з другого рядка.".into())
}

fn parse_displayed_readiness(
    value: &str,
    allowed: &[&str],
    label: &str,
) -> Result<(String, String), String> {
    let value = value.trim();
    let (status_value, reason) = if value.ends_with(')') {
        value
            .find('(')
            .map(|opening| {
                (
                    value[..opening].trim(),
                    value[opening + 1..value.len() - 1].trim(),
                )
            })
            .unwrap_or((value, ""))
    } else {
        (value, "")
    };
    let status = canonical(status_value, allowed, label)?;
    if status == "Не БГ" {
        let reason = validate_text(reason, &format!("Причина «Не БГ»: {label}"), 500, true)?;
        Ok((status, reason))
    } else if reason.is_empty() {
        Ok((status, String::new()))
    } else {
        Err(format!(
            "{label}: причина в дужках дозволена лише для статусу «Не БГ»."
        ))
    }
}

fn split_first_row_note(value: &str, label: &str) -> Result<(String, String), String> {
    if value.chars().count() <= 1_000 {
        return Ok((String::new(), value.to_string()));
    }
    let mut candidates = value
        .char_indices()
        .filter(|(_, character)| *character == '\n')
        .filter_map(|(index, _)| {
            let crew = value[..index].trim_end();
            let position = value[index + 1..].trim_start();
            let crew_len = crew.chars().count();
            let position_len = position.chars().count();
            (crew_len <= 1_000 && position_len <= 1_000).then_some((
                crew_len.abs_diff(position_len),
                crew.to_string(),
                position.to_string(),
            ))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| candidate.0);
    candidates
        .into_iter()
        .next()
        .map(|(_, crew, position)| (crew, position))
        .ok_or_else(|| format!("{label}: примітка довша за допустиму та не може бути розділена."))
}

fn parse_imported_crew(
    row: &xlsx::SheetRow,
    unit: &str,
    uav_type: &str,
    note: &str,
    crew_number: usize,
) -> Result<ImportedRegistryCrew, String> {
    let label = format!("Рядок {}, екіпаж", row.number);
    let name = validate_text(
        sheet_value(row, 2),
        &format!("Назва екіпажу: {label}"),
        250,
        true,
    )?;
    let (readiness, not_ready_reason) = parse_displayed_readiness(
        sheet_value(row, 3),
        &CREW_READINESS,
        &format!("БГ екіпажу: {label}"),
    )?;
    let duty = if readiness == "Формується" {
        canonical(
            sheet_value(row, 4),
            &["Формується"],
            &format!("БЧ екіпажу: {label}"),
        )?
    } else {
        canonical(
            sheet_value(row, 4),
            &CREW_DUTIES,
            &format!("БЧ екіпажу: {label}"),
        )?
    };
    let assets = validate_text(
        sheet_value(row, 5),
        &format!("Засіб: {label}"),
        1_000,
        false,
    )?;
    let note = validate_text(note, &format!("Примітка екіпажу: {label}"), 1_000, false)?;
    Ok(ImportedRegistryCrew {
        id: format!("import-crew-{crew_number}"),
        name,
        unit: unit.to_string(),
        uav_type: uav_type.to_string(),
        readiness,
        not_ready_reason,
        duty,
        assets,
        note,
    })
}

fn parse_registry_sheet(rows: &[xlsx::SheetRow]) -> Result<ImportedStripsRegistry, String> {
    let title_row = rows
        .iter()
        .find(|row| row.number == 1)
        .ok_or_else(|| "відсутній заголовок звіту в першому рядку.".to_string())?;
    if title_row.cells.first().is_some_and(|cell| cell.has_formula) {
        return Err("заголовок звіту не може бути формулою.".into());
    }
    let title = sheet_value(title_row, 0);
    if normalize(title) != normalize("ЗВІТ ПО ПОЗИЦІЯХ ТА ЕКІПАЖАХ") {
        return Err("файл не є експортом «Позиції по смугах» цієї програми.".into());
    }
    let subtitle_row = rows
        .iter()
        .find(|row| row.number == 2)
        .ok_or_else(|| "відсутній рядок із датою звіту.".to_string())?;
    if subtitle_row
        .cells
        .first()
        .is_some_and(|cell| cell.has_formula)
    {
        return Err("дата звіту не може бути формулою.".into());
    }
    let subtitle = sheet_value(subtitle_row, 0);
    let report_date = parse_exported_date(subtitle)?;
    let header_indexes = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| is_data_header(row).then_some(index))
        .collect::<Vec<_>>();
    if header_indexes.is_empty() {
        return Err("не знайдено таблицю з очікуваними 12 колонками.".into());
    }
    if header_indexes.len() > MAX_STRIPS {
        return Err(format!("Файл містить більше {MAX_STRIPS} смуг."));
    }

    let mut crews = Vec::new();
    let mut positions = Vec::new();
    let mut assignments = Vec::new();
    let mut crew_names = HashSet::new();

    for (header_order, &header_index) in header_indexes.iter().enumerate() {
        let header = &rows[header_index];
        if header
            .cells
            .iter()
            .take(DATA_HEADERS.len())
            .any(|cell| cell.has_formula)
        {
            return Err(format!(
                "Рядок {}: заголовок таблиці не може містити формули.",
                header.number
            ));
        }
        let strip_name = rows
            .iter()
            .find(|row| row.number + 1 == header.number)
            .map(|row| sheet_value(row, 0))
            .unwrap_or("");
        let strip_name = validate_text(
            strip_name,
            &format!("Назва смуги перед рядком {}", header.number),
            200,
            true,
        )?;
        if normalize(&strip_name) == normalize("ЗАГАЛЬНИЙ ПІДСУМОК") {
            return Err(format!(
                "Рядок {}: некоректна назва смуги.",
                header.number - 1
            ));
        }
        let section_end = header_indexes
            .get(header_order + 1)
            .copied()
            .unwrap_or(rows.len());
        let summary_index = ((header_index + 1)..section_end)
            .find(|index| is_strip_summary_header(&rows[*index]))
            .ok_or_else(|| format!("Смуга «{strip_name}»: не знайдено підсумок після таблиці."))?;
        if summary_index == header_index + 1 {
            return Err(format!("Смуга «{strip_name}»: таблиця не містить записів."));
        }

        let mut current_unit = String::new();
        let mut current_uav_type = String::new();
        let mut current_position_id: Option<String> = None;

        for row in &rows[header_index + 1..summary_index] {
            if row.cells.iter().all(|cell| cell.value.trim().is_empty()) {
                continue;
            }
            if row
                .cells
                .iter()
                .take(DATA_HEADERS.len())
                .any(|cell| cell.has_formula)
            {
                return Err(format!(
                    "Рядок {}: формули в даних не підтримуються.",
                    row.number
                ));
            }
            let note_metadata = imported_note_metadata(row);
            let visible_note = sheet_raw_value(row, 11);

            let row_unit = sheet_value(row, 0);
            if !row_unit.is_empty() {
                current_unit = validate_text(
                    row_unit,
                    &format!("Підрозділ: рядок {}", row.number),
                    250,
                    true,
                )?;
                current_position_id = None;
            }
            let row_uav_type = sheet_value(row, 1);
            if !row_uav_type.is_empty() {
                current_uav_type = canonical(
                    row_uav_type,
                    &UAV_TYPES,
                    &format!("Тип БпЛА: рядок {}", row.number),
                )?;
            }
            if current_unit.is_empty() || current_uav_type.is_empty() {
                return Err(format!(
                    "Рядок {}: не вдалося визначити підрозділ або тип БпЛА з об’єднаних клітинок.",
                    row.number
                ));
            }

            let position_name = sheet_value(row, 6);
            let loose_marker = normalize(position_name) == normalize("Екіпаж без позиції")
                && (7..=10).all(|column| sheet_value(row, column).is_empty());
            if loose_marker {
                current_position_id = None;
                let crew_note = note_metadata
                    .as_ref()
                    .filter(|metadata| metadata.position_note.is_empty())
                    .map(|metadata| metadata.crew_note.as_str())
                    .unwrap_or(visible_note);
                let crew = parse_imported_crew(
                    row,
                    &current_unit,
                    &current_uav_type,
                    crew_note,
                    crews.len() + 1,
                )?;
                if !crew_names.insert(normalize(&crew.name)) {
                    return Err(format!(
                        "Рядок {}: екіпаж «{}» уже був імпортований. Назва екіпажу має бути унікальною.",
                        row.number, crew.name
                    ));
                }
                crews.push(crew);
                continue;
            }

            let empty_position = normalize(sheet_value(row, 2)) == normalize("Позиція без екіпажу")
                && (3..=5).all(|column| sheet_value(row, column).is_empty());
            let mut first_crew_note = String::new();
            if !position_name.is_empty() {
                let label = format!("Рядок {}, позиція", row.number);
                let (readiness, not_ready_reason) = parse_displayed_readiness(
                    sheet_value(row, 7),
                    &POSITION_READINESS,
                    &format!("БГ позиції: {label}"),
                )?;
                let (crew_note, position_note) = if let Some(metadata) = note_metadata.as_ref() {
                    (
                        validate_text(
                            &metadata.crew_note,
                            &format!("Примітка екіпажу: {label}"),
                            1_000,
                            false,
                        )?,
                        validate_text(
                            &metadata.position_note,
                            &format!("Примітка позиції: {label}"),
                            1_000,
                            false,
                        )?,
                    )
                } else if empty_position {
                    (
                        String::new(),
                        validate_text(
                            visible_note,
                            &format!("Примітка позиції: {label}"),
                            1_000,
                            false,
                        )?,
                    )
                } else {
                    split_first_row_note(visible_note, &label)?
                };
                first_crew_note = crew_note;
                let position = ImportedRegistryPosition {
                    id: format!("import-position-{}", positions.len() + 1),
                    name: validate_text(
                        position_name,
                        &format!("Назва позиції: {label}"),
                        250,
                        true,
                    )?,
                    strip: strip_name.clone(),
                    unit: current_unit.clone(),
                    uav_type: current_uav_type.clone(),
                    readiness,
                    not_ready_reason,
                    bro: validate_text(sheet_value(row, 8), &format!("БРО: {label}"), 250, true)?,
                    area: validate_text(
                        sheet_value(row, 9),
                        &format!("Район: {label}"),
                        250,
                        true,
                    )?
                    .to_uppercase(),
                    direction: validate_text(
                        sheet_value(row, 10),
                        &format!("Напрямок роботи: {label}"),
                        500,
                        true,
                    )?,
                    note: position_note,
                };
                current_position_id = Some(position.id.clone());
                positions.push(position);
            } else if current_position_id.is_none() {
                return Err(format!(
                    "Рядок {}: екіпаж не має ані позиції, ані позначки «Екіпаж без позиції».",
                    row.number
                ));
            }

            if empty_position {
                continue;
            }
            let position_id = current_position_id.clone().ok_or_else(|| {
                format!(
                    "Рядок {}: не вдалося визначити позицію екіпажу.",
                    row.number
                )
            })?;
            let note = if position_name.is_empty() {
                note_metadata
                    .as_ref()
                    .filter(|metadata| metadata.position_note.is_empty())
                    .map(|metadata| metadata.crew_note.as_str())
                    .unwrap_or(visible_note)
            } else {
                &first_crew_note
            };
            let crew =
                parse_imported_crew(row, &current_unit, &current_uav_type, note, crews.len() + 1)?;
            let position = positions
                .iter()
                .find(|position| position.id == position_id)
                .ok_or_else(|| format!("Рядок {}: позицію екіпажу не знайдено.", row.number))?;
            if crew.readiness == "Формується" {
                return Err(format!(
                    "Рядок {}: екіпаж зі статусом «Формується» не може мати позицію.",
                    row.number
                ));
            }
            if crew.readiness != position.readiness {
                return Err(format!(
                    "Рядок {}: статус екіпажу має збігатися зі статусом позиції.",
                    row.number
                ));
            }
            if !crew_names.insert(normalize(&crew.name)) {
                return Err(format!(
                    "Рядок {}: екіпаж «{}» уже був імпортований. Назва екіпажу має бути унікальною.",
                    row.number, crew.name
                ));
            }
            let crew_id = crew.id.clone();
            crews.push(crew);
            assignments.push(ImportedRegistryAssignment {
                id: format!("import-assignment-{}", assignments.len() + 1),
                crew_id,
                position_id,
            });
        }
    }

    if crews.len() > MAX_CREWS || positions.len() > MAX_POSITIONS {
        return Err(format!(
            "Файл містить забагато записів (максимум {MAX_CREWS} екіпажів і {MAX_POSITIONS} позицій)."
        ));
    }
    if crews.is_empty() && positions.is_empty() {
        return Err("у таблиці не знайдено екіпажів або позицій.".into());
    }

    Ok(ImportedStripsRegistry {
        version: 2,
        report_date,
        crews,
        positions,
        assignments,
    })
}

pub fn export_strips(request: StripsExportRequest) -> Result<String, String> {
    let prepared = prepare_request(request)?;
    let summary = calculate_summary(&prepared.strips);
    let sheet = build_sheet(&prepared, &summary);
    xlsx::write_styled_workbook(
        &prepared.output_path,
        SHEET_NAME,
        &sheet,
        &strips_styles(),
        include_str!("../resources/bcs-reference-theme.xml"),
    )?;
    Ok(prepared.output_path.to_string_lossy().into_owned())
}

fn prepare_request(request: StripsExportRequest) -> Result<PreparedReport, String> {
    if request.version != 1 {
        return Err("Версія звіту смуг не підтримується.".into());
    }
    let report_date = validate_iso_date(&request.report_date)?;
    if request.strips.is_empty() {
        return Err("Додайте хоча б одну смугу.".into());
    }
    if request.strips.len() > MAX_STRIPS {
        return Err(format!("У звіті може бути не більше {MAX_STRIPS} смуг."));
    }

    let output_value = validate_text(&request.output_path, "Шлях збереження", 4_096, true)?;
    let output_path = PathBuf::from(output_value);
    if output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        return Err("Файл звіту повинен мати розширення .xlsx.".into());
    }

    let mut identifiers = HashSet::new();
    let mut crew_names = HashMap::new();
    let mut group_count = 0usize;
    let mut position_count = 0usize;
    let mut crew_count = 0usize;
    let mut data_row_count = 0usize;
    let mut strips = Vec::with_capacity(request.strips.len());

    for (strip_index, strip) in request.strips.into_iter().enumerate() {
        let label = format!("Смуга {}", strip_index + 1);
        register_id(&mut identifiers, &strip.id, &format!("ID: {label}"))?;
        let name = validate_text(&strip.name, &format!("Назва: {label}"), 200, true)?;
        if strip.groups.is_empty() {
            return Err(format!("У смузі «{name}» додайте хоча б одну групу."));
        }

        group_count = group_count
            .checked_add(strip.groups.len())
            .ok_or_else(|| "Кількість груп завелика.".to_string())?;
        let mut groups = Vec::with_capacity(strip.groups.len());
        let mut seen_type_runs = HashSet::new();
        let mut units_by_type = HashSet::new();
        let mut previous_uav_type = String::new();
        for (group_index, group) in strip.groups.into_iter().enumerate() {
            let group_label = format!("{name}, група {}", group_index + 1);
            register_id(&mut identifiers, &group.id, &format!("ID: {group_label}"))?;
            if group.positions.is_empty() && group.loose_crews.is_empty() {
                return Err(format!(
                    "У групі «{group_label}» додайте позицію або екіпаж без позиції."
                ));
            }
            let unit = validate_text(&group.unit, &format!("Підрозділ: {group_label}"), 250, true)?;
            let uav_type = canonical(
                &group.uav_type,
                &UAV_TYPES,
                &format!("Тип БпЛА: {group_label}"),
            )?;
            let type_key = normalize(&uav_type);
            if type_key != previous_uav_type {
                if !seen_type_runs.insert(type_key.clone()) {
                    return Err(format!(
                        "{group_label}: тип БпЛА «{uav_type}» уже доданий у цій смузі. Додавайте підрозділи до спільного блоку типу."
                    ));
                }
                previous_uav_type = type_key.clone();
            }
            let unit_key = format!("{type_key}\0{}", normalize(&unit));
            if !units_by_type.insert(unit_key) {
                return Err(format!(
                    "{group_label}: підрозділ «{unit}» уже доданий до типу «{uav_type}»."
                ));
            }

            position_count = position_count
                .checked_add(group.positions.len())
                .ok_or_else(|| "Кількість позицій завелика.".to_string())?;
            crew_count = crew_count
                .checked_add(group.loose_crews.len())
                .ok_or_else(|| "Кількість екіпажів завелика.".to_string())?;

            let mut positions = Vec::with_capacity(group.positions.len());
            for (position_index, position) in group.positions.into_iter().enumerate() {
                let position_label = format!("{group_label}, позиція {}", position_index + 1);
                register_id(
                    &mut identifiers,
                    &position.id,
                    &format!("ID: {position_label}"),
                )?;
                if position.crews.len() > 2_000 {
                    return Err(format!(
                        "У позиції «{}» може бути не більше 2 000 екіпажів.",
                        position.name.trim()
                    ));
                }
                crew_count = crew_count
                    .checked_add(position.crews.len())
                    .ok_or_else(|| "Кількість екіпажів завелика.".to_string())?;
                data_row_count = data_row_count
                    .checked_add(position.crews.len().max(1))
                    .ok_or_else(|| "Кількість рядків завелика.".to_string())?;

                let position_name = validate_text(
                    &position.name,
                    &format!("Назва: {position_label}"),
                    250,
                    true,
                )?;
                let readiness = canonical(
                    &position.readiness,
                    &POSITION_READINESS,
                    &format!("БГ позиції: {position_label}"),
                )?;
                let not_ready_reason =
                    validate_reason(&readiness, &position.not_ready_reason, &position_label)?;
                let bro =
                    validate_text(&position.bro, &format!("БРО: {position_label}"), 250, true)?;
                let area = validate_text(
                    &position.area,
                    &format!("Район: {position_label}"),
                    250,
                    true,
                )?
                .to_uppercase();
                let direction = validate_text(
                    &position.direction,
                    &format!("Напрямок роботи: {position_label}"),
                    500,
                    true,
                )?;
                let note = validate_text(
                    &position.note,
                    &format!("Примітка позиції: {position_label}"),
                    1_000,
                    false,
                )?;

                let mut crews = Vec::with_capacity(position.crews.len());
                for (crew_index, crew) in position.crews.into_iter().enumerate() {
                    let crew_label = format!("{position_label}, екіпаж {}", crew_index + 1);
                    register_id(&mut identifiers, &crew.id, &format!("ID: {crew_label}"))?;
                    let crew = prepare_crew(crew, &crew_label)?;
                    register_crew_name(&mut crew_names, &crew.name, &crew_label)?;
                    if crew.readiness == "Формується" {
                        return Err(format!(
                            "{crew_label}: екіпаж, що формується, не може бути закріплений за позицією."
                        ));
                    }
                    if crew.readiness != readiness {
                        return Err(format!(
                            "{crew_label}: статус екіпажу має збігатися зі статусом позиції."
                        ));
                    }
                    crews.push(crew);
                }

                let note = sync_system_note(
                    &note,
                    POSITION_WITHOUT_CREW_NOTE,
                    readiness == "БГ" && crews.is_empty(),
                );
                let note = validate_text(
                    &note,
                    &format!("Примітка позиції: {position_label}"),
                    1_000,
                    false,
                )?;

                positions.push(PreparedPosition {
                    id: position.id.trim().to_string(),
                    name: position_name,
                    readiness,
                    not_ready_reason,
                    bro,
                    area,
                    direction,
                    note,
                    crews,
                });
            }

            data_row_count = data_row_count
                .checked_add(group.loose_crews.len())
                .ok_or_else(|| "Кількість рядків завелика.".to_string())?;
            let mut loose_crews = Vec::with_capacity(group.loose_crews.len());
            for (crew_index, crew) in group.loose_crews.into_iter().enumerate() {
                let crew_label = format!("{group_label}, екіпаж без позиції {}", crew_index + 1);
                register_id(&mut identifiers, &crew.id, &format!("ID: {crew_label}"))?;
                let mut crew = prepare_crew(
                    StripCrew {
                        id: crew.id,
                        name: crew.name,
                        readiness: crew.readiness,
                        not_ready_reason: crew.not_ready_reason,
                        duty: crew.duty,
                        assets: crew.assets,
                        note: crew.note,
                    },
                    &crew_label,
                )?;
                register_crew_name(&mut crew_names, &crew.name, &crew_label)?;
                crew.note = sync_system_note(
                    &crew.note,
                    CREW_WITHOUT_POSITION_NOTE,
                    crew.readiness == "БГ",
                );
                crew.note = validate_text(
                    &crew.note,
                    &format!("Примітка екіпажу: {crew_label}"),
                    1_000,
                    false,
                )?;
                loose_crews.push(PreparedLooseCrew { crew });
            }

            groups.push(PreparedGroup {
                unit,
                uav_type,
                positions,
                loose_crews,
            });
        }

        strips.push(PreparedStrip { name, groups });
    }

    if group_count > MAX_GROUPS {
        return Err(format!("У звіті може бути не більше {MAX_GROUPS} груп."));
    }
    if position_count > MAX_POSITIONS {
        return Err(format!(
            "У звіті може бути не більше {MAX_POSITIONS} позицій."
        ));
    }
    if crew_count > MAX_CREWS {
        return Err(format!("У звіті може бути не більше {MAX_CREWS} екіпажів."));
    }
    if data_row_count > MAX_DATA_ROWS {
        return Err(format!(
            "У звіті може бути не більше {MAX_DATA_ROWS} рядків даних."
        ));
    }

    Ok(PreparedReport {
        report_date,
        output_path,
        strips,
        separate_notes: request.separate_notes,
        hide_unlinked_summary_caption: request.hide_unlinked_summary_caption,
    })
}

fn prepare_crew(crew: StripCrew, label: &str) -> Result<PreparedCrew, String> {
    let name = validate_text(&crew.name, &format!("Назва екіпажу: {label}"), 250, true)?;
    let readiness = canonical(
        &crew.readiness,
        &CREW_READINESS,
        &format!("БГ екіпажу: {label}"),
    )?;
    let not_ready_reason = validate_reason(&readiness, &crew.not_ready_reason, label)?;
    let duty = if readiness == "Формується" {
        let raw = validate_text(&crew.duty, &format!("БЧ екіпажу: {label}"), 50, true)?;
        if normalize(&raw) != normalize("Формується") {
            return Err(format!(
                "{label}: для екіпажу зі статусом «Формується» значення БЧ також повинно бути «Формується»."
            ));
        }
        "Формується".to_string()
    } else {
        canonical(&crew.duty, &CREW_DUTIES, &format!("БЧ екіпажу: {label}"))?
    };
    let assets = validate_text(&crew.assets, &format!("Засіб: {label}"), 1_000, false)?;
    let note = validate_text(
        &crew.note,
        &format!("Примітка екіпажу: {label}"),
        1_000,
        false,
    )?;
    Ok(PreparedCrew {
        id: crew.id.trim().to_string(),
        name,
        readiness,
        not_ready_reason,
        duty,
        assets,
        note,
    })
}

fn validate_reason(status: &str, reason: &str, label: &str) -> Result<String, String> {
    if status == "Не БГ" {
        validate_text(reason, &format!("Причина «Не БГ»: {label}"), 500, true)
    } else {
        Ok(String::new())
    }
}

fn register_id(ids: &mut HashSet<String>, value: &str, label: &str) -> Result<(), String> {
    let id = validate_text(value, label, 100, true)?;
    if !ids.insert(id.clone()) {
        return Err(format!("ID «{id}» повторюється у звіті."));
    }
    Ok(())
}

fn register_crew_name(
    names: &mut HashMap<String, String>,
    value: &str,
    label: &str,
) -> Result<(), String> {
    let key = normalize(value);
    if let Some(previous) = names.get(&key) {
        return Err(format!(
            "{label}: назва екіпажу «{value}» уже використана в «{previous}». Екіпаж може бути лише в одному місці."
        ));
    }
    names.insert(key, label.to_string());
    Ok(())
}

fn sync_system_note(note: &str, system_note: &str, required: bool) -> String {
    let user_note = note
        .lines()
        .filter(|line| line.trim() != system_note)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if !required {
        return user_note;
    }
    if user_note.is_empty() {
        system_note.to_string()
    } else {
        format!("{system_note}\n{user_note}")
    }
}

fn validate_text(
    value: &str,
    label: &str,
    max_chars: usize,
    required: bool,
) -> Result<String, String> {
    let value = value.trim();
    if required && value.is_empty() {
        return Err(format!("Поле «{label}» обов’язкове."));
    }
    if value.chars().count() > max_chars {
        return Err(format!(
            "Поле «{label}» задовге (максимум {max_chars} символів)."
        ));
    }
    if value
        .chars()
        .any(|character| character < '\u{20}' && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(format!("Поле «{label}» містить недопустимий символ."));
    }
    Ok(value.to_string())
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn canonical(value: &str, allowed: &[&str], label: &str) -> Result<String, String> {
    let normalized = normalize(value);
    allowed
        .iter()
        .find(|candidate| normalize(candidate) == normalized)
        .map(|value| (*value).to_string())
        .ok_or_else(|| {
            format!("Невідоме значення «{value}» у полі «{label}». Оберіть значення зі списку.")
        })
}

fn validate_iso_date(value: &str) -> Result<String, String> {
    let value = value.trim();
    let parts = value.split('-').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return Err("Дата звіту має бути у форматі РРРР-ММ-ДД.".into());
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        parts[0].parse::<u16>(),
        parts[1].parse::<u8>(),
        parts[2].parse::<u8>(),
    ) else {
        return Err("Дата звіту має бути у форматі РРРР-ММ-ДД.".into());
    };
    if !(2000..=2200).contains(&year) || !(1..=12).contains(&month) {
        return Err("Дата звіту некоректна.".into());
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > max_day {
        return Err("Дата звіту некоректна.".into());
    }
    Ok(format!("{day:02}.{month:02}.{year:04}"))
}

fn calculate_summary(strips: &[PreparedStrip]) -> StripsSummary {
    let mut crew_counts = [StatusCounts::default(); UAV_TYPES.len()];
    let mut position_counts = [StatusCounts::default(); UAV_TYPES.len()];
    let mut exception_counts = [ExceptionCounts::default(); UAV_TYPES.len()];
    let mut seen_crew_names = HashSet::new();
    let mut linked_crew_facts = Vec::new();

    for strip in strips {
        for group in &strip.groups {
            let type_index = uav_index(&group.uav_type);
            for position in &group.positions {
                if position.crews.is_empty() {
                    exception_counts[type_index].positions_without_crews += 1;
                    continue;
                }
                add_status(&mut position_counts[type_index], &position.readiness);
                for crew in &position.crews {
                    if seen_crew_names.insert(normalize(&crew.name)) {
                        add_status(&mut crew_counts[type_index], &crew.readiness);
                        linked_crew_facts.push(LinkedCrewFact {
                            strip: strip.name.clone(),
                            unit: group.unit.clone(),
                            uav_type: UAV_TYPES[type_index],
                        });
                    }
                }
            }
            for crew in &group.loose_crews {
                if seen_crew_names.insert(normalize(&crew.crew.name)) {
                    exception_counts[type_index].crews_without_position += 1;
                }
            }
        }
    }

    let crews = UAV_TYPES
        .iter()
        .enumerate()
        .filter(|(index, _)| crew_counts[*index].total > 0)
        .map(|(index, uav_type)| StatusSummaryRow {
            uav_type,
            counts: crew_counts[index],
        })
        .collect::<Vec<_>>();
    let positions = UAV_TYPES
        .iter()
        .enumerate()
        .filter(|(index, _)| position_counts[*index].total > 0)
        .map(|(index, uav_type)| StatusSummaryRow {
            uav_type,
            counts: position_counts[index],
        })
        .collect::<Vec<_>>();
    let exceptions = UAV_TYPES
        .iter()
        .enumerate()
        .filter(|(index, _)| exception_counts[*index].total() > 0)
        .map(|(index, uav_type)| ExceptionSummaryRow {
            uav_type,
            counts: exception_counts[index],
        })
        .collect::<Vec<_>>();

    let units = linked_crew_facts
        .iter()
        .map(|fact| fact.unit.clone())
        .collect::<Vec<_>>();
    let strip_names = strips
        .iter()
        .filter(|strip| {
            linked_crew_facts
                .iter()
                .any(|fact| normalize(&fact.strip) == normalize(&strip.name))
        })
        .map(|strip| strip.name.clone())
        .collect::<Vec<_>>();
    let uav_types = UAV_TYPES
        .iter()
        .filter(|uav_type| {
            linked_crew_facts
                .iter()
                .any(|fact| fact.uav_type == **uav_type)
        })
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();

    StripsSummary {
        crew_totals: sum_statuses(&crew_counts),
        position_totals: sum_statuses(&position_counts),
        exception_totals: exception_counts.iter().fold(
            ExceptionCounts::default(),
            |mut total, counts| {
                total.crews_without_position += counts.crews_without_position;
                total.positions_without_crews += counts.positions_without_crews;
                total
            },
        ),
        crews,
        positions,
        exceptions,
        crews_by_unit_and_strip: build_count_matrix(
            &linked_crew_facts,
            units.clone(),
            strip_names.clone(),
            |fact| &fact.unit,
            |fact| &fact.strip,
        ),
        crews_by_unit_and_uav_type: build_count_matrix(
            &linked_crew_facts,
            units,
            uav_types.clone(),
            |fact| &fact.unit,
            |fact| fact.uav_type,
        ),
        crews_by_strip_and_uav_type: build_count_matrix(
            &linked_crew_facts,
            strip_names,
            uav_types,
            |fact| &fact.strip,
            |fact| fact.uav_type,
        ),
    }
}

fn ordered_labels(values: Vec<String>) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| {
            let key = normalize(&value);
            if key.is_empty() || !seen.insert(key.clone()) {
                None
            } else {
                Some((key, value.trim().to_string()))
            }
        })
        .collect()
}

fn build_count_matrix<RowValue, ColumnValue>(
    facts: &[LinkedCrewFact],
    row_values: Vec<String>,
    column_values: Vec<String>,
    row_value: RowValue,
    column_value: ColumnValue,
) -> CountMatrix
where
    RowValue: Fn(&LinkedCrewFact) -> &str,
    ColumnValue: Fn(&LinkedCrewFact) -> &str,
{
    let rows = ordered_labels(row_values);
    let columns = ordered_labels(column_values);
    let mut counts: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for fact in facts {
        let row_key = normalize(row_value(fact));
        let column_key = normalize(column_value(fact));
        *counts
            .entry(row_key)
            .or_default()
            .entry(column_key)
            .or_default() += 1;
    }

    let mut matrix_rows = rows
        .into_iter()
        .filter_map(|(key, label)| {
            let values = columns
                .iter()
                .map(|(column_key, _)| {
                    counts
                        .get(&key)
                        .and_then(|row| row.get(column_key))
                        .copied()
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>();
            let total = values.iter().sum();
            (total > 0).then_some(CountMatrixRow {
                label,
                values,
                total,
            })
        })
        .collect::<Vec<_>>();
    let column_totals = (0..columns.len())
        .map(|column| matrix_rows.iter().map(|row| row.values[column]).sum())
        .collect::<Vec<usize>>();
    let included_columns = column_totals
        .iter()
        .enumerate()
        .filter_map(|(index, total)| (*total > 0).then_some(index))
        .collect::<Vec<_>>();
    for row in &mut matrix_rows {
        row.values = included_columns
            .iter()
            .map(|index| row.values[*index])
            .collect();
    }
    let total = matrix_rows.iter().map(|row| row.total).sum();

    CountMatrix {
        columns: included_columns
            .iter()
            .map(|index| columns[*index].1.clone())
            .collect(),
        rows: matrix_rows,
        column_totals: included_columns
            .iter()
            .map(|index| column_totals[*index])
            .collect(),
        total,
    }
}

fn uav_index(value: &str) -> usize {
    UAV_TYPES
        .iter()
        .position(|candidate| *candidate == value)
        .expect("validated UAV type")
}

fn add_status(counts: &mut StatusCounts, status: &str) {
    counts.total += 1;
    match status {
        "БГ" => counts.ready += 1,
        "Не БГ" => counts.not_ready += 1,
        "Формується" => counts.forming += 1,
        _ => unreachable!("validated readiness status"),
    }
}

fn sum_statuses(values: &[StatusCounts]) -> StatusCounts {
    values
        .iter()
        .fold(StatusCounts::default(), |mut total, counts| {
            total.ready += counts.ready;
            total.not_ready += counts.not_ready;
            total.forming += counts.forming;
            total.total += counts.total;
            total
        })
}

fn operational_label(value: &str, missing_label: &str) -> OperationalLabel {
    let label = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() {
        OperationalLabel {
            key: format!("missing:{}", normalize(missing_label)),
            label: missing_label.to_string(),
        }
    } else {
        OperationalLabel {
            key: normalize(&label),
            label,
        }
    }
}

fn remember_operational_label(
    labels: &mut Vec<OperationalLabel>,
    keys: &mut HashSet<String>,
    value: &OperationalLabel,
) {
    if keys.insert(value.key.clone()) {
        labels.push(value.clone());
    }
}

fn operational_crew_key(crew: &PreparedCrew) -> String {
    let name = normalize(&crew.name);
    if name.is_empty() {
        format!("id:{}", crew.id)
    } else {
        format!("name:{name}")
    }
}

fn percentage(part: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        ((part as f64 / total as f64) * 1_000.0).round() / 10.0
    }
}

fn add_operational_readiness(counts: &mut StatusCounts, readiness: &str) {
    match readiness {
        "БГ" => {
            counts.ready += 1;
            counts.total += 1;
        }
        "Не БГ" => {
            counts.not_ready += 1;
            counts.total += 1;
        }
        "Формується" => {
            counts.forming += 1;
            counts.total += 1;
        }
        _ => {}
    }
}

fn build_operational_readiness_rows(
    facts: &HashMap<String, OperationalLinkedCrewFact>,
    labels: &[OperationalLabel],
    by_strip: bool,
) -> Vec<ReadinessBreakdownRow> {
    let mut counts_by_label: HashMap<String, StatusCounts> = HashMap::new();
    for fact in facts.values() {
        let label = if by_strip { &fact.strip } else { &fact.unit };
        add_operational_readiness(
            counts_by_label.entry(label.key.clone()).or_default(),
            &fact.readiness,
        );
    }

    labels
        .iter()
        .filter_map(|label| {
            let counts = counts_by_label.get(&label.key).copied()?;
            (counts.total > 0).then(|| ReadinessBreakdownRow {
                label: label.label.clone(),
                counts,
                ready_rate_percent: percentage(counts.ready, counts.total),
            })
        })
        .collect()
}

fn finalize_coverage(mut counts: LinkCoverageCounts) -> LinkCoverageCounts {
    counts.crews_total = counts.crews_linked + counts.crews_unlinked;
    counts.crew_link_rate_percent = percentage(counts.crews_linked, counts.crews_total);
    counts.positions_total = counts.positions_occupied + counts.positions_empty;
    counts.position_staffing_rate_percent =
        percentage(counts.positions_occupied, counts.positions_total);
    counts
}

fn calculate_operational_stats(strips: &[PreparedStrip]) -> StripsOperationalStats {
    let mut linked_crews: HashMap<String, OperationalLinkedCrewFact> = HashMap::new();
    let mut loose_crews: HashMap<String, OperationalLooseCrewFact> = HashMap::new();
    let mut positions: HashMap<String, OperationalPositionFact> = HashMap::new();
    let mut units = Vec::new();
    let mut unit_keys = HashSet::new();
    let mut strip_labels = Vec::new();
    let mut strip_keys = HashSet::new();
    let mut position_fallback = 0usize;

    for strip in strips {
        let strip_value = operational_label(&strip.name, "Смуга не вказана");
        remember_operational_label(&mut strip_labels, &mut strip_keys, &strip_value);

        for group in &strip.groups {
            let unit = operational_label(&group.unit, "Підрозділ не вказано");
            remember_operational_label(&mut units, &mut unit_keys, &unit);

            for position in &group.positions {
                position_fallback += 1;
                let position_key = if position.id.is_empty() {
                    format!("missing:{position_fallback}")
                } else {
                    format!("id:{}", position.id)
                };
                positions
                    .entry(position_key)
                    .or_insert_with(|| OperationalPositionFact {
                        unit: unit.clone(),
                        occupied: !position.crews.is_empty(),
                    });

                for crew in &position.crews {
                    linked_crews
                        .entry(operational_crew_key(crew))
                        .or_insert_with(|| OperationalLinkedCrewFact {
                            unit: unit.clone(),
                            strip: strip_value.clone(),
                            readiness: crew.readiness.clone(),
                        });
                }
            }

            for loose_crew in &group.loose_crews {
                loose_crews
                    .entry(operational_crew_key(&loose_crew.crew))
                    .or_insert_with(|| OperationalLooseCrewFact { unit: unit.clone() });
            }
        }
    }

    let mut coverage_by_unit: HashMap<String, LinkCoverageCounts> = HashMap::new();
    for fact in linked_crews.values() {
        coverage_by_unit
            .entry(fact.unit.key.clone())
            .or_default()
            .crews_linked += 1;
    }
    for (key, fact) in &loose_crews {
        if !linked_crews.contains_key(key) {
            coverage_by_unit
                .entry(fact.unit.key.clone())
                .or_default()
                .crews_unlinked += 1;
        }
    }
    for fact in positions.values() {
        let coverage = coverage_by_unit.entry(fact.unit.key.clone()).or_default();
        if fact.occupied {
            coverage.positions_occupied += 1;
        } else {
            coverage.positions_empty += 1;
        }
    }

    let coverage_by_unit = units
        .iter()
        .filter_map(|unit| {
            let counts = finalize_coverage(*coverage_by_unit.get(&unit.key)?);
            (counts.crews_total > 0 || counts.positions_total > 0).then(|| LinkCoverageRow {
                label: unit.label.clone(),
                counts,
            })
        })
        .collect::<Vec<_>>();
    let coverage_overall = finalize_coverage(coverage_by_unit.iter().fold(
        LinkCoverageCounts::default(),
        |mut total, row| {
            total.crews_linked += row.counts.crews_linked;
            total.crews_unlinked += row.counts.crews_unlinked;
            total.positions_occupied += row.counts.positions_occupied;
            total.positions_empty += row.counts.positions_empty;
            total
        },
    ));

    StripsOperationalStats {
        readiness_by_unit: build_operational_readiness_rows(&linked_crews, &units, false),
        readiness_by_strip: build_operational_readiness_rows(&linked_crews, &strip_labels, true),
        coverage_by_unit,
        coverage_overall,
    }
}

fn build_sheet(report: &PreparedReport, summary: &StripsSummary) -> String {
    let mut rows = String::new();
    let mut merges = Vec::new();
    let mut row = 1usize;
    let operational_stats = calculate_operational_stats(&report.strips);
    let visible_column_count = [
        12,
        summary.crews_by_unit_and_strip.columns.len() + 2,
        summary.crews_by_unit_and_uav_type.columns.len() + 2,
        summary.crews_by_strip_and_uav_type.columns.len() + 2,
    ]
    .into_iter()
    .max()
    .unwrap_or(12);
    let note_metadata_start = visible_column_count;

    push_row(
        &mut rows,
        row,
        26,
        &[text_cell(
            0,
            row,
            "ЗВІТ ПО ПОЗИЦІЯХ ТА ЕКІПАЖАХ",
            STYLE_TITLE,
        )],
    );
    merges.push(format!("A{row}:L{row}"));
    row += 1;
    push_row(
        &mut rows,
        row,
        22,
        &[text_cell(
            0,
            row,
            &format!("станом на {} року", report.report_date),
            STYLE_SUBTITLE,
        )],
    );
    merges.push(format!("A{row}:L{row}"));
    row += 1;
    push_blank_row(&mut rows, row);
    row += 1;

    for strip in &report.strips {
        push_row(
            &mut rows,
            row,
            24,
            &[text_cell(0, row, &strip.name, STYLE_STRIP)],
        );
        merges.push(format!("A{row}:L{row}"));
        row += 1;
        write_data_header(&mut rows, row);
        row += 1;

        let mut group_index = 0usize;
        while group_index < strip.groups.len() {
            let run_start = group_index;
            let uav_type = &strip.groups[run_start].uav_type;
            group_index += 1;
            while group_index < strip.groups.len()
                && strip.groups[group_index].uav_type == *uav_type
            {
                group_index += 1;
            }
            let type_start_row = row;
            let type_rows = strip.groups[run_start..group_index]
                .iter()
                .map(group_row_count)
                .sum::<usize>();
            if type_rows > 1 {
                merges.push(format!(
                    "B{type_start_row}:B{}",
                    type_start_row + type_rows - 1
                ));
            }
            for (offset, group) in strip.groups[run_start..group_index].iter().enumerate() {
                write_group(
                    &mut rows,
                    &mut merges,
                    &mut row,
                    group,
                    offset == 0,
                    report.separate_notes,
                    note_metadata_start,
                );
            }
        }

        let strip_summary = calculate_summary(std::slice::from_ref(strip));
        write_strip_summary(&mut rows, row, &strip_summary);
        row += 3;
        push_blank_row(&mut rows, row);
        row += 1;
        push_blank_row(&mut rows, row);
        row += 1;
    }

    write_summary(
        &mut rows,
        &mut merges,
        &mut row,
        summary,
        &operational_stats,
        !report.hide_unlinked_summary_caption,
    );
    let last_row = row.saturating_sub(1);
    let last_column = column_name(note_metadata_start + NOTE_METADATA_COLUMNS - 1);
    let extra_columns = if visible_column_count > 12 {
        format!("<col min=\"13\" max=\"{visible_column_count}\" width=\"22\" customWidth=\"1\"/>")
    } else {
        String::new()
    };
    let metadata_min = note_metadata_start + 1;
    let metadata_max = note_metadata_start + NOTE_METADATA_COLUMNS;
    let metadata_columns = format!(
        "<col min=\"{metadata_min}\" max=\"{metadata_max}\" width=\"0\" hidden=\"1\" customWidth=\"1\"/>"
    );
    let merge_xml = merges
        .iter()
        .map(|range| format!("<mergeCell ref=\"{range}\"/>"))
        .collect::<String>();

    format!(
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:{last_column}{last_row}\"/><sheetViews><sheetView showGridLines=\"0\" workbookViewId=\"0\"><pane ySplit=\"5\" topLeftCell=\"A6\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"18\"/><cols><col min=\"1\" max=\"1\" width=\"22\" customWidth=\"1\"/><col min=\"2\" max=\"2\" width=\"24\" customWidth=\"1\"/><col min=\"3\" max=\"3\" width=\"24\" customWidth=\"1\"/><col min=\"4\" max=\"4\" width=\"25\" customWidth=\"1\"/><col min=\"5\" max=\"5\" width=\"22\" customWidth=\"1\"/><col min=\"6\" max=\"6\" width=\"30\" customWidth=\"1\"/><col min=\"7\" max=\"7\" width=\"24\" customWidth=\"1\"/><col min=\"8\" max=\"8\" width=\"25\" customWidth=\"1\"/><col min=\"9\" max=\"9\" width=\"18\" customWidth=\"1\"/><col min=\"10\" max=\"10\" width=\"18\" customWidth=\"1\"/><col min=\"11\" max=\"11\" width=\"28\" customWidth=\"1\"/><col min=\"12\" max=\"12\" width=\"32\" customWidth=\"1\"/>{extra_columns}{metadata_columns}</cols><sheetData>{rows}</sheetData><mergeCells count=\"{}\">{merge_xml}</mergeCells><pageMargins left=\"0.2\" right=\"0.2\" top=\"0.3\" bottom=\"0.3\" header=\"0\" footer=\"0\"/><pageSetup paperSize=\"8\" orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>",
        merges.len()
    )
}

fn write_data_header(rows: &mut String, row: usize) {
    let headers = [
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
    ];
    let cells = headers
        .iter()
        .enumerate()
        .map(|(column, header)| text_cell(column, row, header, STYLE_HEADER))
        .collect::<Vec<_>>();
    push_row(rows, row, 44, &cells);
}

fn write_strip_summary(rows: &mut String, row: usize, summary: &StripsSummary) {
    let header = [
        text_cell(0, row, "Показник", STYLE_SUMMARY_HEADER),
        text_cell(1, row, "Всього", STYLE_SUMMARY_HEADER),
        text_cell(2, row, "БГ", STYLE_READY),
        text_cell(3, row, "Не БГ", STYLE_NOT_READY),
    ];
    push_row(rows, row, 34, &header);

    let crew_row = row + 1;
    let crews = [
        text_cell(0, crew_row, "Екіпажі", STYLE_SUMMARY_LABEL),
        number_cell(1, crew_row, summary.crew_totals.total, STYLE_SUMMARY_NUMBER),
        number_cell(2, crew_row, summary.crew_totals.ready, STYLE_READY),
        number_cell(3, crew_row, summary.crew_totals.not_ready, STYLE_NOT_READY),
    ];
    push_row(rows, crew_row, 30, &crews);

    let position_row = row + 2;
    let positions = [
        text_cell(0, position_row, "Позиції", STYLE_SUMMARY_LABEL),
        number_cell(
            1,
            position_row,
            summary.position_totals.total,
            STYLE_SUMMARY_NUMBER,
        ),
        number_cell(2, position_row, summary.position_totals.ready, STYLE_READY),
        number_cell(
            3,
            position_row,
            summary.position_totals.not_ready,
            STYLE_NOT_READY,
        ),
    ];
    push_row(rows, position_row, 30, &positions);
}

fn append_note_metadata(
    cells: &mut Vec<String>,
    row: usize,
    first_column: usize,
    crew_note: &str,
    position_note: &str,
    visible_note: &str,
) {
    cells.extend([
        text_cell(first_column, row, NOTE_METADATA_MARKER, STYLE_DATA_LEFT),
        text_cell(first_column + 1, row, crew_note, STYLE_DATA_LEFT),
        text_cell(first_column + 2, row, position_note, STYLE_DATA_LEFT),
        text_cell(first_column + 3, row, visible_note, STYLE_DATA_LEFT),
    ]);
}

fn write_group(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    group: &PreparedGroup,
    write_uav_type: bool,
    separate_notes: bool,
    note_metadata_start: usize,
) {
    let group_start = *row;
    let group_rows = group_row_count(group);
    let group_end = group_start + group_rows - 1;
    if group_rows > 1 {
        merges.push(format!("A{group_start}:A{group_end}"));
    }

    let mut first_group_row = true;
    for position in &group.positions {
        let header = first_group_row.then_some((
            group.unit.as_str(),
            if write_uav_type {
                group.uav_type.as_str()
            } else {
                ""
            },
        ));
        write_position(
            rows,
            merges,
            row,
            position,
            header,
            separate_notes,
            note_metadata_start,
        );
        first_group_row = false;
    }
    for crew in &group.loose_crews {
        let header = first_group_row.then_some((
            group.unit.as_str(),
            if write_uav_type {
                group.uav_type.as_str()
            } else {
                ""
            },
        ));
        write_loose_crew(rows, merges, row, crew, header, note_metadata_start);
        first_group_row = false;
    }
}

fn group_row_count(group: &PreparedGroup) -> usize {
    group
        .positions
        .iter()
        .map(|position| position.crews.len().max(1))
        .sum::<usize>()
        + group.loose_crews.len()
}

fn write_position(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    position: &PreparedPosition,
    group_header: Option<(&str, &str)>,
    separate_notes: bool,
    note_metadata_start: usize,
) {
    let start_row = *row;
    let row_count = position.crews.len().max(1);
    let end_row = start_row + row_count - 1;
    if row_count > 1 {
        let merged_columns: &[usize] = if separate_notes {
            &[6, 7, 8, 9, 10]
        } else {
            &[6, 7, 8, 9, 10, 11]
        };
        for &column in merged_columns {
            let letter = column_name(column);
            merges.push(format!("{letter}{start_row}:{letter}{end_row}"));
        }
    } else if position.crews.is_empty() {
        merges.push(format!("C{start_row}:F{start_row}"));
    }
    let position_readiness = readiness_display(&position.readiness, &position.not_ready_reason);

    for offset in 0..row_count {
        let current_row = start_row + offset;
        let unmatched = position.crews.is_empty();
        let position_center = if unmatched {
            STYLE_NEUTRAL
        } else {
            readiness_style(&position.readiness)
        };
        let position_left = if unmatched {
            STYLE_NEUTRAL_LEFT
        } else {
            readiness_left_style(&position.readiness)
        };
        let first = offset == 0;
        let (unit, uav_type) = if first {
            group_header.unwrap_or(("", ""))
        } else {
            ("", "")
        };
        let mut cells = vec![
            text_cell(0, current_row, unit, STYLE_DATA_CENTER),
            text_cell(1, current_row, uav_type, STYLE_DATA_CENTER),
        ];

        let crew = position.crews.get(offset);
        let crew_readiness = crew
            .map(|value| readiness_display(&value.readiness, &value.not_ready_reason))
            .unwrap_or_default();
        if let Some(crew) = crew {
            let crew_center = readiness_style(&crew.readiness);
            let crew_left = readiness_left_style(&crew.readiness);
            cells.push(text_cell(2, current_row, &crew.name, crew_center));
            cells.push(text_cell(3, current_row, &crew_readiness, crew_center));
            cells.push(text_cell(4, current_row, &crew.duty, crew_center));
            cells.push(text_cell(5, current_row, &crew.assets, crew_left));
        } else {
            cells.push(text_cell(
                2,
                current_row,
                "Позиція без екіпажу",
                position_center,
            ));
            for column in 3..=5 {
                cells.push(text_cell(column, current_row, "", position_center));
            }
        }

        cells.extend([
            text_cell(
                6,
                current_row,
                if first { &position.name } else { "" },
                position_center,
            ),
            text_cell(
                7,
                current_row,
                if first { &position_readiness } else { "" },
                position_center,
            ),
            text_cell(
                8,
                current_row,
                if first { &position.bro } else { "" },
                position_center,
            ),
            text_cell(
                9,
                current_row,
                if first { &position.area } else { "" },
                position_center,
            ),
            text_cell(
                10,
                current_row,
                if first { &position.direction } else { "" },
                position_left,
            ),
        ]);

        let note = if separate_notes {
            match (crew, first) {
                (Some(crew), true) if !crew.note.is_empty() && !position.note.is_empty() => {
                    format!("{}\n{}", crew.note, position.note)
                }
                (Some(crew), true) if crew.note.is_empty() => position.note.clone(),
                (Some(crew), _) => crew.note.clone(),
                (None, _) => position.note.clone(),
            }
        } else if first {
            position.note.clone()
        } else {
            String::new()
        };
        cells.push(text_cell(11, current_row, &note, STYLE_DATA_LEFT));
        append_note_metadata(
            &mut cells,
            current_row,
            note_metadata_start,
            crew.map(|value| value.note.as_str()).unwrap_or(""),
            if first { &position.note } else { "" },
            &note,
        );
        let mut height_values = vec![(unit, 18), (uav_type, 18), (note.as_str(), 28)];
        if let Some(crew) = crew {
            height_values.extend([
                (crew.name.as_str(), 20),
                (crew_readiness.as_str(), 18),
                (crew.duty.as_str(), 18),
                (crew.assets.as_str(), 24),
            ]);
        }
        if first {
            height_values.extend([
                (position.name.as_str(), 20),
                (position_readiness.as_str(), 18),
                (position.bro.as_str(), 16),
                (position.area.as_str(), 18),
                (position.direction.as_str(), 32),
            ]);
        }
        push_row(
            rows,
            current_row,
            adaptive_row_height(&height_values),
            &cells,
        );
    }
    *row = end_row + 1;
}

fn write_loose_crew(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    value: &PreparedLooseCrew,
    group_header: Option<(&str, &str)>,
    note_metadata_start: usize,
) {
    let current_row = *row;
    let crew = &value.crew;
    let (unit, uav_type) = group_header.unwrap_or(("", ""));
    let crew_readiness = readiness_display(&crew.readiness, &crew.not_ready_reason);
    let loose_note = crew.note.clone();
    merges.push(format!("G{current_row}:K{current_row}"));
    let mut cells = vec![
        text_cell(0, current_row, unit, STYLE_DATA_CENTER),
        text_cell(1, current_row, uav_type, STYLE_DATA_CENTER),
        text_cell(2, current_row, &crew.name, STYLE_NEUTRAL),
        text_cell(3, current_row, &crew_readiness, STYLE_NEUTRAL),
        text_cell(4, current_row, &crew.duty, STYLE_NEUTRAL),
        text_cell(5, current_row, &crew.assets, STYLE_NEUTRAL_LEFT),
        text_cell(6, current_row, "Екіпаж без позиції", STYLE_NEUTRAL),
        text_cell(11, current_row, &loose_note, STYLE_DATA_LEFT),
    ];
    append_note_metadata(
        &mut cells,
        current_row,
        note_metadata_start,
        &crew.note,
        "",
        &loose_note,
    );
    let height_values = [
        (unit, 18),
        (uav_type, 18),
        (crew.name.as_str(), 20),
        (crew_readiness.as_str(), 18),
        (crew.duty.as_str(), 18),
        (crew.assets.as_str(), 24),
        (loose_note.as_str(), 28),
    ];
    push_row(
        rows,
        current_row,
        adaptive_row_height(&height_values),
        &cells,
    );
    *row += 1;
}

fn write_summary(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    summary: &StripsSummary,
    operational_stats: &StripsOperationalStats,
    show_unlinked_caption: bool,
) {
    push_row(
        rows,
        *row,
        24,
        &[text_cell(
            0,
            *row,
            "ЗАГАЛЬНИЙ ПІДСУМОК",
            STYLE_SUMMARY_TITLE,
        )],
    );
    merges.push(format!("A{}:L{}", *row, *row));
    *row += 1;

    push_row(
        rows,
        *row,
        24,
        &[
            text_cell(0, *row, "Екіпажі за типом БпЛА", STYLE_SUMMARY_SECTION),
            text_cell(6, *row, "Позиції за типом БпЛА", STYLE_SUMMARY_SECTION),
        ],
    );
    merges.push(format!("A{}:E{}", *row, *row));
    merges.push(format!("G{}:J{}", *row, *row));
    *row += 1;

    push_row(
        rows,
        *row,
        38,
        &[
            text_cell(0, *row, "Тип БпЛА", STYLE_SUMMARY_HEADER),
            text_cell(1, *row, "БГ", STYLE_SUMMARY_HEADER),
            text_cell(2, *row, "Не БГ", STYLE_SUMMARY_HEADER),
            text_cell(3, *row, "Формується", STYLE_SUMMARY_HEADER),
            text_cell(4, *row, "Усього", STYLE_SUMMARY_HEADER),
            text_cell(6, *row, "Тип БпЛА", STYLE_SUMMARY_HEADER),
            text_cell(7, *row, "БГ", STYLE_SUMMARY_HEADER),
            text_cell(8, *row, "Не БГ", STYLE_SUMMARY_HEADER),
            text_cell(9, *row, "Усього", STYLE_SUMMARY_HEADER),
        ],
    );
    *row += 1;

    let table_rows = summary.crews.len().max(summary.positions.len());
    for index in 0..table_rows {
        let mut cells = Vec::new();
        if let Some(value) = summary.crews.get(index) {
            cells.extend(status_summary_cells(0, *row, value, true));
        } else {
            cells.extend(blank_summary_cells(0, *row, true));
        }
        if let Some(value) = summary.positions.get(index) {
            cells.extend(status_summary_cells(6, *row, value, false));
        } else {
            cells.extend(blank_summary_cells(6, *row, false));
        }
        push_row(rows, *row, 24, &cells);
        *row += 1;
    }

    push_row(
        rows,
        *row,
        24,
        &[
            text_cell(0, *row, "ЗАГАЛОМ", STYLE_SUMMARY_TOTAL_LABEL),
            number_cell(
                1,
                *row,
                summary.crew_totals.ready,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            number_cell(
                2,
                *row,
                summary.crew_totals.not_ready,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            number_cell(
                3,
                *row,
                summary.crew_totals.forming,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            number_cell(
                4,
                *row,
                summary.crew_totals.total,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            text_cell(6, *row, "ЗАГАЛОМ", STYLE_SUMMARY_TOTAL_LABEL),
            number_cell(
                7,
                *row,
                summary.position_totals.ready,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            number_cell(
                8,
                *row,
                summary.position_totals.not_ready,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            number_cell(
                9,
                *row,
                summary.position_totals.total,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
        ],
    );
    *row += 2;

    if show_unlinked_caption {
        push_row(
            rows,
            *row,
            32,
            &[text_cell(
                0,
                *row,
                "ДОВІДКОВО: ЗАПИСИ БЕЗ ЗВ’ЯЗКУ",
                STYLE_SUMMARY_SECTION,
            )],
        );
        merges.push(format!("A{}:D{}", *row, *row));
        *row += 1;
    }
    push_row(
        rows,
        *row,
        38,
        &[
            text_cell(0, *row, "Тип БпЛА", STYLE_SUMMARY_HEADER),
            text_cell(1, *row, "Екіпажів без позиції", STYLE_SUMMARY_HEADER),
            text_cell(2, *row, "Позицій без екіпажу", STYLE_SUMMARY_HEADER),
            text_cell(3, *row, "Усього", STYLE_SUMMARY_HEADER),
        ],
    );
    *row += 1;
    for value in &summary.exceptions {
        push_row(
            rows,
            *row,
            24,
            &[
                text_cell(0, *row, value.uav_type, STYLE_SUMMARY_LABEL),
                number_cell(
                    1,
                    *row,
                    value.counts.crews_without_position,
                    STYLE_SUMMARY_NUMBER,
                ),
                number_cell(
                    2,
                    *row,
                    value.counts.positions_without_crews,
                    STYLE_SUMMARY_NUMBER,
                ),
                number_cell(3, *row, value.counts.total(), STYLE_SUMMARY_NUMBER),
            ],
        );
        *row += 1;
    }
    push_row(
        rows,
        *row,
        24,
        &[
            text_cell(0, *row, "ЗАГАЛОМ", STYLE_SUMMARY_TOTAL_LABEL),
            number_cell(
                1,
                *row,
                summary.exception_totals.crews_without_position,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            number_cell(
                2,
                *row,
                summary.exception_totals.positions_without_crews,
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
            number_cell(
                3,
                *row,
                summary.exception_totals.total(),
                STYLE_SUMMARY_TOTAL_NUMBER,
            ),
        ],
    );
    *row += 1;

    for (title, row_header, matrix) in [
        (
            "Екіпажі за підрозділами по смугах",
            "Підрозділ",
            &summary.crews_by_unit_and_strip,
        ),
        (
            "Екіпажі за підрозділами по типах БпЛА",
            "Підрозділ",
            &summary.crews_by_unit_and_uav_type,
        ),
        (
            "Екіпажі по смугах за типами БпЛА",
            "Смуга",
            &summary.crews_by_strip_and_uav_type,
        ),
    ] {
        *row += 1;
        write_count_matrix(rows, merges, row, title, row_header, matrix);
    }

    *row += 1;
    write_readiness_table(
        rows,
        merges,
        row,
        "Готовність екіпажів за підрозділами",
        "Підрозділ",
        &operational_stats.readiness_by_unit,
    );
    *row += 1;
    write_readiness_table(
        rows,
        merges,
        row,
        "Готовність екіпажів за смугами",
        "Смуга",
        &operational_stats.readiness_by_strip,
    );
    *row += 1;
    write_coverage_table(rows, merges, row, operational_stats);
}

fn write_count_matrix(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    title: &str,
    row_header: &str,
    matrix: &CountMatrix,
) {
    let last_column = matrix.columns.len() + 1;
    push_row(
        rows,
        *row,
        30,
        &[text_cell(0, *row, title, STYLE_SUMMARY_SECTION)],
    );
    merges.push(format!("A{}:{}{}", *row, column_name(last_column), *row));
    *row += 1;

    let mut header_cells = vec![text_cell(0, *row, row_header, STYLE_SUMMARY_HEADER)];
    header_cells.extend(
        matrix
            .columns
            .iter()
            .enumerate()
            .map(|(index, column)| text_cell(index + 1, *row, column, STYLE_SUMMARY_HEADER)),
    );
    header_cells.push(text_cell(last_column, *row, "Усього", STYLE_SUMMARY_HEADER));
    push_row(rows, *row, 38, &header_cells);
    *row += 1;

    for matrix_row in &matrix.rows {
        let mut cells = vec![text_cell(0, *row, &matrix_row.label, STYLE_SUMMARY_LABEL)];
        cells.extend(
            matrix_row
                .values
                .iter()
                .enumerate()
                .map(|(index, value)| number_cell(index + 1, *row, *value, STYLE_SUMMARY_NUMBER)),
        );
        cells.push(number_cell(
            last_column,
            *row,
            matrix_row.total,
            STYLE_SUMMARY_NUMBER,
        ));
        push_row(rows, *row, 24, &cells);
        *row += 1;
    }

    let mut total_cells = vec![text_cell(0, *row, "ЗАГАЛОМ", STYLE_SUMMARY_TOTAL_LABEL)];
    total_cells.extend(
        matrix
            .column_totals
            .iter()
            .enumerate()
            .map(|(index, value)| number_cell(index + 1, *row, *value, STYLE_SUMMARY_TOTAL_NUMBER)),
    );
    total_cells.push(number_cell(
        last_column,
        *row,
        matrix.total,
        STYLE_SUMMARY_TOTAL_NUMBER,
    ));
    push_row(rows, *row, 24, &total_cells);
    *row += 1;
}

fn write_readiness_table(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    title: &str,
    label_header: &str,
    values: &[ReadinessBreakdownRow],
) {
    push_row(
        rows,
        *row,
        30,
        &[text_cell(0, *row, title, STYLE_SUMMARY_SECTION)],
    );
    merges.push(format!("A{}:E{}", *row, *row));
    *row += 1;

    push_row(
        rows,
        *row,
        38,
        &[
            text_cell(0, *row, label_header, STYLE_SUMMARY_HEADER),
            text_cell(1, *row, "БГ", STYLE_SUMMARY_HEADER),
            text_cell(2, *row, "Не БГ", STYLE_SUMMARY_HEADER),
            text_cell(3, *row, "Всього", STYLE_SUMMARY_HEADER),
            text_cell(4, *row, "БГ, %", STYLE_SUMMARY_HEADER),
        ],
    );
    *row += 1;

    for value in values {
        push_row(
            rows,
            *row,
            24,
            &[
                text_cell(0, *row, &value.label, STYLE_SUMMARY_LABEL),
                number_cell(1, *row, value.counts.ready, STYLE_SUMMARY_NUMBER),
                number_cell(2, *row, value.counts.not_ready, STYLE_SUMMARY_NUMBER),
                number_cell(3, *row, value.counts.total, STYLE_SUMMARY_NUMBER),
                percent_cell(4, *row, value.ready_rate_percent, STYLE_SUMMARY_PERCENT),
            ],
        );
        *row += 1;
    }
}

fn write_coverage_table(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    stats: &StripsOperationalStats,
) {
    push_row(
        rows,
        *row,
        30,
        &[text_cell(
            0,
            *row,
            "Заповнення екіпажів і позицій за підрозділами",
            STYLE_SUMMARY_SECTION,
        )],
    );
    merges.push(format!("A{}:I{}", *row, *row));
    *row += 1;

    let headers = [
        "Підрозділ",
        "Екіпажів",
        "З позицією",
        "Без позиції",
        "Зв’язано, %",
        "Позицій",
        "З екіпажем",
        "Без екіпажу",
        "Заповнено, %",
    ];
    let header_cells = headers
        .iter()
        .enumerate()
        .map(|(column, header)| text_cell(column, *row, header, STYLE_SUMMARY_HEADER))
        .collect::<Vec<_>>();
    push_row(rows, *row, 38, &header_cells);
    *row += 1;

    for value in &stats.coverage_by_unit {
        push_coverage_row(rows, *row, &value.label, value.counts, false);
        *row += 1;
    }
    push_coverage_row(rows, *row, "Усього", stats.coverage_overall, true);
    *row += 1;
}

fn push_coverage_row(
    rows: &mut String,
    row: usize,
    label: &str,
    counts: LinkCoverageCounts,
    total: bool,
) {
    let label_style = if total {
        STYLE_SUMMARY_TOTAL_LABEL
    } else {
        STYLE_SUMMARY_LABEL
    };
    let number_style = if total {
        STYLE_SUMMARY_TOTAL_NUMBER
    } else {
        STYLE_SUMMARY_NUMBER
    };
    let percent_style = if total {
        STYLE_SUMMARY_TOTAL_PERCENT
    } else {
        STYLE_SUMMARY_PERCENT
    };
    push_row(
        rows,
        row,
        24,
        &[
            text_cell(0, row, label, label_style),
            number_cell(1, row, counts.crews_total, number_style),
            number_cell(2, row, counts.crews_linked, number_style),
            number_cell(3, row, counts.crews_unlinked, number_style),
            percent_cell(4, row, counts.crew_link_rate_percent, percent_style),
            number_cell(5, row, counts.positions_total, number_style),
            number_cell(6, row, counts.positions_occupied, number_style),
            number_cell(7, row, counts.positions_empty, number_style),
            percent_cell(8, row, counts.position_staffing_rate_percent, percent_style),
        ],
    );
}

fn status_summary_cells(
    first_column: usize,
    row: usize,
    value: &StatusSummaryRow,
    include_forming: bool,
) -> Vec<String> {
    let mut cells = vec![
        text_cell(first_column, row, value.uav_type, STYLE_SUMMARY_LABEL),
        number_cell(
            first_column + 1,
            row,
            value.counts.ready,
            STYLE_SUMMARY_NUMBER,
        ),
        number_cell(
            first_column + 2,
            row,
            value.counts.not_ready,
            STYLE_SUMMARY_NUMBER,
        ),
    ];
    if include_forming {
        cells.push(number_cell(
            first_column + 3,
            row,
            value.counts.forming,
            STYLE_SUMMARY_NUMBER,
        ));
        cells.push(number_cell(
            first_column + 4,
            row,
            value.counts.total,
            STYLE_SUMMARY_NUMBER,
        ));
    } else {
        cells.push(number_cell(
            first_column + 3,
            row,
            value.counts.total,
            STYLE_SUMMARY_NUMBER,
        ));
    }
    cells
}

fn blank_summary_cells(first_column: usize, row: usize, include_forming: bool) -> Vec<String> {
    let count = if include_forming { 5 } else { 4 };
    (0..count)
        .map(|offset| {
            text_cell(
                first_column + offset,
                row,
                "",
                if offset == 0 {
                    STYLE_SUMMARY_LABEL
                } else {
                    STYLE_SUMMARY_NUMBER
                },
            )
        })
        .collect()
}

fn readiness_display(status: &str, reason: &str) -> String {
    if status == "Не БГ" {
        format!("Не БГ ({reason})")
    } else {
        status.to_string()
    }
}

fn readiness_style(status: &str) -> usize {
    match status {
        "БГ" => STYLE_READY,
        "Не БГ" => STYLE_NOT_READY,
        "Формується" => STYLE_FORMING,
        _ => STYLE_DATA_CENTER,
    }
}

fn readiness_left_style(status: &str) -> usize {
    match status {
        "БГ" => STYLE_READY_LEFT,
        "Не БГ" => STYLE_NOT_READY_LEFT,
        "Формується" => STYLE_FORMING_LEFT,
        _ => STYLE_DATA_LEFT,
    }
}

fn adaptive_row_height(values: &[(&str, usize)]) -> usize {
    let lines = values
        .iter()
        .map(|(value, chars_per_line)| {
            value
                .lines()
                .map(|line| {
                    line.chars()
                        .count()
                        .max(1)
                        .div_ceil((*chars_per_line).max(1))
                })
                .sum::<usize>()
        })
        .max()
        .unwrap_or(1)
        .clamp(1, 11);
    (lines * 15 + 14).clamp(52, 180)
}

fn push_row(rows: &mut String, row: usize, height: usize, cells: &[String]) {
    rows.push_str(&format!(
        "<row r=\"{row}\" ht=\"{height}\" customHeight=\"1\">"
    ));
    for cell in cells {
        rows.push_str(cell);
    }
    rows.push_str("</row>");
}

fn push_blank_row(rows: &mut String, row: usize) {
    rows.push_str(&format!("<row r=\"{row}\"/>"));
}

fn text_cell(column: usize, row: usize, value: &str, style: usize) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
        column_name(column),
        esc(value)
    )
}

fn number_cell(column: usize, row: usize, value: usize, style: usize) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\"><v>{value}</v></c>",
        column_name(column)
    )
}

fn percent_cell(column: usize, row: usize, value: f64, style: usize) -> String {
    let mut fraction = format!("{:.3}", value / 100.0);
    while fraction.ends_with('0') {
        fraction.pop();
    }
    if fraction.ends_with('.') {
        fraction.pop();
    }
    if fraction.is_empty() {
        fraction.push('0');
    }
    format!(
        "<c r=\"{}{row}\" s=\"{style}\"><v>{fraction}</v></c>",
        column_name(column)
    )
}

fn column_name(mut index: usize) -> String {
    let mut value = Vec::new();
    index += 1;
    while index > 0 {
        let remainder = (index - 1) % 26;
        value.push((b'A' + remainder as u8) as char);
        index = (index - 1) / 26;
    }
    value.iter().rev().collect()
}

fn esc(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn strips_styles() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
  <fonts count="4">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <font><sz val="12"/><color rgb="FF000000"/><name val="Times New Roman"/><family val="1"/></font>
    <font><b/><sz val="12"/><color rgb="FF000000"/><name val="Times New Roman"/><family val="1"/></font>
    <font><b/><sz val="16"/><color rgb="FF000000"/><name val="Times New Roman"/><family val="1"/></font>
  </fonts>
  <fills count="9">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF00B0F0"/><bgColor rgb="FF00B0F0"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor rgb="FFD9E2F3"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD7E48D"/><bgColor rgb="FFD7E48D"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE6B8B7"/><bgColor rgb="FFE6B8B7"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFDEADA"/><bgColor rgb="FFFDEADA"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor rgb="FFF2F2F2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD7E4BD"/><bgColor rgb="FFD7E4BD"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>
    <border><left style="medium"><color rgb="FF000000"/></left><right style="medium"><color rgb="FF000000"/></right><top style="medium"><color rgb="FF000000"/></top><bottom style="medium"><color rgb="FF000000"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="24">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="2" fillId="8" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>"#
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, io::Read};
    use zip::ZipArchive;

    fn crew(id: &str, name: &str, readiness: &str, reason: &str) -> StripCrew {
        StripCrew {
            id: id.into(),
            name: name.into(),
            readiness: readiness.into(),
            not_ready_reason: reason.into(),
            duty: if readiness == "Формується" {
                "Формується".into()
            } else {
                "БЧ".into()
            },
            assets: "Mavic 3T, резервний Mavic 3".into(),
            note: String::new(),
        }
    }

    fn position(id: &str, crews: Vec<StripCrew>) -> StripPosition {
        let readiness = crews
            .first()
            .filter(|crew| crew.readiness != "Формується")
            .map(|crew| crew.readiness.as_str())
            .unwrap_or("Не БГ");
        StripPosition {
            id: id.into(),
            name: "Позиція Альфа".into(),
            readiness: readiness.into(),
            not_ready_reason: if readiness == "Не БГ" {
                "Засіб пошкоджено".into()
            } else {
                String::new()
            },
            bro: "БРО-1".into(),
            area: "північ".into(),
            direction: "Північний напрямок".into(),
            note: "Перевірити після ремонту".into(),
            crews,
        }
    }

    fn loose_crew(id: &str) -> LooseStripCrew {
        let crew = crew(id, "Екіпаж без позиції", "Формується", "");
        LooseStripCrew {
            id: crew.id,
            name: crew.name,
            readiness: crew.readiness,
            not_ready_reason: crew.not_ready_reason,
            duty: crew.duty,
            assets: crew.assets,
            note: crew.note,
        }
    }

    fn group(
        id: &str,
        unit: &str,
        uav_type: &str,
        positions: Vec<StripPosition>,
        loose_crews: Vec<LooseStripCrew>,
    ) -> StripGroup {
        StripGroup {
            id: id.into(),
            unit: unit.into(),
            uav_type: uav_type.into(),
            positions,
            loose_crews,
        }
    }

    fn request(output_path: String) -> StripsExportRequest {
        StripsExportRequest {
            version: 1,
            report_date: "2026-10-12".into(),
            strips: vec![WorkStrip {
                id: "strip-1".into(),
                name: "Смуга 228 ОМПБр".into(),
                groups: vec![
                    group(
                        "group-1",
                        "1 РУБАК",
                        "ФПВ",
                        vec![position(
                            "position-1",
                            vec![
                                crew("crew-1", "Альфа", "Не БГ", "Засіб пошкоджено"),
                                crew("crew-2", "Браво", "Не БГ", "Екіпаж виведено з позиції"),
                            ],
                        )],
                        Vec::new(),
                    ),
                    group(
                        "group-2",
                        "1 РУБАК",
                        "Бомбер",
                        vec![position("position-2", Vec::new())],
                        Vec::new(),
                    ),
                    group(
                        "group-3",
                        "2 РУБАК",
                        "Коптер",
                        Vec::new(),
                        vec![loose_crew("loose-1")],
                    ),
                ],
            }],
            output_path,
            separate_notes: false,
            hide_unlinked_summary_caption: false,
        }
    }

    fn zip_text(path: &std::path::Path, name: &str) -> String {
        let file = File::open(path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut value = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut value)
            .unwrap();
        value
    }

    fn remove_cells_in_columns(mut sheet: String, columns: &[&str]) -> String {
        for column in columns {
            let cell_prefix = format!("<c r=\"{column}");
            while let Some(start) = sheet.find(&cell_prefix) {
                let end = start
                    + sheet[start..]
                        .find("</c>")
                        .expect("test worksheet cell must be closed")
                    + "</c>".len();
                sheet.replace_range(start..end, "");
            }
        }
        sheet
    }

    #[test]
    fn summary_counts_each_crew_once_and_reports_unlinked_entities() {
        let prepared = prepare_request(request("report.xlsx".into())).unwrap();
        let summary = calculate_summary(&prepared.strips);

        assert_eq!(summary.crews.len(), 1);
        assert_eq!(summary.crews[0].uav_type, "ФПВ");
        assert_eq!(
            summary.crew_totals,
            StatusCounts {
                ready: 0,
                not_ready: 2,
                forming: 0,
                total: 2,
            }
        );
        assert_eq!(summary.positions.len(), 1);
        assert_eq!(
            summary.position_totals,
            StatusCounts {
                ready: 0,
                not_ready: 1,
                forming: 0,
                total: 1,
            }
        );
        assert_eq!(summary.exceptions.len(), 2);
        assert_eq!(summary.exceptions[0].uav_type, "Коптер");
        assert_eq!(summary.exceptions[0].counts.crews_without_position, 1);
        assert_eq!(summary.exceptions[0].counts.positions_without_crews, 0);
        assert_eq!(summary.exceptions[1].uav_type, "Бомбер");
        assert_eq!(summary.exceptions[1].counts.crews_without_position, 0);
        assert_eq!(summary.exceptions[1].counts.positions_without_crews, 1);
        assert_eq!(summary.exception_totals.crews_without_position, 1);
        assert_eq!(summary.exception_totals.positions_without_crews, 1);
        assert_eq!(
            summary.crews_by_unit_and_strip,
            CountMatrix {
                columns: vec!["Смуга 228 ОМПБр".into()],
                rows: vec![CountMatrixRow {
                    label: "1 РУБАК".into(),
                    values: vec![2],
                    total: 2,
                }],
                column_totals: vec![2],
                total: 2,
            }
        );
        assert_eq!(
            summary.crews_by_unit_and_uav_type,
            CountMatrix {
                columns: vec!["ФПВ".into()],
                rows: vec![CountMatrixRow {
                    label: "1 РУБАК".into(),
                    values: vec![2],
                    total: 2,
                }],
                column_totals: vec![2],
                total: 2,
            }
        );
        assert_eq!(
            summary.crews_by_strip_and_uav_type,
            CountMatrix {
                columns: vec!["ФПВ".into()],
                rows: vec![CountMatrixRow {
                    label: "Смуга 228 ОМПБр".into(),
                    values: vec![2],
                    total: 2,
                }],
                column_totals: vec![2],
                total: 2,
            }
        );
        assert_eq!(
            summary.crews_by_unit_and_strip.total,
            summary.crew_totals.total
        );
        assert_eq!(
            summary.crews_by_unit_and_uav_type.total,
            summary.crew_totals.total
        );
        assert_eq!(
            summary.crews_by_strip_and_uav_type.total,
            summary.crew_totals.total
        );
    }

    #[test]
    fn operational_stats_match_registry_rules_and_reconcile_with_the_main_summary() {
        let prepared = prepare_request(request("report.xlsx".into())).unwrap();
        let summary = calculate_summary(&prepared.strips);
        let stats = calculate_operational_stats(&prepared.strips);

        assert_eq!(
            stats.readiness_by_unit,
            vec![ReadinessBreakdownRow {
                label: "1 РУБАК".into(),
                counts: StatusCounts {
                    ready: 0,
                    not_ready: 2,
                    forming: 0,
                    total: 2,
                },
                ready_rate_percent: 0.0,
            }]
        );
        assert_eq!(
            stats.readiness_by_strip,
            vec![ReadinessBreakdownRow {
                label: "Смуга 228 ОМПБр".into(),
                counts: StatusCounts {
                    ready: 0,
                    not_ready: 2,
                    forming: 0,
                    total: 2,
                },
                ready_rate_percent: 0.0,
            }]
        );
        assert_eq!(
            stats.coverage_by_unit,
            vec![
                LinkCoverageRow {
                    label: "1 РУБАК".into(),
                    counts: LinkCoverageCounts {
                        crews_total: 2,
                        crews_linked: 2,
                        crews_unlinked: 0,
                        crew_link_rate_percent: 100.0,
                        positions_total: 2,
                        positions_occupied: 1,
                        positions_empty: 1,
                        position_staffing_rate_percent: 50.0,
                    },
                },
                LinkCoverageRow {
                    label: "2 РУБАК".into(),
                    counts: LinkCoverageCounts {
                        crews_total: 1,
                        crews_linked: 0,
                        crews_unlinked: 1,
                        crew_link_rate_percent: 0.0,
                        positions_total: 0,
                        positions_occupied: 0,
                        positions_empty: 0,
                        position_staffing_rate_percent: 0.0,
                    },
                },
            ]
        );
        assert_eq!(
            stats.coverage_overall,
            LinkCoverageCounts {
                crews_total: 3,
                crews_linked: 2,
                crews_unlinked: 1,
                crew_link_rate_percent: 66.7,
                positions_total: 2,
                positions_occupied: 1,
                positions_empty: 1,
                position_staffing_rate_percent: 50.0,
            }
        );

        assert_eq!(
            stats
                .readiness_by_unit
                .iter()
                .map(|row| row.counts.total)
                .sum::<usize>(),
            summary.crew_totals.total
        );
        assert_eq!(
            stats
                .readiness_by_strip
                .iter()
                .map(|row| row.counts.total)
                .sum::<usize>(),
            summary.crew_totals.total
        );
        assert_eq!(
            stats.coverage_overall.crews_linked,
            summary.crew_totals.total
        );
        assert_eq!(
            stats.coverage_overall.crews_unlinked,
            summary.exception_totals.crews_without_position
        );
        assert_eq!(
            stats.coverage_overall.positions_occupied,
            summary.position_totals.total
        );
        assert_eq!(
            stats.coverage_overall.positions_empty,
            summary.exception_totals.positions_without_crews
        );
    }

    #[test]
    fn operational_stats_prefer_linked_crews_and_first_unique_positions() {
        let mut prepared = prepare_request(request("report.xlsx".into())).unwrap();
        prepared.strips[0].groups[2].loose_crews[0].crew.name = "  АЛЬФА ".into();
        prepared.strips[0].groups[1].positions[0].id =
            prepared.strips[0].groups[0].positions[0].id.clone();
        prepared.strips[0].groups.swap(0, 2);

        let stats = calculate_operational_stats(&prepared.strips);

        assert_eq!(stats.coverage_overall.crews_total, 2);
        assert_eq!(stats.coverage_overall.crews_linked, 2);
        assert_eq!(stats.coverage_overall.crews_unlinked, 0);
        assert_eq!(stats.coverage_overall.positions_total, 1);
        assert_eq!(stats.coverage_overall.positions_occupied, 0);
        assert_eq!(stats.coverage_overall.positions_empty, 1);
        assert_eq!(stats.readiness_by_unit.len(), 1);
        assert_eq!(stats.readiness_by_unit[0].label, "1 РУБАК");
        assert_eq!(stats.readiness_by_unit[0].counts.total, 2);
    }

    #[test]
    fn rejects_a_linked_forming_crew() {
        let mut value = request("report.xlsx".into());
        value.strips[0].groups[0].positions[0].crews[0] = crew("crew-1", "Альфа", "Формується", "");

        let error = prepare_request(value).unwrap_err();
        assert!(error.contains("не може бути закріплений"));
    }

    #[test]
    fn rejects_not_ready_without_a_reason_and_invalid_forming_duty() {
        let mut missing_reason = request("report.xlsx".into());
        missing_reason.strips[0].groups[0].positions[0].crews[1]
            .not_ready_reason
            .clear();
        let error = prepare_request(missing_reason).unwrap_err();
        assert!(error.contains("Причина «Не БГ»"));

        let mut invalid_duty = request("report.xlsx".into());
        invalid_duty.strips[0].groups[2].loose_crews[0].duty = "БЧ".into();
        let error = prepare_request(invalid_duty).unwrap_err();
        assert!(error.contains("значення БЧ також повинно бути «Формується»"));

        let mut missing_duty = request("report.xlsx".into());
        missing_duty.strips[0].groups[2].loose_crews[0].duty.clear();
        let error = prepare_request(missing_duty).unwrap_err();
        assert!(error.contains("БЧ екіпажу"));

        let mut duplicate_id = request("report.xlsx".into());
        duplicate_id.strips[0].groups[1].id = "crew-1".into();
        let error = prepare_request(duplicate_id).unwrap_err();
        assert!(error.contains("ID «crew-1» повторюється"));

        let mut mismatched = request("report.xlsx".into());
        mismatched.strips[0].groups[0].positions[0].crews[0].readiness = "БГ".into();
        mismatched.strips[0].groups[0].positions[0].crews[0]
            .not_ready_reason
            .clear();
        let error = prepare_request(mismatched).unwrap_err();
        assert!(error.contains("статус екіпажу має збігатися зі статусом позиції"));
    }

    #[test]
    fn rejects_repeated_type_runs_units_and_crew_names() {
        let mut repeated_type = request("report.xlsx".into());
        repeated_type.strips[0].groups[2].uav_type = "ФПВ".into();
        let error = prepare_request(repeated_type).unwrap_err();
        assert!(error.contains("тип БпЛА «ФПВ» уже доданий"));

        let mut repeated_unit = request("report.xlsx".into());
        repeated_unit.strips[0].groups[1].uav_type = "ФПВ".into();
        let error = prepare_request(repeated_unit).unwrap_err();
        assert!(error.contains("підрозділ «1 РУБАК» уже доданий"));

        let mut repeated_crew = request("report.xlsx".into());
        repeated_crew.strips[0].groups[2].loose_crews[0].name = "  АЛЬФА ".into();
        let error = prepare_request(repeated_crew).unwrap_err();
        assert!(error.contains("Екіпаж може бути лише в одному місці"));
    }

    #[test]
    fn adds_system_notes_and_preserves_user_notes() {
        let mut value = request("report.xlsx".into());
        let empty_position = &mut value.strips[0].groups[1].positions[0];
        empty_position.readiness = "БГ".into();
        empty_position.not_ready_reason.clear();
        empty_position.note = "Користувацька примітка позиції".into();
        let loose = &mut value.strips[0].groups[2].loose_crews[0];
        loose.readiness = "БГ".into();
        loose.duty = "БЧ".into();
        loose.note = "Користувацька примітка екіпажу".into();

        let prepared = prepare_request(value).unwrap();
        assert_eq!(
            prepared.strips[0].groups[1].positions[0].note,
            format!("{POSITION_WITHOUT_CREW_NOTE}\nКористувацька примітка позиції")
        );
        assert_eq!(
            prepared.strips[0].groups[2].loose_crews[0].crew.note,
            format!("{CREW_WITHOUT_POSITION_NOTE}\nКористувацька примітка екіпажу")
        );
    }

    #[test]
    fn summary_never_counts_a_repeated_crew_name_twice() {
        let mut prepared = prepare_request(request("report.xlsx".into())).unwrap();
        prepared.strips[0].groups[2].loose_crews[0].crew.name = " АЛЬФА ".into();
        let summary = calculate_summary(&prepared.strips);

        assert_eq!(summary.crew_totals.total, 2);
        assert_eq!(summary.exception_totals.crews_without_position, 0);
        assert_eq!(summary.crews_by_unit_and_strip.total, 2);
        assert_eq!(summary.crews_by_unit_and_uav_type.total, 2);
        assert_eq!(summary.crews_by_strip_and_uav_type.total, 2);
    }

    #[test]
    fn exports_one_sheet_with_merges_colors_reasons_and_uppercase_area() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("strips.xlsx");
        export_strips(request(path.to_string_lossy().into_owned())).unwrap();

        let workbook = zip_text(&path, "xl/workbook.xml");
        let sheet = zip_text(&path, "xl/worksheets/sheet1.xml");
        let styles = zip_text(&path, "xl/styles.xml");

        assert!(workbook.contains("<sheet name=\"Позиції по смугах\""));
        assert_eq!(workbook.matches("<sheet ").count(), 1);
        for range in [
            "A6:A7", "B6:B7", "G6:G7", "H6:H7", "I6:I7", "J6:J7", "K6:K7", "L6:L7",
        ] {
            assert!(sheet.contains(&format!("<mergeCell ref=\"{range}\"/>")));
        }
        assert!(sheet.contains("Не БГ (Екіпаж виведено з позиції)"));
        assert!(sheet.contains("Не БГ (Засіб пошкоджено)"));
        assert!(sheet.contains("ПІВНІЧ"));
        assert!(sheet.contains("Позиція без екіпажу"));
        assert!(sheet.contains("Екіпаж без позиції"));
        assert!(sheet.matches("Формується").count() >= 2);
        assert!(sheet.contains("<mergeCell ref=\"G9:K9\"/>"));
        assert!(sheet.contains("<c r=\"C8\" s=\"10\""));
        assert!(sheet.contains("<c r=\"C9\" s=\"10\""));
        assert!(sheet.contains("Показник"));
        assert!(sheet.contains("<t xml:space=\"preserve\">Екіпажі</t>"));
        assert!(sheet.contains("<t xml:space=\"preserve\">Позиції</t>"));
        assert!(sheet.contains("<c r=\"B11\" s=\"16\"><v>2</v></c>"));
        assert!(sheet.contains("<c r=\"D11\" s=\"8\"><v>2</v></c>"));
        assert!(sheet.contains("<c r=\"B12\" s=\"16\"><v>1</v></c>"));
        assert!(sheet.contains("<c r=\"D12\" s=\"8\"><v>1</v></c>"));
        assert!(sheet.contains("Екіпажі за типом БпЛА"));
        assert!(sheet.contains("Екіпажі за підрозділами по смугах"));
        assert!(sheet.contains("Екіпажі за підрозділами по типах БпЛА"));
        assert!(sheet.contains("Екіпажі по смугах за типами БпЛА"));
        assert!(sheet.contains("Готовність екіпажів за підрозділами"));
        assert!(sheet.contains("Готовність екіпажів за смугами"));
        assert!(sheet.contains("Заповнення екіпажів і позицій за підрозділами"));
        assert!(sheet.contains("Зв’язано, %"));
        assert!(sheet.contains("Заповнено, %"));
        assert!(sheet.contains("s=\"23\"><v>0.667</v>"));
        assert!(sheet.contains("s=\"23\"><v>0.5</v>"));
        assert!(sheet.contains("ДОВІДКОВО: ЗАПИСИ БЕЗ ЗВ’ЯЗКУ"));
        assert!(!sheet.contains("НЕ ВХОДЯТЬ В ОСНОВНИЙ ПІДСУМОК"));
        assert!(sheet.contains("<col min=\"11\" max=\"11\" width=\"28\""));
        assert!(!styles.contains("horizontal=\"left\""));
        assert!(styles.contains("rgb=\"FFD7E48D\""));
        assert!(styles.contains("rgb=\"FFE6B8B7\""));
        assert!(styles.contains("rgb=\"FFFDEADA\""));
        assert!(styles.contains("numFmtId=\"164\" formatCode=\"0.0%\""));
        assert!(styles.contains("<cellXfs count=\"24\">"));
    }

    #[test]
    fn imports_its_export_back_into_registry_without_duplicate_entities() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("strips-roundtrip.xlsx");
        let mut value = request(path.to_string_lossy().into_owned());
        value.separate_notes = true;
        export_strips(value).unwrap();

        let imported = import_strips_registry(path.to_string_lossy().into_owned()).unwrap();

        assert_eq!(imported.version, 2);
        assert_eq!(imported.report_date, "2026-10-12");
        assert_eq!(imported.crews.len(), 3);
        assert_eq!(imported.positions.len(), 2);
        assert_eq!(imported.assignments.len(), 2);
        assert_eq!(
            imported
                .crews
                .iter()
                .map(|crew| crew.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Альфа", "Браво", "Екіпаж без позиції"]
        );
        assert_eq!(
            imported
                .positions
                .iter()
                .map(|position| position.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Позиція Альфа", "Позиція Альфа"]
        );
        assert!(imported
            .crews
            .iter()
            .find(|crew| crew.name == "Екіпаж без позиції")
            .is_some_and(|crew| crew.readiness == "Формується"));
        assert!(imported.positions.iter().any(|position| {
            position.uav_type == "Бомбер"
                && !imported
                    .assignments
                    .iter()
                    .any(|assignment| assignment.position_id == position.id)
        }));
        let assigned_crews = imported
            .assignments
            .iter()
            .map(|assignment| assignment.crew_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(assigned_crews.len(), imported.assignments.len());

        let json = serde_json::to_value(&imported).unwrap();
        assert_eq!(json["version"], 2);
        assert_eq!(json["reportDate"], "2026-10-12");
        assert!(json["crews"][0].get("uavType").is_some());
        assert!(json["assignments"][0].get("crewId").is_some());
    }

    #[test]
    fn imports_unlinked_ready_entities_and_keeps_system_notes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unlinked-roundtrip.xlsx");
        let mut value = request(path.to_string_lossy().into_owned());
        value.separate_notes = true;
        let empty_position = &mut value.strips[0].groups[1].positions[0];
        empty_position.readiness = "БГ".into();
        empty_position.not_ready_reason.clear();
        empty_position.note = "Користувацька примітка позиції".into();
        let loose = &mut value.strips[0].groups[2].loose_crews[0];
        loose.readiness = "БГ".into();
        loose.duty = "БЧ".into();
        loose.note = "Користувацька примітка екіпажу".into();
        export_strips(value).unwrap();

        let imported = import_strips_registry(path.to_string_lossy().into_owned()).unwrap();
        let loose = imported
            .crews
            .iter()
            .find(|crew| crew.name == "Екіпаж без позиції")
            .unwrap();
        assert!(loose.note.contains(CREW_WITHOUT_POSITION_NOTE));
        assert!(loose.note.contains("Користувацька примітка екіпажу"));
        assert!(!imported
            .assignments
            .iter()
            .any(|assignment| assignment.crew_id == loose.id));
        let empty_position = imported
            .positions
            .iter()
            .find(|position| position.uav_type == "Бомбер")
            .unwrap();
        assert!(empty_position.note.contains(POSITION_WITHOUT_CREW_NOTE));
        assert!(empty_position
            .note
            .contains("Користувацька примітка позиції"));
        assert!(!imported
            .assignments
            .iter()
            .any(|assignment| assignment.position_id == empty_position.id));
    }

    #[test]
    fn rejects_workbooks_that_are_not_a_strips_export() {
        let directory = tempfile::tempdir().unwrap();
        let wrong_sheet = directory.path().join("wrong-sheet.xlsx");
        xlsx::write_styled_workbook(
            &wrong_sheet,
            "Інший аркуш",
            "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>",
            &strips_styles(),
            include_str!("../resources/bcs-reference-theme.xml"),
        )
        .unwrap();
        let error = import_strips_registry(wrong_sheet.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("Відсутній аркуш «Позиції по смугах»"));

        let wrong_layout = directory.path().join("wrong-layout.xlsx");
        xlsx::write_styled_workbook(
            &wrong_layout,
            SHEET_NAME,
            "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Чужий файл</t></is></c></row></sheetData></worksheet>",
            &strips_styles(),
            include_str!("../resources/bcs-reference-theme.xml"),
        )
        .unwrap();
        let error =
            import_strips_registry(wrong_layout.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("не є експортом «Позиції по смугах»"));
    }

    #[test]
    fn exports_each_crew_note_and_position_note_without_duplication() {
        let mut value = request("report.xlsx".into());
        value.separate_notes = true;
        let position = &mut value.strips[0].groups[0].positions[0];
        position.note = "Примітка позиції".into();
        position.crews[0].note = "Примітка екіпажу Альфа".into();
        position.crews[1].note = "Примітка екіпажу Браво".into();

        let prepared = prepare_request(value).unwrap();
        let sheet = build_sheet(&prepared, &calculate_summary(&prepared.strips));

        assert!(sheet.contains(
            "<c r=\"L6\" s=\"6\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Примітка екіпажу Альфа\nПримітка позиції</t></is></c>"
        ));
        assert!(sheet.contains(
            "<c r=\"L7\" s=\"6\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Примітка екіпажу Браво</t></is></c>"
        ));
        assert!(!sheet.contains("<mergeCell ref=\"L6:L7\"/>"));
        assert!(sheet
            .contains("<col min=\"13\" max=\"16\" width=\"0\" hidden=\"1\" customWidth=\"1\"/>"));
        assert!(sheet.contains(
            "<c r=\"M6\" s=\"6\" t=\"inlineStr\"><is><t xml:space=\"preserve\">__SUMMARYBCS_STRIPS_NOTES_V1__</t></is></c>"
        ));
        assert!(sheet.contains(
            "<c r=\"N6\" s=\"6\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Примітка екіпажу Альфа</t></is></c>"
        ));
        assert!(sheet.contains(
            "<c r=\"O6\" s=\"6\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Примітка позиції</t></is></c>"
        ));

        let empty_position = &prepared.strips[0].groups[1].positions[0];
        assert!(empty_position.crews.is_empty());
        assert!(sheet.contains(&empty_position.note));
    }

    #[test]
    fn note_metadata_round_trips_crew_and_position_notes_separately() {
        for separate_notes in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory
                .path()
                .join(format!("notes-{separate_notes}.xlsx"));
            let mut value = request(path.to_string_lossy().into_owned());
            value.separate_notes = separate_notes;
            let position = &mut value.strips[0].groups[0].positions[0];
            position.note = "Примітка позиції".into();
            position.crews[0].note = "Примітка екіпажу Альфа".into();
            position.crews[1].note = "Примітка екіпажу Браво".into();
            export_strips(value).unwrap();

            let imported = import_strips_registry(path.to_string_lossy().into_owned()).unwrap();
            let position = imported
                .positions
                .iter()
                .find(|position| position.uav_type == "ФПВ")
                .unwrap();
            assert_eq!(position.note, "Примітка позиції");
            assert_eq!(
                imported
                    .crews
                    .iter()
                    .find(|crew| crew.name == "Альфа")
                    .unwrap()
                    .note,
                "Примітка екіпажу Альфа"
            );
            assert_eq!(
                imported
                    .crews
                    .iter()
                    .find(|crew| crew.name == "Браво")
                    .unwrap()
                    .note,
                "Примітка екіпажу Браво"
            );
        }
    }

    #[test]
    fn edited_visible_note_invalidates_hidden_note_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("edited-note.xlsx");
        let mut value = request(path.to_string_lossy().into_owned());
        value.separate_notes = true;
        let position = &mut value.strips[0].groups[0].positions[0];
        position.note = "Примітка позиції".into();
        position.crews[0].note = "Примітка екіпажу Альфа".into();
        position.crews[1].note = "Примітка екіпажу Браво".into();
        let prepared = prepare_request(value).unwrap();
        let sheet = build_sheet(&prepared, &calculate_summary(&prepared.strips));
        let original = "<c r=\"L6\" s=\"6\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Примітка екіпажу Альфа\nПримітка позиції</t></is></c>";
        let edited = "<c r=\"L6\" s=\"6\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Відредагована видима примітка</t></is></c>";
        assert!(sheet.contains(original));
        let sheet = sheet.replacen(original, edited, 1);
        xlsx::write_styled_workbook(
            &path,
            SHEET_NAME,
            &sheet,
            &strips_styles(),
            include_str!("../resources/bcs-reference-theme.xml"),
        )
        .unwrap();

        let imported = import_strips_registry(path.to_string_lossy().into_owned()).unwrap();
        let position = imported
            .positions
            .iter()
            .find(|position| position.uav_type == "ФПВ")
            .unwrap();
        assert_eq!(position.note, "Відредагована видима примітка");
        assert_eq!(
            imported
                .crews
                .iter()
                .find(|crew| crew.name == "Альфа")
                .unwrap()
                .note,
            ""
        );
        assert_eq!(
            imported
                .crews
                .iter()
                .find(|crew| crew.name == "Браво")
                .unwrap()
                .note,
            "Примітка екіпажу Браво"
        );
    }

    #[test]
    fn old_export_without_note_metadata_uses_the_existing_note_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("old-export.xlsx");
        let mut value = request(path.to_string_lossy().into_owned());
        value.separate_notes = true;
        let position = &mut value.strips[0].groups[0].positions[0];
        position.note = "Примітка позиції".into();
        position.crews[0].note = "Примітка екіпажу Альфа".into();
        let prepared = prepare_request(value).unwrap();
        let sheet = build_sheet(&prepared, &calculate_summary(&prepared.strips));
        let sheet = remove_cells_in_columns(sheet, &["M", "N", "O", "P"]);
        assert!(!sheet.contains(NOTE_METADATA_MARKER));
        xlsx::write_styled_workbook(
            &path,
            SHEET_NAME,
            &sheet,
            &strips_styles(),
            include_str!("../resources/bcs-reference-theme.xml"),
        )
        .unwrap();

        let imported = import_strips_registry(path.to_string_lossy().into_owned()).unwrap();
        let position = imported
            .positions
            .iter()
            .find(|position| position.uav_type == "ФПВ")
            .unwrap();
        assert_eq!(position.note, "Примітка екіпажу Альфа\nПримітка позиції");
        assert_eq!(
            imported
                .crews
                .iter()
                .find(|crew| crew.name == "Альфа")
                .unwrap()
                .note,
            ""
        );
    }

    #[test]
    fn registry_export_hides_unlinked_caption_but_keeps_exception_table() {
        let mut value = request("report.xlsx".into());
        value.hide_unlinked_summary_caption = true;

        let prepared = prepare_request(value).unwrap();
        let sheet = build_sheet(&prepared, &calculate_summary(&prepared.strips));

        assert!(!sheet.contains("ДОВІДКОВО: ЗАПИСИ БЕЗ ЗВ’ЯЗКУ"));
        assert!(sheet.contains("Екіпажів без позиції"));
        assert!(sheet.contains("Позицій без екіпажу"));
    }

    #[test]
    fn keeps_exactly_two_blank_rows_between_strips() {
        let mut value = request("report.xlsx".into());
        value.strips[0].groups.truncate(1);
        value.strips.push(WorkStrip {
            id: "strip-2".into(),
            name: "Смуга 2".into(),
            groups: vec![group(
                "group-4",
                "Саперний взвод",
                "НРК",
                vec![position(
                    "position-3",
                    vec![crew("crew-3", "Чарлі", "БГ", "")],
                )],
                Vec::new(),
            )],
        });
        let prepared = prepare_request(value).unwrap();
        let sheet = build_sheet(&prepared, &calculate_summary(&prepared.strips));

        assert_eq!(
            sheet
                .matches("<t xml:space=\"preserve\">Екіпажі</t>")
                .count(),
            2
        );
        assert!(sheet.contains("</row><row r=\"11\"/><row r=\"12\"/><row r=\"13\" ht=\"24\""));
    }

    #[test]
    fn merges_unit_and_uav_type_across_every_row_of_the_group() {
        let mut value = request("report.xlsx".into());
        value.strips[0].groups.truncate(1);
        value.strips[0].groups[0]
            .positions
            .push(position("position-extra", Vec::new()));
        value.strips[0].groups[0]
            .loose_crews
            .push(loose_crew("loose-extra"));
        let prepared = prepare_request(value).unwrap();
        let sheet = build_sheet(&prepared, &calculate_summary(&prepared.strips));

        assert!(sheet.contains("<mergeCell ref=\"A6:A9\"/>"));
        assert!(sheet.contains("<mergeCell ref=\"B6:B9\"/>"));
        assert!(sheet.contains("<mergeCell ref=\"G6:G7\"/>"));
        assert!(!sheet.contains("<mergeCell ref=\"G6:G9\"/>"));
    }

    #[test]
    fn merges_one_uav_type_across_consecutive_units() {
        let mut value = request("report.xlsx".into());
        value.strips[0].groups[1].uav_type = "ФПВ".into();
        value.strips[0].groups[1].unit = "2 РУБАК".into();
        let prepared = prepare_request(value).unwrap();
        let sheet = build_sheet(&prepared, &calculate_summary(&prepared.strips));

        assert!(sheet.contains("<mergeCell ref=\"A6:A7\"/>"));
        assert!(sheet.contains("<mergeCell ref=\"B6:B8\"/>"));
        assert!(!sheet.contains("<mergeCell ref=\"A6:A8\"/>"));
    }
}
