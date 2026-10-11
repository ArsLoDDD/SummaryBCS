use crate::xlsx::{self, Cell, SheetRow};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

#[derive(Debug, Clone, Deserialize)]
struct Schema {
    headers: Vec<String>,
    widths: Vec<f64>,
    locations: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct BcsRow {
    is_temporary: bool,
    is_external: bool,
    color_key: String,
    group_key: String,
    section: String,
    position_name: String,
    battle_order: String,
    sector: String,
    crew_name: String,
    crew_actual: String,
    crew_official: String,
    crew_status: String,
    uav_name: String,
    uav_type: String,
    personnel_position: String,
    rank: String,
    full_name: String,
    duties: String,
    location: String,
    notes: String,
}

impl BcsRow {
    fn values(&self) -> [&str; 16] {
        [
            &self.section,
            &self.position_name,
            &self.battle_order,
            &self.sector,
            &self.crew_name,
            &self.crew_actual,
            &self.crew_official,
            &self.crew_status,
            &self.uav_name,
            &self.uav_type,
            &self.personnel_position,
            &self.rank,
            &self.full_name,
            &self.duties,
            &self.location,
            &self.notes,
        ]
    }
}

#[derive(Debug, Clone)]
struct ParsedBcs {
    id: String,
    path: PathBuf,
    file_name: String,
    unit_name: String,
    date: String,
    is_summary: bool,
    authorized_strength: i64,
    rows: Vec<BcsRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitPreview {
    id: String,
    path: String,
    file_name: String,
    unit_name: String,
    date: String,
    row_count: usize,
    personnel_count: usize,
    authorized_strength: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    date: String,
    total_rows: usize,
    total_personnel: usize,
    units: Vec<UnitPreview>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    paths: Vec<String>,
    unit_order: Vec<String>,
    output_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRequest {
    before_paths: Vec<String>,
    after_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonMetric {
    label: String,
    before: i64,
    after: i64,
    delta: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonSection {
    title: String,
    rows: Vec<ComparisonMetric>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersonnelChange {
    kind: String,
    person_name: String,
    details: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonResult {
    scope: String,
    title: String,
    before_date: String,
    after_date: String,
    before_unit_count: usize,
    after_unit_count: usize,
    highlights: Vec<String>,
    headline: Vec<ComparisonMetric>,
    sections: Vec<ComparisonSection>,
    unit_changes: Vec<String>,
    personnel_changes: Vec<PersonnelChange>,
    has_changes: bool,
}

const ABSENT_LOCATIONS: [&str; 8] = [
    "ВІДП",
    "ЛІК",
    "ВЛК",
    "НАВЧ",
    "ВІДР",
    "Відкомандировані",
    "СЗЧ",
    "ПТЗ Новостав",
];

#[derive(Debug, Clone, PartialEq)]
struct UnitAnalytics {
    unit_name: String,
    authorized: i64,
    listed: i64,
    present: i64,
    staffing_percent: f64,
    deficit: i64,
    presence_percent: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct AnalyticsData {
    units: Vec<UnitAnalytics>,
    absence_reasons: Vec<(String, i64)>,
    crew_statuses: Vec<(String, i64)>,
    crew_types: Vec<(String, i64)>,
    locations: Vec<(String, i64)>,
}

#[derive(Debug, Clone)]
struct ChartSeries {
    name: String,
    value_column: String,
    values: Vec<f64>,
}

#[derive(Debug, Clone)]
struct ChartSpec {
    title: String,
    category_column: String,
    first_row: usize,
    last_row: usize,
    categories: Vec<String>,
    series: Vec<ChartSeries>,
    horizontal: bool,
    percent_axis: bool,
    from_col: usize,
    from_row: usize,
    to_col: usize,
    to_row: usize,
}

fn schema() -> Result<Schema, String> {
    serde_json::from_str(include_str!("../../src/shared/bcs-schema.json"))
        .map_err(|_| "Вбудована схема БЧС пошкоджена.".to_string())
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn cell(row: &SheetRow, column: usize) -> &Cell {
    static EMPTY: std::sync::OnceLock<Cell> = std::sync::OnceLock::new();
    row.cells
        .get(column)
        .unwrap_or_else(|| EMPTY.get_or_init(Cell::default))
}

fn authorized_strength_from_rows(
    sheet_rows: &[SheetRow],
    authorized_row: &SheetRow,
    file_name: &str,
) -> Result<i64, String> {
    let label_column = authorized_row
        .cells
        .iter()
        .position(|value| normalize(&value.value) == "по штату")
        .ok_or_else(|| format!("«{file_name}»: у підсумку відсутнє значення «По штату»."))?;
    let summary_value = cell(authorized_row, label_column + 1);
    if !summary_value.has_formula {
        return parse_integer(&summary_value.value, "Значення «По штату»");
    }

    // The universal template links its summary to the yellow H3 input cell.
    // We never execute that formula. We read only the directly stored number
    // from H3 and still reject a formula or missing value there.
    let top_input = sheet_rows
        .iter()
        .find(|row| row.number == 3)
        .map(|row| cell(row, 7))
        .ok_or_else(|| {
            format!(
                "«{file_name}»: формула «По штату» дозволена лише для шаблону з прямим числом у H3."
            )
        })?;
    if top_input.has_formula || top_input.value.trim().is_empty() {
        return Err(format!(
            "«{file_name}»: у H3 має бути збережене число «По штату», а не формула."
        ));
    }
    parse_integer(&top_input.value, "Значення «По штату» у H3")
}

fn valid_date(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() != 2 || parts[1].len() != 2 || parts[2].len() != 4 {
        return false;
    }
    let Ok(day) = parts[0].parse::<u8>() else {
        return false;
    };
    let Ok(month) = parts[1].parse::<u8>() else {
        return false;
    };
    let Ok(year) = parts[2].parse::<u16>() else {
        return false;
    };
    (1..=31).contains(&day) && (1..=12).contains(&month) && year >= 2000
}

fn date_from_title(title: &str) -> Option<String> {
    let marker = "станом на 08:00 год ";
    let tail = title.split_once(marker)?.1;
    let date = tail.split_once(" року").map(|(date, _)| date.trim())?;
    valid_date(date).then(|| date.to_string())
}

fn parse_integer(value: &str, label: &str) -> Result<i64, String> {
    let trimmed = value.trim();
    let parsed = if let Ok(integer) = trimmed.parse::<i64>() {
        integer
    } else if let Ok(number) = trimmed.parse::<f64>() {
        if number.fract() != 0.0 || !number.is_finite() || number > i64::MAX as f64 {
            return Err(format!("{label} має бути цілим числом."));
        }
        number as i64
    } else {
        return Err(format!("{label} має бути цілим числом."));
    };
    if parsed < 0 {
        return Err(format!("{label} не може бути від’ємним."));
    }
    Ok(parsed)
}

fn nonnegative_count(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Ok(());
    }
    parse_integer(value, label).map(|_| ())
}

fn color_key(style: Option<usize>, section: &str, crew_status: &str) -> String {
    if normalize(section) == normalize("Інші") {
        return "unassigned".into();
    }
    match style {
        Some(171) => return "crew-working".into(),
        Some(172) => return "crew-forming".into(),
        Some(173) => return "crew-inactive".into(),
        Some(174) => return "company-management".into(),
        Some(175) => return "platoon-management".into(),
        Some(176) => return "independent".into(),
        Some(177) => return "unassigned".into(),
        Some(178) => return "attached".into(),
        Some(179) => return "temporary".into(),
        _ => {}
    }
    let section_lower = section.to_lowercase();
    let status = crew_status.to_lowercase().replace(' ', "");
    if section == "Екіпаж" && status.starts_with("прац") {
        "crew-working".into()
    } else if section == "Екіпаж" && status.starts_with("форм") {
        "crew-forming".into()
    } else if section == "Екіпаж" {
        "crew-inactive".into()
    } else if section_lower.contains("управління роти") {
        "company-management".into()
    } else if section_lower.contains("управління взводу") {
        "platoon-management".into()
    } else if section == "Прикомандировані" || section == "Оперативне підпорядкування"
    {
        "attached".into()
    } else if section == "Тимчасово прибулі" {
        "temporary".into()
    } else {
        "independent".into()
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|_| "Не вдалося прочитати файл.".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn parse_file(path: &Path) -> Result<ParsedBcs, String> {
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
    let metadata = fs::metadata(path).map_err(|_| format!("«{file_name}»: файл недоступний."))?;
    if !metadata.is_file() {
        return Err(format!("«{file_name}»: обраний шлях не є файлом."));
    }
    if metadata.len() > xlsx::MAX_ARCHIVE_BYTES {
        return Err(format!("«{file_name}»: файл перевищує 25 МБ."));
    }

    let id = hash_file(path).map_err(|message| format!("«{file_name}»: {message}"))?;
    let file = File::open(path).map_err(|_| format!("«{file_name}»: не вдалося відкрити файл."))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| format!("«{file_name}»: пошкоджений або невалідний XLSX."))?;
    xlsx::validate_archive(&mut archive).map_err(|message| format!("«{file_name}»: {message}"))?;
    let sheet_rows = xlsx::read_bcs_sheet(&mut archive)
        .map_err(|message| format!("«{file_name}»: {message}"))?;

    let title = sheet_rows
        .iter()
        .find(|row| row.number == 1)
        .map(|row| cell(row, 0).value.trim().to_string())
        .unwrap_or_default();
    let is_summary = normalize(&title).starts_with("зведений бчс");
    let date = date_from_title(&title)
        .ok_or_else(|| format!("«{file_name}»: не вдалося визначити дату з заголовка БЧС."))?;
    let unit_row = sheet_rows
        .iter()
        .find(|row| row.number == 6)
        .ok_or_else(|| format!("«{file_name}»: не вдалося визначити назву підрозділу."))?;
    let unit_cell = cell(unit_row, 0);
    let unit_name = if unit_cell.has_formula {
        let top_input = sheet_rows
            .iter()
            .find(|row| row.number == 3)
            .map(|row| cell(row, 1))
            .filter(|value| !value.has_formula)
            .ok_or_else(|| {
                format!(
                    "«{file_name}»: формула назви підрозділу дозволена лише з прямим текстом у B3."
                )
            })?;
        top_input.value.trim().to_string()
    } else {
        unit_cell.value.trim().to_string()
    };
    let unit_name = Some(unit_name)
        .filter(|value| !value.is_empty() && normalize(value) != "вкажіть назву")
        .ok_or_else(|| format!("«{file_name}»: не вдалося визначити назву підрозділу."))?;

    let schema = schema()?;
    let header = sheet_rows
        .iter()
        .find(|row| row.number == 4)
        .ok_or_else(|| format!("«{file_name}»: відсутній рядок заголовків."))?;
    for (index, expected) in schema.headers.iter().enumerate() {
        let actual = cell(header, index).value.trim();
        if normalize(actual) != normalize(expected) {
            return Err(format!(
                "«{file_name}»: колонка {} має називатися «{}», знайдено «{}».",
                index + 1,
                expected.replace('\n', " "),
                actual.replace('\n', " ")
            ));
        }
    }

    let mut carry = vec![String::new(); 10];
    let mut rows = Vec::new();
    let mut group_number = 0usize;
    for (expected_row_number, source) in
        (7usize..).zip(sheet_rows.iter().filter(|row| row.number >= 7))
    {
        if source.number != expected_row_number {
            break;
        }
        let raw_values = (0..16)
            .map(|index| cell(source, index).value.trim().to_string())
            .collect::<Vec<_>>();
        if raw_values.iter().all(String::is_empty) {
            break;
        }
        // Column F in files created by our template generator is a safe COUNTA
        // helper.  It is never evaluated here: after parsing we calculate the
        // actual crew count from the non-empty P.I.B. cells ourselves.  Every
        // other formula in the input table remains forbidden.
        if (0..16).any(|index| index != 5 && cell(source, index).has_formula) {
            return Err(format!(
                "«{file_name}»: у рядку {} основної таблиці знайдено формулу; такий файл не імпортується.",
                source.number
            ));
        }
        // Generated templates repeat column A on each physical person row so
        // summary formulas can work without hidden helper columns.  B:J still
        // mark the first row of a logical structure block.
        let starts_group = rows.is_empty()
            || raw_values[1..10].iter().any(|value| !value.is_empty())
            || (!raw_values[0].is_empty() && normalize(&raw_values[0]) != normalize(&carry[0]));
        if starts_group {
            group_number += 1;
            // Empty B:J cells on the first row of a new block are intentional.
            // Never inherit crew metadata (status, type, counts, etc.) from the
            // preceding block across this boundary.
            carry.fill(String::new());
        }
        let mut values = raw_values;
        for index in 0..10 {
            if values[index].is_empty() {
                values[index] = carry[index].clone();
            } else {
                carry[index] = values[index].clone();
            }
        }
        nonnegative_count(&values[5], "Кількість в/с, що працює в екіпажі")?;
        nonnegative_count(&values[6], "Кількість в/с за штатом")?;
        let style = source.cells.iter().find_map(|value| value.style);
        let section = values[0].clone();
        let crew_status = values[7].clone();
        let full_name = values[12].to_uppercase();
        rows.push(BcsRow {
            is_temporary: section == "Тимчасово прибулі",
            is_external: matches!(
                section.as_str(),
                "Прикомандировані" | "Оперативне підпорядкування" | "Тимчасово прибулі"
            ),
            color_key: color_key(style, &section, &crew_status),
            group_key: format!("{}:{group_number}", &id[..16]),
            section,
            position_name: values[1].to_uppercase(),
            battle_order: values[2].to_uppercase(),
            sector: values[3].to_uppercase(),
            crew_name: values[4].to_uppercase(),
            crew_actual: values[5].clone(),
            crew_official: values[6].clone(),
            crew_status,
            uav_name: values[8].clone(),
            uav_type: values[9].clone(),
            personnel_position: values[10].clone(),
            rank: values[11].clone(),
            full_name,
            duties: values[13].clone(),
            location: values[14].clone(),
            notes: values[15].clone(),
        });
    }
    if rows.is_empty() {
        return Err(format!("«{file_name}»: основна таблиця БЧС порожня."));
    }

    let authorized_row = sheet_rows
        .iter()
        .find(|row| {
            row.cells
                .iter()
                .any(|value| normalize(&value.value) == "по штату")
        })
        .ok_or_else(|| format!("«{file_name}»: у підсумку відсутнє значення «По штату»."))?;
    let authorized_strength =
        authorized_strength_from_rows(&sheet_rows, authorized_row, &file_name)?;

    Ok(ParsedBcs {
        id,
        path: path.to_path_buf(),
        file_name,
        unit_name,
        date,
        is_summary,
        authorized_strength,
        rows,
    })
}

fn parse_date_group(
    paths: &[PathBuf],
    minimum_files: usize,
    empty_message: &str,
) -> Result<Vec<ParsedBcs>, String> {
    if paths.len() < minimum_files {
        return Err(empty_message.into());
    }
    let mut parsed: Vec<ParsedBcs> = Vec::with_capacity(paths.len());
    let mut file_ids = HashSet::new();
    let mut units = HashSet::new();
    let mut expected_date: Option<String> = None;
    for path in paths {
        let item = parse_file(path)?;
        if !file_ids.insert(item.id.clone()) {
            return Err(format!(
                "Файл «{}» дублює вже доданий файл.",
                item.file_name
            ));
        }
        if !units.insert(normalize(&item.unit_name)) {
            return Err(format!(
                "Підрозділ «{}» трапляється у кількох файлах.",
                item.unit_name
            ));
        }
        if let Some(date) = &expected_date {
            if date != &item.date {
                return Err(format!(
                    "Не можна об’єднати БЧС за різні дати: «{}» — {}, а «{}» — {}.",
                    parsed[0].file_name, date, item.file_name, item.date
                ));
            }
        } else {
            expected_date = Some(item.date.clone());
        }
        parsed.push(item);
    }
    Ok(parsed)
}

fn parse_collection(paths: &[PathBuf]) -> Result<Vec<ParsedBcs>, String> {
    parse_date_group(paths, 2, "Оберіть щонайменше два файли БЧС.")
}

pub fn preview_files(paths: &[PathBuf]) -> Result<ImportPreview, String> {
    let parsed = parse_collection(paths)?;
    let date = parsed[0].date.clone();
    let total_rows = parsed.iter().map(|item| item.rows.len()).sum();
    let total_personnel = parsed
        .iter()
        .flat_map(|item| &item.rows)
        .filter(|row| !row.full_name.trim().is_empty())
        .count();
    let units = parsed
        .into_iter()
        .map(|item| UnitPreview {
            id: item.id,
            path: item.path.to_string_lossy().into_owned(),
            file_name: item.file_name,
            unit_name: item.unit_name,
            date: item.date,
            row_count: item.rows.len(),
            personnel_count: item
                .rows
                .iter()
                .filter(|row| !row.full_name.trim().is_empty())
                .count(),
            authorized_strength: item.authorized_strength,
        })
        .collect();
    Ok(ImportPreview {
        date,
        total_rows,
        total_personnel,
        units,
    })
}

pub fn export_request(request: ExportRequest) -> Result<String, String> {
    let paths = request.paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    let parsed = parse_collection(&paths)?;
    if parsed.len() != request.unit_order.len() {
        return Err("Список підрозділів для експорту неповний.".into());
    }
    let mut by_id = parsed
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::with_capacity(request.unit_order.len());
    for id in &request.unit_order {
        let item = by_id.remove(id).ok_or_else(|| {
            "Порядок підрозділів містить невідомий або повторений файл.".to_string()
        })?;
        ordered.push(item);
    }
    if !by_id.is_empty() {
        return Err("Порядок підрозділів не містить усіх файлів.".into());
    }

    let output = PathBuf::from(&request.output_path);
    if output
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        return Err("Файл зведення повинен мати розширення .xlsx.".into());
    }
    if paths.iter().any(|input| input == &output) {
        return Err("Не можна перезаписати один із вхідних файлів.".into());
    }
    export_workbook(&output, &ordered)?;
    Ok(output.to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Default)]
struct ComparisonPerson {
    unit_name: String,
    section: String,
    rank: String,
    position: String,
    location: String,
}

#[derive(Debug, Clone, Default)]
struct ComparisonSnapshot {
    authorized: i64,
    listed: i64,
    present: i64,
    total_personnel: i64,
    absences: BTreeMap<String, i64>,
    crews: BTreeMap<String, i64>,
    locations: BTreeMap<String, i64>,
    people: BTreeMap<String, ComparisonPerson>,
    units: BTreeMap<String, ComparisonUnitSnapshot>,
}

#[derive(Debug, Clone, Default)]
struct ComparisonUnitSnapshot {
    name: String,
    authorized: Option<i64>,
    listed: i64,
    present: i64,
}

fn metric(label: impl Into<String>, before: i64, after: i64) -> ComparisonMetric {
    ComparisonMetric {
        label: label.into(),
        before,
        after,
        delta: after - before,
    }
}

fn snapshot(units: &[ParsedBcs], locations: &[String]) -> Result<ComparisonSnapshot, String> {
    let mut result = ComparisonSnapshot::default();
    let configured_locations = locations.iter().cloned().collect::<HashSet<_>>();

    for unit in units {
        result.authorized = result
            .authorized
            .checked_add(unit.authorized_strength)
            .ok_or_else(|| "Сума штатної чисельності завелика.".to_string())?;

        let personnel = unit
            .rows
            .iter()
            .filter(|row| !row.full_name.trim().is_empty())
            .collect::<Vec<_>>();
        let own = personnel.iter().filter(|row| !row.is_external).count() as i64;
        let temporary_acting = personnel
            .iter()
            .filter(|row| row.is_temporary && row.personnel_position.to_uppercase().contains("ТВО"))
            .count() as i64;
        let listed = own
            .checked_add(temporary_acting)
            .ok_or_else(|| "Чисельність підрозділу завелика.".to_string())?;
        let present = personnel
            .iter()
            .filter(|row| !row.is_external && !ABSENT_LOCATIONS.contains(&row.location.as_str()))
            .count() as i64;

        result.listed += listed;
        result.present += present;
        result.total_personnel += personnel.len() as i64;
        if unit.is_summary {
            let mut grouped = BTreeMap::<String, Vec<&BcsRow>>::new();
            let mut current_unit_name = String::new();
            for row in &unit.rows {
                if !row.section.trim().is_empty()
                    && row.values()[1..]
                        .iter()
                        .all(|value| value.trim().is_empty())
                {
                    current_unit_name = row.section.clone();
                    continue;
                }
                if !current_unit_name.is_empty() {
                    grouped
                        .entry(current_unit_name.clone())
                        .or_default()
                        .push(row);
                }
            }
            for (name, rows) in grouped {
                let personnel = rows
                    .into_iter()
                    .filter(|row| !row.full_name.trim().is_empty())
                    .collect::<Vec<_>>();
                let own = personnel.iter().filter(|row| !row.is_external).count() as i64;
                let temporary_acting = personnel
                    .iter()
                    .filter(|row| {
                        row.is_temporary && row.personnel_position.to_uppercase().contains("ТВО")
                    })
                    .count() as i64;
                let present = personnel
                    .iter()
                    .filter(|row| {
                        !row.is_external && !ABSENT_LOCATIONS.contains(&row.location.as_str())
                    })
                    .count() as i64;
                result.units.insert(
                    normalize(&name),
                    ComparisonUnitSnapshot {
                        name,
                        authorized: None,
                        listed: own + temporary_acting,
                        present,
                    },
                );
            }
        } else {
            result.units.insert(
                normalize(&unit.unit_name),
                ComparisonUnitSnapshot {
                    name: unit.unit_name.clone(),
                    authorized: Some(unit.authorized_strength),
                    listed,
                    present,
                },
            );
        }

        let mut current_unit_name = unit.unit_name.clone();
        for row in &unit.rows {
            if unit.is_summary
                && !row.section.trim().is_empty()
                && row.values()[1..]
                    .iter()
                    .all(|value| value.trim().is_empty())
            {
                current_unit_name = row.section.clone();
                continue;
            }
            if row.full_name.trim().is_empty() {
                continue;
            }
            let location = if configured_locations.contains(&row.location) {
                row.location.clone()
            } else {
                "Не вказано / інше".into()
            };
            *result.locations.entry(location).or_default() += 1;
            result
                .people
                .entry(normalize(&row.full_name))
                .or_insert_with(|| ComparisonPerson {
                    unit_name: current_unit_name.clone(),
                    section: row.section.clone(),
                    rank: row.rank.clone(),
                    position: row.personnel_position.clone(),
                    location: row.location.clone(),
                });
        }
    }

    let all_personnel = units
        .iter()
        .flat_map(|unit| &unit.rows)
        .filter(|row| !row.full_name.trim().is_empty())
        .collect::<Vec<_>>();
    let count_own_location = |location: &str| {
        all_personnel
            .iter()
            .filter(|row| !row.is_external && row.location == location)
            .count() as i64
    };
    let temporary_acting = all_personnel
        .iter()
        .filter(|row| row.is_temporary && row.personnel_position.to_uppercase().contains("ТВО"))
        .count() as i64;
    for (label, count) in [
        ("Відпустка", count_own_location("ВІДП")),
        (
            "Шпиталь",
            count_own_location("ЛІК") + count_own_location("ВЛК"),
        ),
        (
            "Відрядження",
            count_own_location("НАВЧ") + count_own_location("ВІДР"),
        ),
        ("Відкомандировані", count_own_location("Відкомандировані")),
        (
            "Прикомандировані",
            all_personnel
                .iter()
                .filter(|row| row.section == "Прикомандировані")
                .count() as i64,
        ),
        (
            "Оперативне підпорядкування",
            all_personnel
                .iter()
                .filter(|row| row.section == "Оперативне підпорядкування")
                .count() as i64,
        ),
        ("ПТЗ Новостав", count_own_location("ПТЗ Новостав")),
        ("СЗЧ", count_own_location("СЗЧ")),
        (
            "Тимчасово прибулі",
            all_personnel.iter().filter(|row| row.is_temporary).count() as i64,
        ),
        ("Тимчасово прибулі з ТВО", temporary_acting),
    ] {
        result.absences.insert(label.into(), count);
    }

    let crew_starts = crew_group_starts(units)
        .into_iter()
        .filter(|row| row.section == "Екіпаж" && !row.crew_name.trim().is_empty())
        .collect::<Vec<_>>();
    let crew_personnel = all_personnel
        .iter()
        .filter(|row| row.section == "Екіпаж")
        .map(|row| normalize(&row.full_name))
        .collect::<HashSet<_>>()
        .len() as i64;
    result
        .crews
        .insert("Особового складу в екіпажах".into(), crew_personnel);
    result
        .crews
        .insert("Екіпажів загалом".into(), crew_starts.len() as i64);
    for (label, group) in [
        ("Формуються", "forming"),
        ("Працюючі", "working"),
        ("Не активні", "inactive"),
    ] {
        result.crews.insert(
            label.into(),
            crew_starts
                .iter()
                .filter(|row| crew_status_group(&row.crew_status) == group)
                .count() as i64,
        );
    }
    for crew in crew_starts {
        let kind = crew.uav_type.trim();
        if !kind.is_empty() {
            *result
                .crews
                .entry(format!("Екіпажів — {kind}"))
                .or_default() += 1;
        }
    }

    Ok(result)
}

fn changed_map_rows(
    before: &BTreeMap<String, i64>,
    after: &BTreeMap<String, i64>,
) -> Vec<ComparisonMetric> {
    before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|label| {
            let previous = *before.get(&label).unwrap_or(&0);
            let current = *after.get(&label).unwrap_or(&0);
            (previous != current).then(|| metric(label, previous, current))
        })
        .collect()
}

fn delta_phrase(label: &str, before: i64, after: i64) -> Option<String> {
    let delta = after - before;
    if delta == 0 {
        None
    } else if delta > 0 {
        Some(format!(
            "{label}: стало на {delta} більше ({before} → {after})."
        ))
    } else {
        Some(format!(
            "{label}: стало на {} менше ({before} → {after}).",
            delta.unsigned_abs()
        ))
    }
}

fn comparison_personnel_changes(
    before: &ComparisonSnapshot,
    after: &ComparisonSnapshot,
) -> Vec<PersonnelChange> {
    let mut changes = Vec::new();
    for (key, person) in &after.people {
        if !before.people.contains_key(key) {
            let details = format!(
                "Додано: {} · {} · {}",
                person.unit_name,
                if person.rank.is_empty() {
                    "звання не вказано"
                } else {
                    &person.rank
                },
                if person.location.is_empty() {
                    "місце не вказано"
                } else {
                    &person.location
                }
            );
            changes.push(PersonnelChange {
                kind: "added".into(),
                person_name: key.to_uppercase(),
                details,
            });
        }
    }
    for (key, person) in &before.people {
        if !after.people.contains_key(key) {
            changes.push(PersonnelChange {
                kind: "removed".into(),
                person_name: key.to_uppercase(),
                details: format!("Вибув: {} · {}", person.unit_name, person.location),
            });
        }
    }
    for (key, previous) in &before.people {
        let Some(current) = after.people.get(key) else {
            continue;
        };
        let mut details = Vec::new();
        if previous.unit_name != current.unit_name {
            details.push(format!(
                "Підрозділ: {} → {}",
                previous.unit_name, current.unit_name
            ));
        }
        if previous.location != current.location {
            let from = if previous.location.is_empty() {
                "не вказано"
            } else {
                &previous.location
            };
            let to = if current.location.is_empty() {
                "не вказано"
            } else {
                &current.location
            };
            details.push(format!("Де знаходиться: {from} → {to}"));
        }
        if previous.section != current.section {
            details.push(format!("Блок: {} → {}", previous.section, current.section));
        }
        if previous.rank != current.rank {
            details.push(format!("Звання: {} → {}", previous.rank, current.rank));
        }
        if previous.position != current.position {
            details.push(format!(
                "Посада: {} → {}",
                previous.position, current.position
            ));
        }
        if !details.is_empty() {
            changes.push(PersonnelChange {
                kind: "changed".into(),
                person_name: key.to_uppercase(),
                details: details.join("; "),
            });
        }
    }
    changes.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then(left.person_name.cmp(&right.person_name))
    });
    changes
}

fn compare_parsed(before: &[ParsedBcs], after: &[ParsedBcs]) -> Result<ComparisonResult, String> {
    if before.is_empty() || after.is_empty() {
        return Err("Додайте БЧС для обох дат.".into());
    }
    if before[0].date == after[0].date {
        return Err("Для порівняння оберіть БЧС за дві різні дати.".into());
    }
    let before_summary = before.len() == 1 && before[0].is_summary;
    let after_summary = after.len() == 1 && after[0].is_summary;
    if before_summary != after_summary {
        return Err(
            "Порівнюйте однаковий формат: два БЧС одного підрозділу або два загальні БЧС.".into(),
        );
    }
    let single_unit = before.len() == 1 && after.len() == 1 && !before_summary;
    if single_unit && normalize(&before[0].unit_name) != normalize(&after[0].unit_name) {
        return Err(format!(
            "Для порівняння одного підрозділу оберіть той самий підрозділ за обидві дати: «{}» і «{}» не збігаються.",
            before[0].unit_name, after[0].unit_name
        ));
    }
    let duplicate = before
        .iter()
        .any(|left| after.iter().any(|right| left.id == right.id));
    if duplicate {
        return Err("Один і той самий файл не можна використати для обох дат.".into());
    }

    let schema = schema()?;
    let previous = snapshot(before, &schema.locations)?;
    let current = snapshot(after, &schema.locations)?;
    let headline = vec![
        metric("По штату", previous.authorized, current.authorized),
        metric("По списку", previous.listed, current.listed),
        metric("В наявності", previous.present, current.present),
        metric(
            "Усього людей у таблиці",
            previous.total_personnel,
            current.total_personnel,
        ),
    ];
    let mut highlights = headline
        .iter()
        .filter_map(|row| delta_phrase(&row.label, row.before, row.after))
        .collect::<Vec<_>>();
    if highlights.is_empty() {
        highlights.push("Основні показники не змінилися.".into());
    }

    let sections = [
        (
            "Причини відсутності",
            changed_map_rows(&previous.absences, &current.absences),
        ),
        ("Екіпажі", changed_map_rows(&previous.crews, &current.crews)),
        (
            "Де знаходиться",
            changed_map_rows(&previous.locations, &current.locations),
        ),
    ]
    .into_iter()
    .filter_map(|(title, rows)| {
        (!rows.is_empty()).then(|| ComparisonSection {
            title: title.into(),
            rows,
        })
    })
    .collect::<Vec<_>>();

    let mut unit_changes = Vec::new();
    for key in previous
        .units
        .keys()
        .chain(current.units.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
    {
        match (previous.units.get(&key), current.units.get(&key)) {
            (None, Some(unit)) => {
                let authorized = unit
                    .authorized
                    .map(|value| format!("по штату {value}, "))
                    .unwrap_or_default();
                unit_changes.push(format!(
                    "Додано підрозділ «{}»: {authorized}по списку {}, в наявності {}.",
                    unit.name, unit.listed, unit.present
                ));
            }
            (Some(unit), None) => {
                unit_changes.push(format!("Відсутній у новому БЧС підрозділ «{}».", unit.name))
            }
            (Some(old), Some(new)) => {
                let mut parts = Vec::new();
                if let (Some(old_authorized), Some(new_authorized)) =
                    (old.authorized, new.authorized)
                {
                    if old_authorized != new_authorized {
                        parts.push(format!("по штату {old_authorized} → {new_authorized}"));
                    }
                }
                if old.listed != new.listed {
                    parts.push(format!("по списку {} → {}", old.listed, new.listed));
                }
                if old.present != new.present {
                    parts.push(format!("в наявності {} → {}", old.present, new.present));
                }
                if !parts.is_empty() {
                    unit_changes.push(format!("{}: {}.", old.name, parts.join(", ")));
                }
            }
            (None, None) => {}
        }
    }

    let personnel_changes = comparison_personnel_changes(&previous, &current);
    let headline_changed = headline.iter().any(|row| row.delta != 0);
    let has_changes = headline_changed
        || !sections.is_empty()
        || !unit_changes.is_empty()
        || !personnel_changes.is_empty();
    let title = if single_unit {
        before[0].unit_name.clone()
    } else {
        "Загальний БЧС".into()
    };

    Ok(ComparisonResult {
        scope: if single_unit { "unit" } else { "general" }.into(),
        title,
        before_date: before[0].date.clone(),
        after_date: after[0].date.clone(),
        before_unit_count: before.len(),
        after_unit_count: after.len(),
        highlights,
        headline,
        sections,
        unit_changes,
        personnel_changes,
        has_changes,
    })
}

pub fn compare_request(request: ComparisonRequest) -> Result<ComparisonResult, String> {
    let before_paths = request
        .before_paths
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let after_paths = request
        .after_paths
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let before = parse_date_group(
        &before_paths,
        1,
        "Додайте один або кілька файлів БЧС для першої дати.",
    )?;
    let after = parse_date_group(
        &after_paths,
        1,
        "Додайте один або кілька файлів БЧС для другої дати.",
    )?;
    compare_parsed(&before, &after)
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn column(index: usize) -> char {
    (b'A' + index as u8) as char
}

fn text_cell(column_index: usize, row: usize, value: &str, style: usize) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
        column(column_index),
        esc(value)
    )
}

fn number_cell(column_index: usize, row: usize, value: i64, style: usize) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\"><v>{value}</v></c>",
        column(column_index)
    )
}

fn decimal_cell(column_index: usize, row: usize, value: f64, style: usize) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\"><v>{value:.1}</v></c>",
        column(column_index)
    )
}

fn crew_group_starts(units: &[ParsedBcs]) -> Vec<&BcsRow> {
    let mut starts = Vec::new();
    for unit in units {
        let mut previous = "";
        for row in &unit.rows {
            if row.group_key != previous {
                starts.push(row);
                previous = &row.group_key;
            }
        }
    }
    starts
}

fn crew_status_group(status: &str) -> &'static str {
    let normalized = status.to_lowercase().replace(' ', "");
    if normalized.starts_with("форм") {
        "forming"
    } else if normalized.starts_with("прац") || normalized == "активний" {
        "working"
    } else {
        "inactive"
    }
}

