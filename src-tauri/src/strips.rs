use crate::xlsx;
use serde::Deserialize;
use std::{collections::HashSet, path::PathBuf};

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

const STYLE_TITLE: usize = 1;
const STYLE_SUBTITLE: usize = 2;
const STYLE_STRIP: usize = 3;
const STYLE_HEADER: usize = 4;
const STYLE_DATA_CENTER: usize = 5;
const STYLE_DATA_LEFT: usize = 6;
const STYLE_READY: usize = 7;
const STYLE_NOT_READY: usize = 8;
const STYLE_FORMING: usize = 9;
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

#[derive(Debug, Default, PartialEq, Eq)]
struct StripsSummary {
    crews: Vec<StatusSummaryRow>,
    positions: Vec<StatusSummaryRow>,
    crew_totals: StatusCounts,
    position_totals: StatusCounts,
    exceptions: Vec<ExceptionSummaryRow>,
    exception_totals: ExceptionCounts,
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

                positions.push(PreparedPosition {
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
                let crew = prepare_crew(
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
                    add_status(&mut crew_counts[type_index], &crew.readiness);
                }
            }
            for crew in &group.loose_crews {
                add_status(&mut crew_counts[type_index], &crew.crew.readiness);
                exception_counts[type_index].crews_without_position += 1;
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

fn build_sheet(report: &PreparedReport, summary: &StripsSummary) -> String {
    let mut rows = String::new();
    let mut merges = Vec::new();
    let mut row = 1usize;

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

        for group in &strip.groups {
            write_group(&mut rows, &mut merges, &mut row, group);
        }

        let strip_summary = calculate_summary(std::slice::from_ref(strip));
        write_strip_summary(&mut rows, row, &strip_summary);
        row += 3;
        push_blank_row(&mut rows, row);
        row += 1;
        push_blank_row(&mut rows, row);
        row += 1;
    }

    write_summary(&mut rows, &mut merges, &mut row, summary);
    let last_row = row.saturating_sub(1);
    let merge_xml = merges
        .iter()
        .map(|range| format!("<mergeCell ref=\"{range}\"/>"))
        .collect::<String>();

    format!(
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:L{last_row}\"/><sheetViews><sheetView showGridLines=\"0\" workbookViewId=\"0\"><pane ySplit=\"5\" topLeftCell=\"A6\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"18\"/><cols><col min=\"1\" max=\"1\" width=\"22\" customWidth=\"1\"/><col min=\"2\" max=\"2\" width=\"24\" customWidth=\"1\"/><col min=\"3\" max=\"3\" width=\"24\" customWidth=\"1\"/><col min=\"4\" max=\"4\" width=\"25\" customWidth=\"1\"/><col min=\"5\" max=\"5\" width=\"22\" customWidth=\"1\"/><col min=\"6\" max=\"6\" width=\"30\" customWidth=\"1\"/><col min=\"7\" max=\"7\" width=\"24\" customWidth=\"1\"/><col min=\"8\" max=\"8\" width=\"25\" customWidth=\"1\"/><col min=\"9\" max=\"9\" width=\"18\" customWidth=\"1\"/><col min=\"10\" max=\"10\" width=\"18\" customWidth=\"1\"/><col min=\"11\" max=\"11\" width=\"28\" customWidth=\"1\"/><col min=\"12\" max=\"12\" width=\"32\" customWidth=\"1\"/></cols><sheetData>{rows}</sheetData><mergeCells count=\"{}\">{merge_xml}</mergeCells><pageMargins left=\"0.2\" right=\"0.2\" top=\"0.3\" bottom=\"0.3\" header=\"0\" footer=\"0\"/><pageSetup paperSize=\"8\" orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>",
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

fn write_group(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    group: &PreparedGroup,
) {
    let group_start = *row;
    let group_rows = group
        .positions
        .iter()
        .map(|position| position.crews.len().max(1))
        .sum::<usize>()
        + group.loose_crews.len();
    let group_end = group_start + group_rows - 1;
    if group_rows > 1 {
        merges.push(format!("A{group_start}:A{group_end}"));
        merges.push(format!("B{group_start}:B{group_end}"));
    }

    let mut first_group_row = true;
    for position in &group.positions {
        let header = first_group_row.then_some((group.unit.as_str(), group.uav_type.as_str()));
        write_position(rows, merges, row, position, header);
        first_group_row = false;
    }
    for crew in &group.loose_crews {
        let header = first_group_row.then_some((group.unit.as_str(), group.uav_type.as_str()));
        write_loose_crew(rows, row, crew, header);
        first_group_row = false;
    }
}

fn write_position(
    rows: &mut String,
    merges: &mut Vec<String>,
    row: &mut usize,
    position: &PreparedPosition,
    group_header: Option<(&str, &str)>,
) {
    let start_row = *row;
    let row_count = position.crews.len().max(1);
    let end_row = start_row + row_count - 1;
    if row_count > 1 {
        for column in [6usize, 7, 8, 9, 10, 11] {
            let letter = column_name(column);
            merges.push(format!("{letter}{start_row}:{letter}{end_row}"));
        }
    } else if position.crews.is_empty() {
        merges.push(format!("C{start_row}:F{start_row}"));
    }
    let position_readiness = readiness_display(&position.readiness, &position.not_ready_reason);

    for offset in 0..row_count {
        let current_row = start_row + offset;
        let position_center = readiness_style(&position.readiness);
        let position_left = readiness_left_style(&position.readiness);
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

        let note = if first {
            position.note.clone()
        } else {
            String::new()
        };
        cells.push(text_cell(11, current_row, &note, STYLE_DATA_LEFT));
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
    row: &mut usize,
    value: &PreparedLooseCrew,
    group_header: Option<(&str, &str)>,
) {
    let current_row = *row;
    let crew = &value.crew;
    let (unit, uav_type) = group_header.unwrap_or(("", ""));
    let crew_readiness = readiness_display(&crew.readiness, &crew.not_ready_reason);
    let center_style = readiness_style(&crew.readiness);
    let left_style = readiness_left_style(&crew.readiness);
    let loose_note = crew.note.clone();
    let mut cells = vec![
        text_cell(0, current_row, unit, STYLE_DATA_CENTER),
        text_cell(1, current_row, uav_type, STYLE_DATA_CENTER),
        text_cell(2, current_row, &crew.name, center_style),
        text_cell(3, current_row, &crew_readiness, center_style),
        text_cell(4, current_row, &crew.duty, center_style),
        text_cell(5, current_row, &crew.assets, left_style),
    ];
    for column in 6..=10 {
        let value = if crew.readiness == "Формується" {
            "Формується"
        } else if column == 6 {
            "Екіпаж без позиції"
        } else {
            ""
        };
        cells.push(text_cell(
            column,
            current_row,
            value,
            if column == 10 {
                left_style
            } else {
                center_style
            },
        ));
    }
    cells.push(text_cell(11, current_row, &loose_note, STYLE_DATA_LEFT));
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
  <numFmts count="0"/>
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
  <cellXfs count="22">
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

    #[test]
    fn summary_counts_each_crew_once_and_reports_unlinked_entities() {
        let prepared = prepare_request(request("report.xlsx".into())).unwrap();
        let summary = calculate_summary(&prepared.strips);

        assert_eq!(summary.crews.len(), 2);
        assert_eq!(summary.crews[0].uav_type, "ФПВ");
        assert_eq!(
            summary.crew_totals,
            StatusCounts {
                ready: 0,
                not_ready: 2,
                forming: 1,
                total: 3,
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
        assert_eq!(summary.exception_totals.crews_without_position, 1);
        assert_eq!(summary.exception_totals.positions_without_crews, 1);
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
        assert!(sheet.matches("Формується").count() >= 7);
        assert!(sheet.contains("Показник"));
        assert!(sheet.contains("<t xml:space=\"preserve\">Екіпажі</t>"));
        assert!(sheet.contains("<t xml:space=\"preserve\">Позиції</t>"));
        assert!(sheet.contains("<c r=\"B11\" s=\"16\"><v>3</v></c>"));
        assert!(sheet.contains("<c r=\"D11\" s=\"8\"><v>2</v></c>"));
        assert!(sheet.contains("<c r=\"B12\" s=\"16\"><v>1</v></c>"));
        assert!(sheet.contains("<c r=\"D12\" s=\"8\"><v>1</v></c>"));
        assert!(sheet.contains("Екіпажі за типом БпЛА"));
        assert!(sheet.contains("ДОВІДКОВО: ЗАПИСИ БЕЗ ЗВ’ЯЗКУ"));
        assert!(!sheet.contains("НЕ ВХОДЯТЬ В ОСНОВНИЙ ПІДСУМОК"));
        assert!(sheet.contains("<col min=\"11\" max=\"11\" width=\"28\""));
        assert!(!styles.contains("horizontal=\"left\""));
        assert!(styles.contains("rgb=\"FFD7E48D\""));
        assert!(styles.contains("rgb=\"FFE6B8B7\""));
        assert!(styles.contains("rgb=\"FFFDEADA\""));
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
}