fn analytics_data(units: &[ParsedBcs], locations: &[String]) -> Result<AnalyticsData, String> {
    let all_personnel = units
        .iter()
        .flat_map(|unit| &unit.rows)
        .filter(|row| !row.full_name.trim().is_empty())
        .collect::<Vec<_>>();

    let mut unit_rows = Vec::with_capacity(units.len());
    for unit in units {
        let personnel = unit
            .rows
            .iter()
            .filter(|row| !row.full_name.trim().is_empty())
            .collect::<Vec<_>>();
        let own = personnel.iter().filter(|row| !row.is_external).count() as i64;
        let temporary_acting = personnel
            .iter()
            .filter(|row| row.is_temporary && row.personnel_position.to_uppercase().contains("ТВО"))
            .count() as i64;
        let listed = own
            .checked_add(temporary_acting)
            .ok_or_else(|| "Чисельність підрозділу завелика.".to_string())?;
        let present = personnel
            .iter()
            .filter(|row| !row.is_external && !ABSENT_LOCATIONS.contains(&row.location.as_str()))
            .count() as i64;
        let staffing_percent = if unit.authorized_strength > 0 {
            listed as f64 * 100.0 / unit.authorized_strength as f64
        } else {
            0.0
        };
        let deficit = unit.authorized_strength.saturating_sub(listed).max(0);
        let presence_percent = if listed > 0 {
            present as f64 * 100.0 / listed as f64
        } else {
            0.0
        };
        unit_rows.push(UnitAnalytics {
            unit_name: unit.unit_name.clone(),
            authorized: unit.authorized_strength,
            listed,
            present,
            staffing_percent,
            deficit,
            presence_percent,
        });
    }

    let count_own_location = |location: &str| {
        all_personnel
            .iter()
            .filter(|row| !row.is_external && row.location == location)
            .count() as i64
    };
    let absence_reasons = [
        ("Відпустка", "ВІДП"),
        ("Лікування", "ЛІК"),
        ("ВЛК", "ВЛК"),
        ("Навчання", "НАВЧ"),
        ("Відрядження", "ВІДР"),
        ("Відкомандировані", "Відкомандировані"),
        ("СЗЧ", "СЗЧ"),
        ("ПТЗ Новостав", "ПТЗ Новостав"),
    ]
    .into_iter()
    .filter_map(|(label, location)| {
        let count = count_own_location(location);
        (count > 0).then(|| (label.to_string(), count))
    })
    .collect::<Vec<_>>();

    let crews = crew_group_starts(units)
        .into_iter()
        .filter(|row| row.section == "Екіпаж" && !row.crew_name.trim().is_empty())
        .collect::<Vec<_>>();
    let crew_statuses = [
        ("Формуються", "forming"),
        ("Працюючі", "working"),
        ("Не активні", "inactive"),
    ]
    .into_iter()
    .map(|(label, group)| {
        (
            label.to_string(),
            crews
                .iter()
                .filter(|row| crew_status_group(&row.crew_status) == group)
                .count() as i64,
        )
    })
    .collect::<Vec<_>>();

    let mut crew_type_counts = BTreeMap::<String, i64>::new();
    for crew in &crews {
        let kind = crew.uav_type.trim();
        if !kind.is_empty() {
            *crew_type_counts.entry(kind.to_string()).or_default() += 1;
        }
    }
    let crew_types = crew_type_counts
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .collect::<Vec<_>>();

    let mut location_counts = locations
        .iter()
        .filter_map(|location| {
            let count = all_personnel
                .iter()
                .filter(|row| row.location == *location)
                .count() as i64;
            (count > 0).then(|| (location.clone(), count))
        })
        .collect::<Vec<_>>();
    let unknown = all_personnel
        .iter()
        .filter(|row| !locations.contains(&row.location))
        .count() as i64;
    if unknown > 0 {
        location_counts.push(("Не вказано / інше".into(), unknown));
    }

    Ok(AnalyticsData {
        units: unit_rows,
        absence_reasons,
        crew_statuses,
        crew_types,
        locations: location_counts,
    })
}

fn bcs_styles() -> String {
    let fills = [
        "D7E48D", "FDEADA", "E6B8B7", "CCC0DA", "C7BED0", "DBEEF4", "D7E4BD", "F2DCDB",
        "FCD5B4",
    ]
    .iter()
    .map(|color| format!("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF{color}\"/><bgColor indexed=\"64\"/></patternFill></fill>"))
    .collect::<String>();
    let formats = (10..=18)
        .map(|fill| format!("<xf numFmtId=\"0\" fontId=\"7\" fillId=\"{fill}\" borderId=\"7\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"center\" wrapText=\"1\"/></xf>"))
        .collect::<String>();
    let extra_formats = format!(
        "{formats}<xf numFmtId=\"0\" fontId=\"7\" fillId=\"0\" borderId=\"7\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"center\" wrapText=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"7\" fillId=\"0\" borderId=\"7\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" wrapText=\"1\"/></xf>"
    );
    include_str!("../resources/bcs-reference-styles.xml")
        .replace("<fills count=\"10\">", "<fills count=\"19\">")
        .replace("</fills>", &format!("{fills}</fills>"))
        .replace("<cellXfs count=\"171\">", "<cellXfs count=\"182\">")
        .replace("</cellXfs>", &format!("{extra_formats}</cellXfs>"))
}

fn style_for(row: &BcsRow) -> usize {
    match row.color_key.as_str() {
        "crew-working" => 171,
        "crew-forming" => 172,
        "crew-inactive" => 173,
        "company-management" => 174,
        "platoon-management" => 175,
        "independent" => 176,
        "unassigned" => 177,
        "attached" => 178,
        "temporary" => 179,
        _ => 177,
    }
}

fn row_height(row: &BcsRow, widths: &[f64]) -> usize {
    let values = row.values();
    let max_lines = values
        .iter()
        .enumerate()
        .skip(10)
        .map(|(index, value)| {
            value
                .split('\n')
                .map(|line| {
                    (line.chars().count() as f64 / (widths[index] * 0.8))
                        .ceil()
                        .max(1.0) as usize
                })
                .sum::<usize>()
        })
        .max()
        .unwrap_or(1);
    (max_lines * 14 + 10).max(40)
}

fn write_unit_rows(
    sheet: &mut String,
    merges: &mut Vec<String>,
    unit: &ParsedBcs,
    cursor: &mut usize,
    widths: &[f64],
) -> Result<(), String> {
    sheet.push_str(&format!(
        "<row r=\"{}\" ht=\"20\" customHeight=\"1\">{}</row>",
        *cursor,
        text_cell(0, *cursor, &unit.unit_name, 6)
    ));
    merges.push(format!("A{}:P{}", *cursor, *cursor));
    *cursor += 1;

    let mut start = 0usize;
    while start < unit.rows.len() {
        let mut end = start + 1;
        while end < unit.rows.len() && unit.rows[end].group_key == unit.rows[start].group_key {
            end += 1;
        }
        if end - start > 1 {
            for index in 0..10 {
                merges.push(format!(
                    "{}{}:{}{}",
                    column(index),
                    *cursor,
                    column(index),
                    *cursor + end - start - 1
                ));
            }
        }
        for (offset, row) in unit.rows[start..end].iter().enumerate() {
            let current = *cursor + offset;
            sheet.push_str(&format!(
                "<row r=\"{current}\" ht=\"{}\" customHeight=\"1\">",
                row_height(row, widths)
            ));
            let values = row.values();
            let style = style_for(row);
            for (index, value) in values.iter().enumerate() {
                let value = if offset > 0 && index < 10 { "" } else { value };
                if (index == 5 || index == 6) && !value.trim().is_empty() {
                    let count = parse_integer(value, "Кількість в/с")?;
                    sheet.push_str(&number_cell(index, current, count, style));
                } else {
                    sheet.push_str(&text_cell(index, current, value, style));
                }
            }
            sheet.push_str("</row>");
        }
        *cursor += end - start;
        start = end;
    }
    Ok(())
}

fn insert_cell(
    rows: &mut BTreeMap<usize, BTreeMap<usize, String>>,
    row: usize,
    column_index: usize,
    cell_xml: String,
) {
    rows.entry(row).or_default().insert(column_index, cell_xml);
}

fn write_two_column_table(
    rows: &mut BTreeMap<usize, BTreeMap<usize, String>>,
    title: &str,
    title_row: usize,
    first_column: usize,
    labels: &[(String, i64)],
) {
    insert_cell(
        rows,
        title_row,
        first_column,
        text_cell(first_column, title_row, title, 5),
    );
    insert_cell(
        rows,
        title_row,
        first_column + 1,
        text_cell(first_column + 1, title_row, "", 5),
    );
    let header_row = title_row + 1;
    insert_cell(
        rows,
        header_row,
        first_column,
        text_cell(first_column, header_row, "Категорія", 3),
    );
    insert_cell(
        rows,
        header_row,
        first_column + 1,
        text_cell(first_column + 1, header_row, "Кількість", 3),
    );
    if labels.is_empty() {
        let row = header_row + 1;
        insert_cell(
            rows,
            row,
            first_column,
            text_cell(first_column, row, "Немає даних", 181),
        );
        insert_cell(
            rows,
            row,
            first_column + 1,
            text_cell(first_column + 1, row, "", 180),
        );
    } else {
        for (offset, (label, value)) in labels.iter().enumerate() {
            let row = header_row + offset + 1;
            insert_cell(
                rows,
                row,
                first_column,
                text_cell(first_column, row, label, 181),
            );
            insert_cell(
                rows,
                row,
                first_column + 1,
                number_cell(first_column + 1, row, *value, 180),
            );
        }
    }
}

fn build_analytics_sheet(
    units: &[ParsedBcs],
    locations: &[String],
) -> Result<(String, Vec<ChartSpec>), String> {
    let data = analytics_data(units, locations)?;
    let mut rows = BTreeMap::<usize, BTreeMap<usize, String>>::new();
    insert_cell(
        &mut rows,
        1,
        0,
        text_cell(
            0,
            1,
            &format!("АНАЛІТИКА ЗВЕДЕНОГО БЧС СТАНОМ НА {}", units[0].date),
            2,
        ),
    );
    insert_cell(
        &mut rows,
        2,
        0,
        text_cell(
            0,
            2,
            "Порівняння підрозділів за одну звітну дату. Це не динаміка в часі.",
            5,
        ),
    );
    insert_cell(
        &mut rows,
        4,
        0,
        text_cell(0, 4, "Чисельність за підрозділами", 5),
    );
    for (index, header) in [
        "Підрозділ",
        "По штату",
        "По списку",
        "В наявності",
        "Укомплектованість, %",
        "Дефіцит до штату",
        "Наявність від списку, %",
    ]
    .iter()
    .enumerate()
    {
        insert_cell(&mut rows, 5, index, text_cell(index, 5, header, 3));
    }
    for (offset, unit) in data.units.iter().enumerate() {
        let row = 6 + offset;
        insert_cell(&mut rows, row, 0, text_cell(0, row, &unit.unit_name, 181));
        insert_cell(&mut rows, row, 1, number_cell(1, row, unit.authorized, 180));
        insert_cell(&mut rows, row, 2, number_cell(2, row, unit.listed, 180));
        insert_cell(&mut rows, row, 3, number_cell(3, row, unit.present, 180));
        insert_cell(
            &mut rows,
            row,
            4,
            decimal_cell(4, row, unit.staffing_percent, 180),
        );
        insert_cell(&mut rows, row, 5, number_cell(5, row, unit.deficit, 180));
        insert_cell(
            &mut rows,
            row,
            6,
            decimal_cell(6, row, unit.presence_percent, 180),
        );
    }
    write_two_column_table(
        &mut rows,
        "Причини відсутності",
        4,
        8,
        &data.absence_reasons,
    );
    write_two_column_table(&mut rows, "Статуси екіпажів", 4, 11, &data.crew_statuses);
    write_two_column_table(
        &mut rows,
        "Типи БпАК (лише ненульові)",
        4,
        14,
        &data.crew_types,
    );
    write_two_column_table(&mut rows, "Місця (лише ненульові)", 4, 17, &data.locations);

    let mut sheet = String::from(
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"2\" topLeftCell=\"A3\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols><col min=\"1\" max=\"1\" width=\"24\" customWidth=\"1\"/><col min=\"2\" max=\"7\" width=\"17\" customWidth=\"1\"/><col min=\"8\" max=\"8\" width=\"3\" customWidth=\"1\"/><col min=\"9\" max=\"9\" width=\"24\" customWidth=\"1\"/><col min=\"10\" max=\"10\" width=\"14\" customWidth=\"1\"/><col min=\"11\" max=\"11\" width=\"3\" customWidth=\"1\"/><col min=\"12\" max=\"12\" width=\"24\" customWidth=\"1\"/><col min=\"13\" max=\"13\" width=\"14\" customWidth=\"1\"/><col min=\"14\" max=\"14\" width=\"3\" customWidth=\"1\"/><col min=\"15\" max=\"15\" width=\"24\" customWidth=\"1\"/><col min=\"16\" max=\"16\" width=\"14\" customWidth=\"1\"/><col min=\"17\" max=\"17\" width=\"3\" customWidth=\"1\"/><col min=\"18\" max=\"18\" width=\"24\" customWidth=\"1\"/><col min=\"19\" max=\"19\" width=\"14\" customWidth=\"1\"/></cols><sheetData>",
    );
    for (row_number, cells) in &rows {
        let height = match *row_number {
            1 => 28,
            5 => 34,
            _ => 24,
        };
        sheet.push_str(&format!(
            "<row r=\"{row_number}\" ht=\"{height}\" customHeight=\"1\">"
        ));
        for cell_xml in cells.values() {
            sheet.push_str(cell_xml);
        }
        sheet.push_str("</row>");
    }

    let maximum_table_rows = [
        data.units.len(),
        data.absence_reasons.len().max(1),
        data.crew_statuses.len(),
        data.crew_types.len().max(1),
        data.locations.len().max(1),
    ]
    .into_iter()
    .max()
    .unwrap_or(1);
    let top = 7 + maximum_table_rows;
    let unit_first = 6;
    let unit_last = 5 + data.units.len();
    let categories = data
        .units
        .iter()
        .map(|unit| unit.unit_name.clone())
        .collect::<Vec<_>>();
    let mut charts = vec![
        ChartSpec {
            title: "Штат, список і наявність за підрозділами".into(),
            category_column: "A".into(),
            first_row: unit_first,
            last_row: unit_last,
            categories: categories.clone(),
            series: vec![
                ChartSeries {
                    name: "По штату".into(),
                    value_column: "B".into(),
                    values: data
                        .units
                        .iter()
                        .map(|unit| unit.authorized as f64)
                        .collect(),
                },
                ChartSeries {
                    name: "По списку".into(),
                    value_column: "C".into(),
                    values: data.units.iter().map(|unit| unit.listed as f64).collect(),
                },
                ChartSeries {
                    name: "В наявності".into(),
                    value_column: "D".into(),
                    values: data.units.iter().map(|unit| unit.present as f64).collect(),
                },
            ],
            horizontal: false,
            percent_axis: false,
            from_col: 0,
            from_row: top,
            to_col: 8,
            to_row: top + 16,
        },
        ChartSpec {
            title: "Укомплектованість і наявність за підрозділами, %".into(),
            category_column: "A".into(),
            first_row: unit_first,
            last_row: unit_last,
            categories,
            series: vec![
                ChartSeries {
                    name: "Укомплектованість, %".into(),
                    value_column: "E".into(),
                    values: data
                        .units
                        .iter()
                        .map(|unit| unit.staffing_percent)
                        .collect(),
                },
                ChartSeries {
                    name: "Наявність від списку, %".into(),
                    value_column: "G".into(),
                    values: data
                        .units
                        .iter()
                        .map(|unit| unit.presence_percent)
                        .collect(),
                },
            ],
            horizontal: true,
            percent_axis: true,
            from_col: 9,
            from_row: top,
            to_col: 17,
            to_row: top + 16,
        },
    ];

    let mut add_chart = |title: &str,
                         category_column: &str,
                         value_column: &str,
                         values: &[(String, i64)],
                         from_col: usize,
                         from_row: usize,
                         to_col: usize,
                         to_row: usize| {
        if values.is_empty() {
            return;
        }
        charts.push(ChartSpec {
            title: title.into(),
            category_column: category_column.into(),
            first_row: 6,
            last_row: 5 + values.len(),
            categories: values.iter().map(|(label, _)| label.clone()).collect(),
            series: vec![ChartSeries {
                name: "Кількість".into(),
                value_column: value_column.into(),
                values: values.iter().map(|(_, value)| *value as f64).collect(),
            }],
            horizontal: true,
            percent_axis: false,
            from_col,
            from_row,
            to_col,
            to_row,
        });
    };
    add_chart(
        "Причини відсутності",
        "I",
        "J",
        &data.absence_reasons,
        0,
        top + 17,
        8,
        top + 33,
    );
    add_chart(
        "Статуси екіпажів",
        "L",
        "M",
        &data.crew_statuses,
        9,
        top + 17,
        17,
        top + 33,
    );
    add_chart(
        "Типи БпАК",
        "O",
        "P",
        &data.crew_types,
        0,
        top + 34,
        8,
        top + 50,
    );
    add_chart(
        "Де знаходиться особовий склад",
        "R",
        "S",
        &data.locations,
        9,
        top + 34,
        17,
        top + 50,
    );

    sheet.push_str(
        "</sheetData><mergeCells count=\"7\"><mergeCell ref=\"A1:S1\"/><mergeCell ref=\"A2:S2\"/><mergeCell ref=\"A4:G4\"/><mergeCell ref=\"I4:J4\"/><mergeCell ref=\"L4:M4\"/><mergeCell ref=\"O4:P4\"/><mergeCell ref=\"R4:S4\"/></mergeCells><pageMargins left=\"0.25\" right=\"0.25\" top=\"0.3\" bottom=\"0.3\" header=\"0\" footer=\"0\"/><pageSetup paperSize=\"8\" orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/><drawing r:id=\"rIdDrawing\"/></worksheet>",
    );
    Ok((sheet, charts))
}

fn chart_xml(spec: &ChartSpec, chart_index: usize) -> String {
    let category_formula = format!(
        "'Аналітика'!${}${}:${}${}",
        spec.category_column, spec.first_row, spec.category_column, spec.last_row
    );
    let category_cache = spec
        .categories
        .iter()
        .enumerate()
        .map(|(index, value)| format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", esc(value)))
        .collect::<String>();
    let palette = ["2F75B5", "70AD47", "A5A5A5", "ED7D31", "5B9BD5"];
    let series = spec
        .series
        .iter()
        .enumerate()
        .map(|(index, series)| {
            let value_formula = format!(
                "'Аналітика'!${}${}:${}${}",
                series.value_column, spec.first_row, series.value_column, spec.last_row
            );
            let values = series
                .values
                .iter()
                .enumerate()
                .map(|(point, value)| {
                    format!("<c:pt idx=\"{point}\"><c:v>{value:.4}</c:v></c:pt>")
                })
                .collect::<String>();
            format!(
                "<c:ser><c:idx val=\"{index}\"/><c:order val=\"{index}\"/><c:tx><c:v>{}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:cat><c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"{}\"/>{}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>{}</c:f><c:numCache><c:formatCode>0.0</c:formatCode><c:ptCount val=\"{}\"/>{}</c:numCache></c:numRef></c:val></c:ser>",
                esc(&series.name),
                palette[index % palette.len()],
                category_formula,
                spec.categories.len(),
                category_cache,
                value_formula,
                series.values.len(),
                values,
            )
        })
        .collect::<String>();
    let category_axis = 100_000 + chart_index * 2;
    let value_axis = category_axis + 1;
    let bar_direction = if spec.horizontal { "bar" } else { "col" };
    let category_position = if spec.horizontal { "l" } else { "b" };
    let value_position = if spec.horizontal { "b" } else { "l" };
    let maximum = if spec.percent_axis {
        "<c:max val=\"100\"/>"
    } else {
        ""
    };
    let major_unit = chart_major_unit(spec);
    let legend = if spec.series.len() > 1 {
        "<c:legend><c:legendPos val=\"t\"/><c:overlay val=\"0\"/></c:legend>"
    } else {
        ""
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><c:lang val=\"uk-UA\"/><c:roundedCorners val=\"0\"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"uk-UA\" sz=\"1100\" b=\"1\"><a:latin typeface=\"Arial\"/></a:rPr><a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val=\"{bar_direction}\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>{series}<c:dLbls><c:showLegendKey val=\"0\"/><c:showVal val=\"0\"/><c:showCatName val=\"0\"/><c:showSerName val=\"0\"/></c:dLbls><c:gapWidth val=\"120\"/><c:axId val=\"{category_axis}\"/><c:axId val=\"{value_axis}\"/></c:barChart><c:catAx><c:axId val=\"{category_axis}\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"{category_position}\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"{value_axis}\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/><c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/></c:catAx><c:valAx><c:axId val=\"{value_axis}\"/><c:scaling><c:orientation val=\"minMax\"/><c:min val=\"0\"/>{maximum}</c:scaling><c:delete val=\"0\"/><c:axPos val=\"{value_position}\"/><c:majorGridlines/><c:numFmt formatCode=\"0\" sourceLinked=\"0\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"{category_axis}\"/><c:crosses val=\"autoZero\"/><c:crossBetween val=\"between\"/><c:majorUnit val=\"{major_unit}\"/></c:valAx></c:plotArea>{legend}<c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/><c:showDLblsOverMax val=\"0\"/></c:chart><c:spPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val=\"D9D9D9\"/></a:solidFill></a:ln></c:spPr></c:chartSpace>",
        esc(&spec.title)
    )
}

fn chart_major_unit(spec: &ChartSpec) -> u64 {
    if spec.percent_axis {
        return 10;
    }

    let maximum_value = spec
        .series
        .iter()
        .flat_map(|series| series.values.iter().copied())
        .filter(|value| value.is_finite())
        .fold(0.0_f64, f64::max);

    count_chart_major_unit(maximum_value)
}

fn count_chart_major_unit(maximum_value: f64) -> u64 {
    if maximum_value <= 10.0 {
        1
    } else if maximum_value <= 50.0 {
        5
    } else if maximum_value <= 100.0 {
        10
    } else if maximum_value <= 500.0 {
        50
    } else {
        100
    }
}

fn drawing_xml(charts: &[ChartSpec]) -> String {
    let anchors = charts
        .iter()
        .enumerate()
        .map(|(index, chart)| {
            let id = index + 1;
            format!(
                "<xdr:twoCellAnchor><xdr:from><xdr:col>{}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>{}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr><xdr:cNvPr id=\"{id}\" name=\"Chart {id}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"><c:chart xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" r:id=\"rIdChart{id}\"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>",
                chart.from_col, chart.from_row, chart.to_col, chart.to_row
            )
        })
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><xdr:wsDr xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">{anchors}</xdr:wsDr>"
    )
}

fn write_summary_package(
    path: &Path,
    bcs_sheet: &str,
    analytics_sheet: &str,
    charts: &[ChartSpec],
    styles: &str,
    theme: &str,
) -> Result<(), String> {
    let file = File::create(path).map_err(|_| "Не вдалося створити Excel-файл.".to_string())?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let chart_overrides = (1..=charts.len())
        .map(|index| format!("<Override PartName=\"/xl/drawings/charts/chart{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.drawingml.chart+xml\"/>"))
        .collect::<String>();
    let content_types = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/worksheets/sheet2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/><Override PartName=\"/xl/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/xl/drawings/drawing1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.drawing+xml\"/>{chart_overrides}</Types>"
    );
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>";
    let workbook_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/><Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rIdTheme\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/></Relationships>";
    let workbook = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"БЧС\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Аналітика\" sheetId=\"2\" r:id=\"rId2\"/></sheets><calcPr calcId=\"191029\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>";
    let sheet_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rIdDrawing\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing\" Target=\"../drawings/drawing1.xml\"/></Relationships>";
    let drawing_relationships = (1..=charts.len())
        .map(|index| format!("<Relationship Id=\"rIdChart{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart\" Target=\"charts/chart{index}.xml\"/>"))
        .collect::<String>();
    let drawing_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{drawing_relationships}</Relationships>"
    );
    let fixed_files = [
        ("[Content_Types].xml", content_types.as_str()),
        ("_rels/.rels", root_rels),
        ("xl/_rels/workbook.xml.rels", workbook_rels),
        ("xl/workbook.xml", workbook),
        ("xl/styles.xml", styles),
        ("xl/theme/theme1.xml", theme),
        ("xl/worksheets/sheet1.xml", bcs_sheet),
        ("xl/worksheets/sheet2.xml", analytics_sheet),
        ("xl/worksheets/_rels/sheet2.xml.rels", sheet_rels),
    ];
    for (name, content) in fixed_files {
        archive
            .start_file(name, options)
            .map_err(|_| "Не вдалося сформувати Excel-файл.".to_string())?;
        archive
            .write_all(content.as_bytes())
            .map_err(|_| "Не вдалося записати Excel-файл.".to_string())?;
    }
    archive
        .start_file("xl/drawings/drawing1.xml", options)
        .map_err(|_| "Не вдалося сформувати Excel-файл.".to_string())?;
    archive
        .write_all(drawing_xml(charts).as_bytes())
        .map_err(|_| "Не вдалося записати Excel-файл.".to_string())?;
    archive
        .start_file("xl/drawings/_rels/drawing1.xml.rels", options)
        .map_err(|_| "Не вдалося сформувати Excel-файл.".to_string())?;
    archive
        .write_all(drawing_rels.as_bytes())
        .map_err(|_| "Не вдалося записати Excel-файл.".to_string())?;
    for (index, chart) in charts.iter().enumerate() {
        archive
            .start_file(
                format!("xl/drawings/charts/chart{}.xml", index + 1),
                options,
            )
            .map_err(|_| "Не вдалося сформувати Excel-файл.".to_string())?;
        archive
            .write_all(chart_xml(chart, index + 1).as_bytes())
            .map_err(|_| "Не вдалося записати Excel-файл.".to_string())?;
    }
    archive
        .finish()
        .map_err(|_| "Не вдалося завершити Excel-файл.".to_string())?;
    Ok(())
}

fn export_workbook(path: &Path, units: &[ParsedBcs]) -> Result<(), String> {
    let schema = schema()?;
    let date = &units[0].date;
    let mut merges = vec!["A1:O2".to_string()];
    let mut sheet = String::from("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"6\" topLeftCell=\"A7\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols>");
    for (index, width) in schema.widths.iter().enumerate() {
        sheet.push_str(&format!(
            "<col min=\"{}\" max=\"{}\" width=\"{width}\" customWidth=\"1\"/>",
            index + 1,
            index + 1
        ));
    }
    sheet.push_str("</cols><sheetData><row r=\"1\" ht=\"18\" customHeight=\"1\">");
    sheet.push_str(&text_cell(
        0,
        1,
        &format!("ЗВЕДЕНИЙ БЧС\nстаном на 08:00 год {date} року"),
        2,
    ));
    sheet.push_str("</row><row r=\"2\" ht=\"44.25\" customHeight=\"1\"/><row r=\"4\" ht=\"30\" customHeight=\"1\">");
    for (index, header) in schema.headers.iter().enumerate() {
        sheet.push_str(&text_cell(index, 4, header, 3));
        merges.push(format!("{}4:{}5", column(index), column(index)));
    }
    sheet.push_str("</row><row r=\"5\" ht=\"30\" customHeight=\"1\">");
    for index in 0..schema.headers.len() {
        sheet.push_str(&text_cell(index, 5, "", 3));
    }
    sheet.push_str("</row>");

    let mut cursor = 6usize;
    for unit in units {
        write_unit_rows(&mut sheet, &mut merges, unit, &mut cursor, &schema.widths)?;
    }
    let data_end = cursor.saturating_sub(1);
    let summary = cursor + 2;
    write_summary(&mut sheet, summary, units, &schema.locations)?;
    sheet.push_str(&format!(
        "</sheetData><autoFilter ref=\"A4:P{data_end}\"/><mergeCells count=\"{}\">{}</mergeCells><pageMargins left=\"0.25\" right=\"0.25\" top=\"0.3\" bottom=\"0.3\" header=\"0\" footer=\"0\"/><pageSetup paperSize=\"8\" orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>",
        merges.len(),
        merges
            .iter()
            .map(|range| format!("<mergeCell ref=\"{range}\"/>"))
            .collect::<String>()
    ));

    let (analytics_sheet, charts) = build_analytics_sheet(units, &schema.locations)?;
    write_summary_package(
        path,
        &sheet,
        &analytics_sheet,
        &charts,
        &bcs_styles(),
        include_str!("../resources/bcs-reference-theme.xml"),
    )
}

fn write_summary(
    sheet: &mut String,
    summary: usize,
    units: &[ParsedBcs],
    locations: &[String],
) -> Result<(), String> {
    let rows = units.iter().flat_map(|unit| &unit.rows).collect::<Vec<_>>();
    let personnel = rows
        .iter()
        .copied()
        .filter(|row| !row.full_name.trim().is_empty())
        .collect::<Vec<_>>();
    let own = personnel.iter().filter(|row| !row.is_external).count() as i64;
    let count_own_location = |location: &str| {
        personnel
            .iter()
            .filter(|row| !row.is_external && row.location == location)
            .count() as i64
    };
    let count_all_location = |location: &str| {
        personnel
            .iter()
            .filter(|row| row.location == location)
            .count() as i64
    };
    let temporary_acting = personnel
        .iter()
        .filter(|row| row.is_temporary && row.personnel_position.to_uppercase().contains("ТВО"))
        .count() as i64;
    let present = personnel
        .iter()
        .filter(|row| !row.is_external && !ABSENT_LOCATIONS.contains(&row.location.as_str()))
        .count() as i64;
    let authorized = units.iter().try_fold(0i64, |total, unit| {
        total
            .checked_add(unit.authorized_strength)
            .ok_or_else(|| "Сума штатної чисельності завелика.".to_string())
    })?;
    let labels = [
        "По штату",
        "По списку",
        "В наявності",
        "Відпустка",
        "Шпиталь",
        "Відрядження",
        "Відкомандировані",
        "Прикомандировані",
        "Оперативне підпорядкування",
        "ПТЗ Новостав",
        "СЗЧ",
        "Тимчасово прибулі",
        "Тимчасово прибулі з ТВО",
    ];
    let values = [
        authorized,
        own + temporary_acting,
        present,
        count_own_location("ВІДП"),
        count_own_location("ЛІК") + count_own_location("ВЛК"),
        count_own_location("НАВЧ") + count_own_location("ВІДР"),
        count_own_location("Відкомандировані"),
        personnel
            .iter()
            .filter(|row| row.section == "Прикомандировані")
            .count() as i64,
        personnel
            .iter()
            .filter(|row| row.section == "Оперативне підпорядкування")
            .count() as i64,
        count_own_location("ПТЗ Новостав"),
        count_own_location("СЗЧ"),
        personnel.iter().filter(|row| row.is_temporary).count() as i64,
        temporary_acting,
    ];

    let crews = crew_group_starts(units)
        .into_iter()
        .filter(|row| row.section == "Екіпаж" && !row.crew_name.is_empty())
        .collect::<Vec<_>>();
    let crew_personnel = personnel
        .iter()
        .filter(|row| row.section == "Екіпаж")
        .map(|row| row.full_name.to_uppercase())
        .collect::<HashSet<_>>()
        .len() as i64;
    let mut functional = vec![
        ("Екіпажів (ос-загально)".to_string(), crew_personnel),
        ("Екіпажів (загально)".to_string(), crews.len() as i64),
    ];
    let mut crew_types = BTreeMap::<String, i64>::new();
    for crew in &crews {
        if !crew.uav_type.trim().is_empty() {
            *crew_types
                .entry(crew.uav_type.trim().to_string())
                .or_default() += 1;
        }
    }
    functional.extend(
        crew_types
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(kind, count)| (format!("Екіпажів — {kind}"), count)),
    );
    for (label, group) in [
        ("Екіпажів — Формуються", "forming"),
        ("Екіпажів — Працюючі", "working"),
        ("Екіпажів — Не активні", "inactive"),
    ] {
        functional.push((
            label.into(),
            crews
                .iter()
                .filter(|row| crew_status_group(&row.crew_status) == group)
                .count() as i64,
        ));
    }
    let mut sections = Vec::<String>::new();
    for row in &rows {
        if !row.is_external
            && !row.section.is_empty()
            && row.section != "Екіпаж"
            && !sections.contains(&row.section)
        {
            sections.push(row.section.clone());
        }
    }
    for section in sections {
        functional.push((
            section.clone(),
            personnel
                .iter()
                .filter(|row| {
                    row.section == section
                        && !ABSENT_LOCATIONS.contains(&row.location.as_str())
                        && row.location != "ПТЗ Новостав"
                })
                .count() as i64,
        ));
    }

    sheet.push_str(&format!(
        "<row r=\"{summary}\">{}{}{}</row>",
        text_cell(5, summary, "ЗВЕДЕНИЙ БЧС:", 5),
        text_cell(8, summary, "БЧС по функціоналу:", 5),
        text_cell(11, summary, "Де знаходиться", 5)
    ));
    let row_count = (locations.len() + 2)
        .max(functional.len())
        .max(labels.len());
    for index in 0..row_count {
        let row_number = summary + index + 1;
        sheet.push_str(&format!(
            "<row r=\"{row_number}\" ht=\"24\" customHeight=\"1\">"
        ));
        if let (Some(label), Some(value)) = (labels.get(index), values.get(index)) {
            sheet.push_str(&text_cell(5, row_number, label, 3));
            sheet.push_str(&number_cell(6, row_number, *value, 3));
        }
        if let Some((label, value)) = functional.get(index) {
            sheet.push_str(&text_cell(8, row_number, label, 3));
            sheet.push_str(&number_cell(9, row_number, *value, 3));
        }
        if let Some(location) = locations.get(index) {
            sheet.push_str(&text_cell(11, row_number, location, 3));
            sheet.push_str(&number_cell(
                12,
                row_number,
                count_all_location(location),
                3,
            ));
        } else if index == locations.len() {
            let unknown = personnel
                .iter()
                .filter(|row| !locations.contains(&row.location))
                .count() as i64;
            sheet.push_str(&text_cell(11, row_number, "Не вказано / інше", 3));
            sheet.push_str(&number_cell(12, row_number, unknown, 3));
        } else if index == locations.len() + 1 {
            sheet.push_str(&text_cell(11, row_number, "Загалом", 3));
            sheet.push_str(&number_cell(12, row_number, personnel.len() as i64, 3));
        }
        sheet.push_str("</row>");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn sample_unit(path: &Path, unit: &str, date: &str, authorized: i64) -> ParsedBcs {
        ParsedBcs {
            id: format!("id-{unit}"),
            path: path.to_path_buf(),
            file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
            unit_name: unit.into(),
            date: date.into(),
            is_summary: false,
            authorized_strength: authorized,
            rows: vec![BcsRow {
                color_key: "crew-working".into(),
                group_key: format!("group-{unit}"),
                section: "Екіпаж".into(),
                position_name: "позиція-тест".into(),
                battle_order: "бро-тест".into(),
                sector: "сектор-тест".into(),
                crew_name: "екіпаж-тест".into(),
                crew_actual: "4".into(),
                crew_official: "1".into(),
                crew_status: "Працюючий".into(),
                uav_name: "БпАК-ТЕСТ".into(),
                uav_type: "Коптер".into(),
                personnel_position: "тестова посада".into(),
                rank: "солдат".into(),
                full_name: "Особа-001".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            }],
        }
    }

    fn summary_value(xml: &str, label: &str) -> i64 {
        let label_at = xml
            .find(label)
            .unwrap_or_else(|| panic!("missing label: {label}"));
        let after_label = &xml[label_at + label.len()..];
        let value_start = after_label.find("<v>").unwrap() + 3;
        let value_end = after_label[value_start..].find("</v>").unwrap() + value_start;
        after_label[value_start..value_end].parse().unwrap()
    }

    fn archive_text(archive: &mut ZipArchive<File>, path: &str) -> String {
        let mut xml = String::new();
        archive
            .by_name(path)
            .unwrap_or_else(|_| panic!("missing OOXML part: {path}"))
            .read_to_string(&mut xml)
            .unwrap();
        xml
    }

    #[test]
    fn chart_major_units_are_integer_steps_scaled_to_the_largest_value() {
        assert_eq!(count_chart_major_unit(0.0), 1);
        assert_eq!(count_chart_major_unit(10.0), 1);
        assert_eq!(count_chart_major_unit(10.1), 5);
        assert_eq!(count_chart_major_unit(50.0), 5);
        assert_eq!(count_chart_major_unit(50.1), 10);
        assert_eq!(count_chart_major_unit(100.0), 10);
        assert_eq!(count_chart_major_unit(100.1), 50);
        assert_eq!(count_chart_major_unit(500.0), 50);
        assert_eq!(count_chart_major_unit(500.1), 100);
    }

    #[test]
    fn treats_other_blocks_as_the_reference_green_even_in_older_exports() {
        assert_eq!(color_key(Some(176), "Інші", ""), "unassigned");
        assert_eq!(color_key(None, "інші", ""), "unassigned");
    }

    #[test]
    fn summary_follows_external_presence_location_and_unique_crew_rules() {
        let path = PathBuf::from("logic.xlsx");
        let mut unit = sample_unit(&path, "ТЕСТ", "08.10.2026", 3);
        unit.rows = vec![
            BcsRow {
                group_key: "crew-1".into(),
                section: "Екіпаж".into(),
                crew_name: "АЛЬФА".into(),
                crew_status: "Працюючий".into(),
                full_name: "ОСОБА-1".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                group_key: "crew-2".into(),
                section: "Екіпаж".into(),
                crew_name: "БЕТА".into(),
                crew_status: "Формується".into(),
                full_name: "ОСОБА-1".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                group_key: "management".into(),
                section: "Управління роти".into(),
                full_name: "ОСОБА-2".into(),
                location: "ВІДП".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_external: true,
                group_key: "attached".into(),
                section: "Прикомандировані".into(),
                full_name: "ОСОБА-3".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_external: true,
                group_key: "operational".into(),
                section: "Оперативне підпорядкування".into(),
                full_name: "ОСОБА-4".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_temporary: true,
                is_external: true,
                group_key: "temporary-1".into(),
                section: "Тимчасово прибулі".into(),
                personnel_position: "ТВО ОПЕРАТОР".into(),
                full_name: "ОСОБА-5".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
            BcsRow {
                is_temporary: true,
                is_external: true,
                group_key: "temporary-2".into(),
                section: "Тимчасово прибулі".into(),
                personnel_position: "ОПЕРАТОР".into(),
                full_name: "ОСОБА-6".into(),
                location: "ПУ".into(),
                ..BcsRow::default()
            },
        ];

        let mut xml = String::new();
        write_summary(&mut xml, 100, &[unit], &["ПУ".into(), "ВІДП".into()]).unwrap();

        assert_eq!(summary_value(&xml, "По списку"), 4);
        assert_eq!(summary_value(&xml, "В наявності"), 2);
        assert_eq!(summary_value(&xml, "Прикомандировані"), 1);
        assert_eq!(summary_value(&xml, "Оперативне підпорядкування"), 1);
        assert_eq!(summary_value(&xml, "Тимчасово прибулі з ТВО"), 1);
        assert_eq!(summary_value(&xml, "Екіпажів (ос-загально)"), 1);
        assert_eq!(summary_value(&xml, "Управління роти"), 0);
        assert_eq!(summary_value(&xml, "ПУ"), 6);
        assert_eq!(summary_value(&xml, "Загалом"), 7);
    }

    #[test]
    fn analytics_calculates_units_and_keeps_only_nonzero_types_and_locations() {
        let path = PathBuf::from("analytics.xlsx");
        let mut first = sample_unit(&path, "ПІДРОЗДІЛ А", "08.10.2026", 4);
        first.rows.push(BcsRow {
            group_key: "absent-a".into(),
            section: "Управління роти".into(),
            full_name: "ОСОБА-2".into(),
            location: "ВІДП".into(),
            ..BcsRow::default()
        });
        let mut second = sample_unit(&path, "ПІДРОЗДІЛ Б", "08.10.2026", 2);
        second.rows[0].uav_type = "Бомбер".into();
        second.rows[0].location = "ШТАБ".into();

        let data = analytics_data(&[first, second], &["ПУ".into(), "ШТАБ".into()]).unwrap();

        assert_eq!(data.units[0].authorized, 4);
        assert_eq!(data.units[0].listed, 2);
        assert_eq!(data.units[0].present, 1);
        assert_eq!(data.units[0].staffing_percent, 50.0);
        assert_eq!(data.units[0].deficit, 2);
        assert_eq!(data.units[0].presence_percent, 50.0);
        assert_eq!(data.units[1].staffing_percent, 50.0);
        assert_eq!(data.units[1].deficit, 1);
        assert_eq!(data.units[1].presence_percent, 100.0);
        assert_eq!(
            data.crew_types,
            vec![("Бомбер".into(), 1), ("Коптер".into(), 1)]
        );
        assert!(!data
            .crew_types
            .iter()
            .any(|(kind, count)| kind == "Літаковий ударний" || *count == 0));
        assert_eq!(
            data.locations,
            vec![
                ("ПУ".into(), 1),
                ("ШТАБ".into(), 1),
                ("Не вказано / інше".into(), 1)
            ]
        );
        assert_eq!(data.absence_reasons, vec![("Відпустка".into(), 1)]);
    }

    #[test]
    fn compares_one_unit_and_describes_personnel_and_location_changes() {
        let path = PathBuf::from("comparison.xlsx");
        let mut before = sample_unit(&path, "1 РУБАК", "08.10.2026", 3);
        before.id = "before".into();
        let mut after = sample_unit(&path, "1 РУБАК", "09.10.2026", 3);
        after.id = "after".into();
        after.rows[0].location = "ВІДП".into();
        after.rows.push(BcsRow {
            group_key: "management".into(),
            section: "Управління роти".into(),
            rank: "солдат".into(),
            full_name: "ОСОБА-002".into(),
            location: "ПУ".into(),
            ..BcsRow::default()
        });

        let result = compare_parsed(&[before], &[after]).unwrap();

        assert_eq!(result.scope, "unit");
        assert_eq!(result.title, "1 РУБАК");
        assert_eq!(result.before_date, "08.10.2026");
        assert_eq!(result.after_date, "09.10.2026");
        assert_eq!(
            result
                .headline
                .iter()
                .find(|row| row.label == "По списку")
                .unwrap()
                .delta,
            1
        );
        assert_eq!(
            result
                .headline
                .iter()
                .find(|row| row.label == "В наявності")
                .unwrap()
                .delta,
            0
        );
        assert!(result.sections.iter().any(|section| {
            section.title == "Причини відсутності"
                && section
                    .rows
                    .iter()
                    .any(|row| row.label == "Відпустка" && row.delta == 1)
        }));
        assert!(result.personnel_changes.iter().any(|change| {
            change.person_name == "ОСОБА-001"
                && change.details.contains("Де знаходиться: ПУ → ВІДП")
        }));
        assert!(result
            .personnel_changes
            .iter()
            .any(|change| { change.person_name == "ОСОБА-002" && change.kind == "added" }));
    }

    #[test]
    fn compares_general_bcs_and_reports_added_and_removed_units() {
        let path = PathBuf::from("general-comparison.xlsx");
        let mut before_a = sample_unit(&path, "ПІДРОЗДІЛ А", "08.10.2026", 2);
        before_a.id = "before-a".into();
        let mut before_b = sample_unit(&path, "ПІДРОЗДІЛ Б", "08.10.2026", 2);
        before_b.id = "before-b".into();
        let mut after_a = sample_unit(&path, "ПІДРОЗДІЛ А", "09.10.2026", 2);
        after_a.id = "after-a".into();
        let mut after_c = sample_unit(&path, "ПІДРОЗДІЛ В", "09.10.2026", 4);
        after_c.id = "after-c".into();

        let result = compare_parsed(&[before_a, before_b], &[after_a, after_c]).unwrap();

        assert_eq!(result.scope, "general");
        assert_eq!(result.title, "Загальний БЧС");
        assert!(result
            .unit_changes
            .iter()
            .any(|change| change.contains("Відсутній у новому БЧС підрозділ «ПІДРОЗДІЛ Б»")));
        assert!(result
            .unit_changes
            .iter()
            .any(|change| change.contains("Додано підрозділ «ПІДРОЗДІЛ В»")));
    }

    #[test]
    fn compares_two_exported_general_bcs_files_as_general_scope() {
        let directory = tempfile::tempdir().unwrap();
        let before_path = directory.path().join("general-before.xlsx");
        let after_path = directory.path().join("general-after.xlsx");
        export_workbook(
            &before_path,
            &[
                sample_unit(&before_path, "ПІДРОЗДІЛ А", "08.10.2026", 2),
                sample_unit(&before_path, "ПІДРОЗДІЛ Б", "08.10.2026", 3),
            ],
        )
        .unwrap();
        let after_a = sample_unit(&after_path, "ПІДРОЗДІЛ А", "09.10.2026", 2);
        let mut after_b = sample_unit(&after_path, "ПІДРОЗДІЛ Б", "09.10.2026", 4);
        after_b.rows.push(BcsRow {
            group_key: "management-b".into(),
            section: "Управління роти".into(),
            rank: "солдат".into(),
            full_name: "ОСОБА-002".into(),
            location: "ПУ".into(),
            ..BcsRow::default()
        });
        export_workbook(&after_path, &[after_a, after_b]).unwrap();

        let before = parse_file(&before_path).unwrap();
        let after = parse_file(&after_path).unwrap();
        assert!(before.is_summary);
        assert!(after.is_summary);

        let result = compare_parsed(&[before], &[after]).unwrap();
        assert_eq!(result.scope, "general");
        assert_eq!(result.title, "Загальний БЧС");
        assert_eq!(
            result
                .headline
                .iter()
                .find(|row| row.label == "По штату")
                .unwrap()
                .delta,
            1
        );
        assert!(result
            .unit_changes
            .iter()
            .any(|change| change.contains("ПІДРОЗДІЛ Б: по списку 1 → 2")));
    }

    #[test]
    fn comparison_rejects_the_same_date_and_different_single_units() {
        let path = PathBuf::from("invalid-comparison.xlsx");
        let mut first = sample_unit(&path, "ПІДРОЗДІЛ А", "08.10.2026", 2);
        first.id = "first".into();
        let mut same_date = sample_unit(&path, "ПІДРОЗДІЛ А", "08.10.2026", 2);
        same_date.id = "same-date".into();
        assert!(compare_parsed(&[first.clone()], &[same_date])
            .unwrap_err()
            .contains("дві різні дати"));

        let mut other_unit = sample_unit(&path, "ПІДРОЗДІЛ Б", "09.10.2026", 2);
        other_unit.id = "other-unit".into();
        assert!(compare_parsed(&[first], &[other_unit])
            .unwrap_err()
            .contains("той самий підрозділ"));
    }

    #[test]
    fn summary_omits_uav_types_that_have_no_crew() {
        let path = PathBuf::from("zero-types.xlsx");
        let unit = sample_unit(&path, "ПІДРОЗДІЛ", "08.10.2026", 4);
        let mut xml = String::new();
        write_summary(&mut xml, 100, &[unit], &["ПУ".into()]).unwrap();

        assert!(xml.contains("Екіпажів — Коптер"));
        assert!(!xml.contains("Екіпажів — Бомбер"));
        assert!(!xml.contains("Екіпажів — Літаковий ударний"));
    }

    #[test]
    fn imports_an_anonymized_raportgen_shaped_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unit-a.xlsx");
        let unit = sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ А", "08.10.2026", 10);
        export_workbook(&path, &[unit]).unwrap();
        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed.unit_name, "ТЕСТОВИЙ ПІДРОЗДІЛ А");
        assert_eq!(parsed.date, "08.10.2026");
        assert_eq!(parsed.authorized_strength, 10);
        assert_eq!(parsed.rows[0].position_name, "ПОЗИЦІЯ-ТЕСТ");
        assert_eq!(parsed.rows[0].battle_order, "БРО-ТЕСТ");
        assert_eq!(parsed.rows[0].sector, "СЕКТОР-ТЕСТ");
        assert_eq!(parsed.rows[0].crew_name, "ЕКІПАЖ-ТЕСТ");
        assert_eq!(parsed.rows[0].crew_actual, "4");
        assert_eq!(parsed.rows[0].crew_official, "1");
        assert_eq!(parsed.rows[0].full_name, "ОСОБА-001");
    }

    #[test]
    fn does_not_carry_crew_metadata_into_the_next_management_block() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("crew-then-management.xlsx");
        let mut unit = sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ", "08.10.2026", 2);
        unit.rows.push(BcsRow {
            color_key: "company-management".into(),
            group_key: "management-group".into(),
            section: "Управління роти".into(),
            position_name: "Управління".into(),
            crew_official: "1".into(),
            personnel_position: "тестова посада".into(),
            full_name: "ОСОБА-002".into(),
            location: "ПУ".into(),
            ..BcsRow::default()
        });
        export_workbook(&path, &[unit]).unwrap();

        let parsed = parse_file(&path).unwrap();
        let management = parsed
            .rows
            .iter()
            .find(|row| row.section == "Управління роти")
            .unwrap();
        assert_eq!(management.position_name, "УПРАВЛІННЯ");
        assert!(management.crew_name.is_empty());
        assert!(management.crew_actual.is_empty());
        assert!(management.crew_status.is_empty());
        assert!(management.uav_type.is_empty());
    }

    #[test]
    fn reads_authorized_strength_from_h3_without_executing_summary_formula() {
        let mut top_cells = vec![Cell::default(); 8];
        top_cells[7] = Cell {
            value: "30".into(),
            style: None,
            has_formula: false,
        };
        let mut summary_cells = vec![Cell::default(); 7];
        summary_cells[5] = Cell {
            value: "По штату".into(),
            style: None,
            has_formula: false,
        };
        summary_cells[6] = Cell {
            value: "0".into(),
            style: None,
            has_formula: true,
        };
        let rows = vec![
            SheetRow {
                number: 3,
                cells: top_cells,
            },
            SheetRow {
                number: 510,
                cells: summary_cells,
            },
        ];

        let value = authorized_strength_from_rows(&rows, &rows[1], "template.xlsx").unwrap();
        assert_eq!(value, 30);
    }

    #[test]
    fn reads_authorized_strength_next_to_the_label_in_the_current_e_f_layout() {
        let mut summary_cells = vec![Cell::default(); 6];
        summary_cells[4] = Cell {
            value: "По штату".into(),
            style: None,
            has_formula: false,
        };
        summary_cells[5] = Cell {
            value: "42".into(),
            style: None,
            has_formula: false,
        };
        let rows = vec![SheetRow {
            number: 510,
            cells: summary_cells,
        }];

        let value = authorized_strength_from_rows(&rows, &rows[0], "editor.xlsx").unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn rejects_different_dates() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("unit-a.xlsx");
        let second_path = directory.path().join("unit-b.xlsx");
        export_workbook(
            &first_path,
            &[sample_unit(
                &first_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ А",
                "08.10.2026",
                10,
            )],
        )
        .unwrap();
        export_workbook(
            &second_path,
            &[sample_unit(
                &second_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ Б",
                "09.10.2026",
                12,
            )],
        )
        .unwrap();
        let error = parse_collection(&[first_path, second_path]).unwrap_err();
        assert!(error.contains("різні дати"));
    }

    #[test]
    fn rejects_duplicate_files_and_duplicate_units() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("unit-a.xlsx");
        let second_path = directory.path().join("unit-a-copy.xlsx");
        export_workbook(
            &first_path,
            &[sample_unit(
                &first_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ А",
                "08.10.2026",
                10,
            )],
        )
        .unwrap();
        let duplicate_file_error =
            parse_collection(&[first_path.clone(), first_path.clone()]).unwrap_err();
        assert!(duplicate_file_error.contains("дублює"));

        export_workbook(
            &second_path,
            &[sample_unit(
                &second_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ А",
                "08.10.2026",
                11,
            )],
        )
        .unwrap();
        let duplicate_unit_error = parse_collection(&[first_path, second_path]).unwrap_err();
        assert!(duplicate_unit_error.contains("трапляється у кількох файлах"));
    }

    #[test]
    fn rejects_a_corrupted_workbook() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("broken.xlsx");
        std::fs::write(&path, b"not an xlsx archive").unwrap();
        let error = parse_file(&path).unwrap_err();
        assert!(error.contains("пошкоджений або невалідний XLSX"));
    }

    #[test]
    fn rejects_macro_enabled_input() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("input.xlsm");
        std::fs::write(&path, b"not inspected because the extension is unsupported").unwrap();

        let error = parse_file(&path).unwrap_err();

        assert!(error.contains("підтримуються лише файли .xlsx"));
    }

    #[test]
    fn exports_macro_free_summary_with_analytics_and_no_service_sheets() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("summary.xlsx");
        let units = [
            sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ Б", "08.10.2026", 12),
            sample_unit(&path, "ТЕСТОВИЙ ПІДРОЗДІЛ А", "08.10.2026", 10),
        ];
        export_workbook(&path, &units).unwrap();
        let file = File::open(&path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let xml = archive_text(&mut archive, "xl/worksheets/sheet1.xml");
        let first = xml.find("ТЕСТОВИЙ ПІДРОЗДІЛ Б").unwrap();
        let second = xml.find("ТЕСТОВИЙ ПІДРОЗДІЛ А").unwrap();
        assert!(first < second);
        assert_eq!(xml.matches("ЗВЕДЕНИЙ БЧС:").count(), 1);
        assert!(xml.contains(">22</v>"));
        assert!(!xml.contains("<f>"));
        assert!(xml.contains("<autoFilter ref=\"A4:P"));
        assert!(!xml.contains("<hyperlinks>"));
        assert!(!xml.contains("<legacyDrawing "));
        assert!(!xml.contains("<control "));
        assert!(!xml.contains("LocationFilter"));

        let workbook = archive_text(&mut archive, "xl/workbook.xml");
        let bcs = workbook.find("name=\"БЧС\"").unwrap();
        let analytics = workbook.find("name=\"Аналітика\"").unwrap();
        assert!(bcs < analytics);
        assert_eq!(workbook.matches("<sheet ").count(), 2);
        assert!(!workbook.contains("Фільтр за місцем"));
        assert!(!workbook.contains("Довідники"));
        let workbook_rels = archive_text(&mut archive, "xl/_rels/workbook.xml.rels");
        assert!(workbook_rels.contains("worksheets/sheet1.xml"));
        assert!(workbook_rels.contains("worksheets/sheet2.xml"));
        assert!(!workbook_rels.contains("vbaProject"));
        assert!(!workbook_rels.contains("worksheets/sheet3.xml"));

        let analytics_xml = archive_text(&mut archive, "xl/worksheets/sheet2.xml");
        assert!(analytics_xml.contains("АНАЛІТИКА ЗВЕДЕНОГО БЧС"));
        assert!(analytics_xml.contains("Це не динаміка в часі"));
        assert!(analytics_xml.contains("По штату"));
        assert!(analytics_xml.contains("Укомплектованість, %"));
        assert!(analytics_xml.contains("Дефіцит до штату"));
        assert!(analytics_xml.contains("Наявність від списку, %"));
        assert!(analytics_xml.contains("Причини відсутності"));
        assert!(analytics_xml.contains("Статуси екіпажів"));
        assert!(analytics_xml.contains("Типи БпАК (лише ненульові)"));
        assert!(analytics_xml.contains("Місця (лише ненульові)"));
        assert!(analytics_xml.contains("<drawing r:id=\"rIdDrawing\"/>"));

        let content_types = archive_text(&mut archive, "[Content_Types].xml");
        assert!(content_types.contains("drawingml.chart+xml"));
        assert!(!content_types.contains("/xl/worksheets/sheet3.xml"));
        assert!(content_types.contains(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
        ));
        assert!(!content_types.contains("macroEnabled"));
        assert!(!content_types.contains("vbaProject"));
        assert!(!content_types.contains("activeX"));
        assert!(archive.by_name("xl/worksheets/sheet3.xml").is_err());

        let drawing = archive_text(&mut archive, "xl/drawings/drawing1.xml");
        assert_eq!(drawing.matches("<c:chart ").count(), 5);
        let drawing_rels = archive_text(&mut archive, "xl/drawings/_rels/drawing1.xml.rels");
        assert_eq!(drawing_rels.matches("relationships/chart").count(), 5);
        let first_chart = archive_text(&mut archive, "xl/drawings/charts/chart1.xml");
        assert!(first_chart.contains("Штат, список і наявність за підрозділами"));
        assert!(first_chart.contains("'Аналітика'!$A$6:$A$7"));
        assert!(first_chart.contains("'Аналітика'!$B$6:$B$7"));
        assert!(first_chart.contains("'Аналітика'!$C$6:$C$7"));
        assert!(first_chart.contains("'Аналітика'!$D$6:$D$7"));
        assert!(first_chart.contains("<c:majorUnit val=\"5\"/>"));
        let second_chart = archive_text(&mut archive, "xl/drawings/charts/chart2.xml");
        assert!(second_chart.contains("'Аналітика'!$E$6:$E$7"));
        assert!(second_chart.contains("'Аналітика'!$G$6:$G$7"));
        assert!(second_chart.contains("<c:majorUnit val=\"10\"/>"));
        let third_chart = archive_text(&mut archive, "xl/drawings/charts/chart3.xml");
        assert!(third_chart.contains("<c:majorUnit val=\"1\"/>"));

        let part_names = archive.file_names().map(str::to_string).collect::<Vec<_>>();
        assert!(!part_names.iter().any(|name| name.contains("Довідники")));
        assert!(!part_names.iter().any(|name| name.contains("activeX")));
        assert!(!part_names.iter().any(|name| name.contains("vbaProject")));
        assert!(!part_names.iter().any(|name| name.contains("vmlDrawing")));
    }

    #[test]
    fn summary_export_rejects_macro_enabled_extension() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("unit-a.xlsx");
        let second_path = directory.path().join("unit-b.xlsx");
        export_workbook(
            &first_path,
            &[sample_unit(
                &first_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ А",
                "08.10.2026",
                10,
            )],
        )
        .unwrap();
        export_workbook(
            &second_path,
            &[sample_unit(
                &second_path,
                "ТЕСТОВИЙ ПІДРОЗДІЛ Б",
                "08.10.2026",
                10,
            )],
        )
        .unwrap();
        let first = parse_file(&first_path).unwrap();
        let second = parse_file(&second_path).unwrap();
        let output_path = directory.path().join("summary.xlsm");

        let error = export_request(ExportRequest {
            paths: vec![
                first_path.to_string_lossy().into_owned(),
                second_path.to_string_lossy().into_owned(),
            ],
            unit_order: vec![first.id, second.id],
            output_path: output_path.to_string_lossy().into_owned(),
        })
        .unwrap_err();

        assert!(error.contains(".xlsx"));
        assert!(!output_path.exists());
    }
}
