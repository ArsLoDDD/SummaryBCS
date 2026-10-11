use crate::xlsx;
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

const CREW_STATUSES: [&str; 3] = ["Працюючий", "Формується", "Не активний"];
const UAV_TYPES: [&str; 7] = [
    "ФПВ",
    "ФПВ Перехоплювач",
    "Коптер",
    "Бомбер",
    "Літаковий Розвідувальний",
    "Літаковий Ударний",
    "НРК",
];
const SUMMARY_UAV_TYPES: [&str; 7] = [
    "Бомбер",
    "Коптер",
    "Літаковий Розвідувальний",
    "Літаковий Ударний",
    "НРК",
    "ФПВ",
    "ФПВ Перехоплювач",
];
const RANKS: [&str; 18] = [
    "рекрут",
    "солдат",
    "старший солдат",
    "молодший сержант",
    "сержант",
    "старший сержант",
    "головний сержант",
    "штаб-сержант",
    "майстер-сержант",
    "старший майстер-сержант",
    "головний майстер-сержант",
    "молодший лейтенант",
    "лейтенант",
    "старший лейтенант",
    "капітан",
    "майор",
    "підполковник",
    "полковник",
];
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

#[derive(Debug, Clone, Deserialize)]
struct Schema {
    headers: Vec<String>,
    widths: Vec<f64>,
    locations: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StructureType {
    Company,
    Platoon,
    #[serde(alias = "separate")]
    Independent,
    Custom,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub enum BlockKind {
    #[serde(rename = "companyManagement", alias = "company")]
    CompanyManagement,
    #[serde(rename = "platoonManagement", alias = "platoon")]
    PlatoonManagement,
    #[serde(rename = "crew")]
    Crew,
    #[serde(rename = "department", alias = "section")]
    Department,
    #[serde(rename = "informationDepartment", alias = "informationSection")]
    InformationDepartment,
    #[serde(rename = "independent", alias = "separate")]
    Independent,
    #[serde(rename = "attached")]
    Attached,
    #[serde(rename = "operationalSubordination")]
    OperationalSubordination,
    #[serde(rename = "temporary")]
    Temporary,
    #[serde(rename = "unassigned")]
    Unassigned,
    #[serde(rename = "custom", alias = "other")]
    Custom,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureBlock {
    id: String,
    kind: BlockKind,
    name: String,
    #[serde(default)]
    position_name: String,
    slots: u32,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    uav_type: Option<String>,
    #[serde(default)]
    bro: String,
    #[serde(default)]
    work_sector: String,
    #[serde(default)]
    uav_name: String,
    #[serde(default)]
    crew_actual: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRequest {
    unit_name: String,
    report_date: String,
    structure_type: StructureType,
    authorized_strength: u32,
    blocks: Vec<StructureBlock>,
    output_path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonInput {
    #[serde(default)]
    block_id: String,
    #[serde(default)]
    position: String,
    #[serde(default)]
    rank: String,
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    duties: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilledBcsRequest {
    unit_name: String,
    report_date: String,
    structure_type: StructureType,
    authorized_strength: u32,
    blocks: Vec<StructureBlock>,
    #[serde(default)]
    people: Vec<PersonInput>,
    output_path: String,
}

#[derive(Debug, Clone)]
struct PreparedBlock {
    id: String,
    kind: BlockKind,
    name: String,
    position_name: String,
    section: String,
    slots: usize,
    status: String,
    uav_type: String,
    bro: String,
    work_sector: String,
    uav_name: String,
    crew_actual: u32,
    people: Vec<PersonInput>,
    start_row: usize,
    end_row: usize,
}

#[derive(Debug)]
struct PreparedRequest {
    unit_name: String,
    report_date: String,
    authorized_strength: u32,
    blocks: Vec<PreparedBlock>,
    output_path: PathBuf,
}

pub fn export_template(request: TemplateRequest) -> Result<String, String> {
    let prepared = prepare(
        request.unit_name,
        request.report_date,
        request.structure_type,
        request.authorized_strength,
        request.blocks,
        Vec::new(),
        false,
        request.output_path,
    )?;
    export_prepared(&prepared)
}

pub fn export_filled(request: FilledBcsRequest) -> Result<String, String> {
    let prepared = prepare(
        request.unit_name,
        request.report_date,
        request.structure_type,
        request.authorized_strength,
        request.blocks,
        request.people,
        true,
        request.output_path,
    )?;
    export_prepared(&prepared)
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

fn valid_date(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() != 2 || parts[1].len() != 2 || parts[2].len() != 4 {
        return false;
    }
    let (Ok(day), Ok(month), Ok(year)) = (
        parts[0].parse::<u8>(),
        parts[1].parse::<u8>(),
        parts[2].parse::<u16>(),
    ) else {
        return false;
    };
    (1..=31).contains(&day) && (1..=12).contains(&month) && year >= 2000
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

fn canonical_location(value: &str, locations: &[String]) -> Result<String, String> {
    let normalized = normalize(value);
    locations
        .iter()
        .find(|candidate| normalize(candidate) == normalized)
        .cloned()
        .ok_or_else(|| {
            format!("Невідоме місце «{value}». Оберіть значення зі списку «Де знаходиться».")
        })
}

fn block_order(kind: BlockKind) -> u8 {
    match kind {
        BlockKind::Crew => 0,
        BlockKind::CompanyManagement => 1,
        BlockKind::PlatoonManagement => 2,
        BlockKind::Department | BlockKind::InformationDepartment => 3,
        BlockKind::Independent => 4,
        BlockKind::Custom => 5,
        BlockKind::Attached => 6,
        BlockKind::OperationalSubordination => 7,
        BlockKind::Temporary => 8,
        BlockKind::Unassigned => 9,
    }
}

fn default_block_name(kind: BlockKind) -> &'static str {
    match kind {
        BlockKind::CompanyManagement => "Управління роти",
        BlockKind::PlatoonManagement => "Управління взводу",
        BlockKind::Crew => "Екіпаж",
        BlockKind::Department => "Відділення",
        BlockKind::InformationDepartment => "Відділення збору та обробки інформації",
        BlockKind::Independent => "Окремий підрозділ",
        BlockKind::Attached => "Прикомандировані",
        BlockKind::OperationalSubordination => "Оперативне підпорядкування",
        BlockKind::Temporary => "Тимчасово прибулі",
        BlockKind::Unassigned => "Не розподілені",
        BlockKind::Custom => "Інші",
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare(
    unit_name: String,
    report_date: String,
    structure_type: StructureType,
    authorized_strength: u32,
    blocks: Vec<StructureBlock>,
    people: Vec<PersonInput>,
    require_complete_people: bool,
    output_path: String,
) -> Result<PreparedRequest, String> {
    let schema = schema()?;
    let unit_name = validate_text(&unit_name, "Назва підрозділу", 200, true)?;
    let report_date = report_date.trim().to_string();
    if !valid_date(&report_date) {
        return Err("Дата має бути у форматі ДД.ММ.РРРР.".into());
    }
    if authorized_strength == 0 || authorized_strength > 20_000 {
        return Err("Чисельність за штатом має бути від 1 до 20 000.".into());
    }
    if blocks.is_empty() {
        return Err("Додайте хоча б один блок структури.".into());
    }
    if blocks.len() > 2_000 {
        return Err("У структурі забагато блоків (максимум 2 000).".into());
    }
    for (kind, label) in [
        (BlockKind::CompanyManagement, "Управління роти"),
        (BlockKind::PlatoonManagement, "Управління взводу"),
        (BlockKind::Custom, "Інші"),
    ] {
        if blocks.iter().filter(|block| block.kind == kind).count() > 1 {
            return Err(format!("Блок «{label}» можна додати лише один раз."));
        }
    }
    let company_management_count = blocks
        .iter()
        .filter(|block| block.kind == BlockKind::CompanyManagement)
        .count();
    let platoon_management_count = blocks
        .iter()
        .filter(|block| block.kind == BlockKind::PlatoonManagement)
        .count();
    match structure_type {
        StructureType::Company if company_management_count != 1 => {
            return Err("Структура роти повинна містити одне управління роти.".into());
        }
        StructureType::Platoon if platoon_management_count != 1 => {
            return Err("Структура взводу повинна містити одне управління взводу.".into());
        }
        StructureType::Platoon if company_management_count != 0 => {
            return Err("У структурі взводу не може бути управління роти.".into());
        }
        _ => {}
    }

    let output_path = PathBuf::from(output_path.trim());
    if output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        return Err("Файл БЧС повинен мати розширення .xlsx.".into());
    }

    let mut ids = HashSet::new();
    let mut slots_total = 0u32;
    let mut normalized_blocks = Vec::with_capacity(blocks.len());
    for block in blocks {
        let id = validate_text(&block.id, "ID блоку", 100, true)?;
        if !ids.insert(id.clone()) {
            return Err(format!("ID блоку «{id}» повторюється."));
        }
        let raw_name = if block.name.trim().is_empty() {
            default_block_name(block.kind)
        } else {
            &block.name
        };
        let name = validate_text(raw_name, "Назва блоку", 200, true)?;
        let position_name = validate_text(&block.position_name, "Назва позиції", 200, false)?;
        if block.slots == 0 || block.slots > 2_000 {
            return Err(format!(
                "У блоці «{name}» кількість місць має бути від 1 до 2 000."
            ));
        }
        slots_total = slots_total
            .checked_add(block.slots)
            .ok_or_else(|| "Загальна кількість місць завелика.".to_string())?;
        if slots_total > 20_000 {
            return Err(
                "Загальна кількість рядків у структурі не може перевищувати 20 000.".into(),
            );
        }

        let (status, uav_type) = if block.kind == BlockKind::Crew {
            let raw_status = block.status.as_deref().unwrap_or("").trim();
            let raw_uav_type = block.uav_type.as_deref().unwrap_or("").trim();
            if raw_status.is_empty() {
                return Err(format!("Оберіть статус для екіпажу «{name}»."));
            }
            if raw_uav_type.is_empty() {
                return Err(format!("Оберіть тип БпАК для екіпажу «{name}»."));
            }
            (
                canonical(raw_status, &CREW_STATUSES, "Статус екіпажу")?,
                canonical(raw_uav_type, &UAV_TYPES, "Тип БпАК")?,
            )
        } else {
            (String::new(), String::new())
        };
        let (bro, work_sector, uav_name) = if block.kind == BlockKind::Crew {
            (
                validate_text(&block.bro, "БРО екіпажу", 200, false)?,
                validate_text(&block.work_sector, "Сектор роботи екіпажу", 200, false)?,
                validate_text(&block.uav_name, "Назва БпАК екіпажу", 250, false)?,
            )
        } else {
            (String::new(), String::new(), String::new())
        };
        let crew_actual = if block.kind == BlockKind::Crew {
            if block.crew_actual > 2_000 {
                return Err(format!(
                    "В екіпажі «{name}» фактична кількість осіб має бути від 0 до 2 000."
                ));
            }
            block.crew_actual
        } else {
            0
        };

        normalized_blocks.push(PreparedBlock {
            id,
            kind: block.kind,
            section: section_for(block.kind, &name),
            name,
            position_name,
            slots: block.slots as usize,
            status,
            uav_type,
            bro,
            work_sector,
            uav_name,
            crew_actual,
            people: Vec::new(),
            start_row: 0,
            end_row: 0,
        });
    }
    normalized_blocks.sort_by_key(|block| block_order(block.kind));
    let block_indices = normalized_blocks
        .iter()
        .enumerate()
        .map(|(index, block)| (block.id.clone(), index))
        .collect::<HashMap<_, _>>();
    for mut person in people {
        let block_id = person.block_id.trim().to_string();
        let Some(&block_index) = block_indices.get(&block_id) else {
            return Err(format!(
                "Запис людини посилається на невідомий блок «{block_id}»."
            ));
        };
        person.block_id = block_id;
        person.position = validate_text(&person.position, "Посада", 250, false)?;
        person.rank = validate_text(&person.rank, "Військове звання", 100, false)?;
        person.full_name = validate_text(&person.full_name, "П.І.Б.", 250, false)?;
        person.duties = validate_text(&person.duties, "Функціональні обов’язки", 1_000, false)?;
        person.location = validate_text(&person.location, "Де знаходиться", 200, false)?;
        if !person.location.is_empty() {
            person.location = canonical_location(&person.location, &schema.locations)?;
        }
        person.note = validate_text(&person.note, "Примітка", 1_000, false)?;
        if require_complete_people {
            let mut missing = Vec::new();
            if person.rank.trim().is_empty() {
                missing.push("Звання");
            }
            if person.full_name.trim().is_empty() {
                missing.push("П.І.Б.");
            }
            if person.location.trim().is_empty() {
                missing.push("Де знаходиться");
            }
            if !missing.is_empty() {
                return Err(format!(
                    "Заповніть кожне створене місце. Для кожної людини вкажіть: {}.",
                    missing.join(", ")
                ));
            }
        }
        normalized_blocks[block_index].people.push(person);
    }

    let mut cursor = 7usize;
    for block in &mut normalized_blocks {
        if block.people.len() > block.slots {
            return Err(format!(
                "Для блоку «{}» додано {} записів, але передбачено лише {} місць.",
                block.name,
                block.people.len(),
                block.slots
            ));
        }
        if require_complete_people && block.people.len() < block.slots {
            return Err(format!(
                "Заповніть усі створені місця. У блоці «{}» заповнено {} з {}. Обов’язково вкажіть: Звання, П.І.Б., Де знаходиться.",
                block.name,
                block.people.len(),
                block.slots
            ));
        }
        block.people.resize(block.slots, PersonInput::default());
        block.start_row = cursor;
        block.end_row = cursor + block.slots - 1;
        cursor = block.end_row + 1;
    }

    Ok(PreparedRequest {
        unit_name,
        report_date,
        authorized_strength,
        blocks: normalized_blocks,
        output_path,
    })
}

fn section_for(kind: BlockKind, name: &str) -> String {
    match kind {
        BlockKind::CompanyManagement => "Управління роти".into(),
        BlockKind::PlatoonManagement => "Управління взводу".into(),
        BlockKind::Crew => "Екіпаж".into(),
        BlockKind::Department
        | BlockKind::InformationDepartment
        | BlockKind::Independent
        | BlockKind::Custom => capitalize_first_letter(name),
        BlockKind::Attached => "Прикомандировані".into(),
        BlockKind::OperationalSubordination => "Оперативне підпорядкування".into(),
        BlockKind::Temporary => "Тимчасово прибулі".into(),
        BlockKind::Unassigned => "Не розподілені".into(),
    }
}

fn export_prepared(request: &PreparedRequest) -> Result<String, String> {
    let schema = schema()?;
    let bcs_sheet = build_bcs_sheet(request, &schema)?;
    xlsx::write_bcs_workbook(
        &request.output_path,
        &bcs_sheet,
        &bcs_styles(),
        include_str!("../resources/bcs-reference-theme.xml"),
    )?;
    Ok(request.output_path.to_string_lossy().into_owned())
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

fn formula_cell(
    column_index: usize,
    row: usize,
    formula: &str,
    cached: i64,
    style: usize,
) -> String {
    format!(
        "<c r=\"{}{row}\" s=\"{style}\"><f>{}</f><v>{cached}</v></c>",
        column(column_index),
        esc(formula)
    )
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
    let extra_dxfs = ["D7E48D", "E6B8B7", "C7BED0", "FCD5B4"]
        .iter()
        .map(|color| format!("<dxf><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF{color}\"/><bgColor rgb=\"FF{color}\"/></patternFill></fill></dxf>"))
        .collect::<String>();
    let mut styles = include_str!("../resources/bcs-reference-styles.xml")
        .replace("<fills count=\"10\">", "<fills count=\"19\">")
        .replace("</fills>", &format!("{fills}</fills>"))
        .replace("<cellXfs count=\"171\">", "<cellXfs count=\"180\">")
        .replace("</cellXfs>", &format!("{formats}</cellXfs>"))
        .replace("<dxfs count=\"8\">", "<dxfs count=\"12\">")
        .replace("</dxfs>", &format!("{extra_dxfs}</dxfs>"));

    // Apple Numbers may use bgColor instead of fgColor for conditional fills.
    // Keep both colors identical so status colors render consistently.
    for color in [
        "CCC0DA", "D7E4BD", "DBEEF4", "F2DCDB", "FDEADA", "00B0F0", "D7E48D", "E6B8B7", "C7BED0",
        "FCD5B4",
    ] {
        styles = styles.replace(
            &format!("<fgColor rgb=\"FF{color}\"/><bgColor rgb=\"FF000000\"/>"),
            &format!("<fgColor rgb=\"FF{color}\"/><bgColor rgb=\"FF{color}\"/>"),
        );
    }
    styles
}

fn style_for(block: &PreparedBlock) -> usize {
    match block.kind {
        BlockKind::Crew => match block.status.as_str() {
            "Працюючий" => 171,
            "Формується" => 172,
            _ => 173,
        },
        BlockKind::CompanyManagement => 174,
        BlockKind::PlatoonManagement => 175,
        BlockKind::Department | BlockKind::InformationDepartment | BlockKind::Independent => 176,
        BlockKind::Custom | BlockKind::Unassigned => 177,
        BlockKind::Attached | BlockKind::OperationalSubordination => 178,
        BlockKind::Temporary => 179,
    }
}

fn build_bcs_sheet(request: &PreparedRequest, schema: &Schema) -> Result<String, String> {
    let data_end = request
        .blocks
        .last()
        .map(|block| block.end_row)
        .ok_or_else(|| "Структура порожня.".to_string())?;
    let mut merges = vec!["A1:O2".to_string(), "A6:P6".to_string()];
    let mut sheet = String::from(
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"6\" topLeftCell=\"A7\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols>",
    );
    for (index, width) in schema.widths.iter().enumerate() {
        sheet.push_str(&format!(
            "<col min=\"{}\" max=\"{}\" width=\"{width}\" customWidth=\"1\"/>",
            index + 1,
            index + 1
        ));
    }
    sheet.push_str("<col min=\"17\" max=\"19\" width=\"0\" hidden=\"1\" customWidth=\"1\"/></cols><sheetData><row r=\"1\" ht=\"18\" customHeight=\"1\">");
    sheet.push_str(&text_cell(
        0,
        1,
        &format!(
            "БЧС\n{} 419 окремого батальйону безпілотних систем\nстаном на 08:00 год {} року",
            request.unit_name, request.report_date
        ),
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
    sheet.push_str("</row><row r=\"6\" ht=\"20\" customHeight=\"1\">");
    sheet.push_str(&text_cell(0, 6, &request.unit_name, 6));
    // Preserve the merged band's right edge in viewers that do not infer it.
    sheet.push_str(&text_cell(15, 6, "", 6));
    sheet.push_str("</row>");

    let mut crew_validation_cells = Vec::new();
    let mut seen_crew_people = HashSet::new();
    for block in &request.blocks {
        let style = style_for(block);
        if block.slots > 1 {
            for index in 0..10 {
                merges.push(format!(
                    "{}{}:{}{}",
                    column(index),
                    block.start_row,
                    column(index),
                    block.end_row
                ));
            }
        }
        if block.kind == BlockKind::Crew {
            crew_validation_cells.push(block.start_row);
        }
        for (offset, person) in block.people.iter().enumerate() {
            let row = block.start_row + offset;
            sheet.push_str(&format!("<row r=\"{row}\" ht=\"40\" customHeight=\"1\">"));
            if offset == 0 {
                sheet.push_str(&text_cell(0, row, &block.section, style));
                let crew_name = block.name.to_uppercase();
                sheet.push_str(&text_cell(
                    1,
                    row,
                    &block.position_name.to_uppercase(),
                    style,
                ));
                sheet.push_str(&text_cell(2, row, &block.bro.to_uppercase(), style));
                sheet.push_str(&text_cell(3, row, &block.work_sector.to_uppercase(), style));
                sheet.push_str(&text_cell(
                    4,
                    row,
                    if block.kind == BlockKind::Crew {
                        &crew_name
                    } else {
                        ""
                    },
                    style,
                ));
                if block.kind == BlockKind::Crew {
                    sheet.push_str(&number_cell(5, row, block.crew_actual as i64, style));
                } else {
                    sheet.push_str(&text_cell(5, row, "", style));
                }
                sheet.push_str(&number_cell(6, row, block.slots as i64, style));
                sheet.push_str(&text_cell(7, row, &block.status, style));
                sheet.push_str(&text_cell(8, row, &block.uav_name, style));
                sheet.push_str(&text_cell(9, row, &block.uav_type, style));
            } else {
                // Keep a styled cell in every merged row. Excel, Numbers and
                // LibreOffice then render the vertical and bottom borders of
                // A:J consistently instead of relying on merged-cell inference.
                for column_index in 0..10 {
                    sheet.push_str(&text_cell(column_index, row, "", style));
                }
            }
            sheet.push_str(&text_cell(10, row, &person.position, style));
            sheet.push_str(&text_cell(11, row, &person.rank, style));
            sheet.push_str(&text_cell(
                12,
                row,
                &format_full_name(&person.full_name),
                style,
            ));
            sheet.push_str(&text_cell(13, row, &person.duties, style));
            sheet.push_str(&text_cell(14, row, &person.location, style));
            sheet.push_str(&text_cell(15, row, &person.note, style));
            // Q is hidden and repeats the section on every personnel row so formulas
            // stay correct while A:J visually match the merged reference layout.
            sheet.push_str(&text_cell(16, row, &block.section, 0));
            // R marks the first occurrence of every person in a crew. This
            // keeps the visible summary formula simple and compatible with
            // desktop Excel while still preventing duplicate P.I.B. counts.
            let unique_crew_person = block.kind == BlockKind::Crew
                && !person.full_name.is_empty()
                && seen_crew_people.insert(person.full_name.to_uppercase());
            let unique_formula = format!(
                "IF(AND($Q{row}=\"Екіпаж\",$M{row}<>\"\"),IF(COUNTIFS($Q$7:$Q{row},\"Екіпаж\",$M$7:$M{row},$M{row})=1,1,0),0)"
            );
            sheet.push_str(&formula_cell(
                17,
                row,
                &unique_formula,
                i64::from(unique_crew_person),
                0,
            ));
            // S is a stable crew-header marker. It is 1 exactly once per crew,
            // so exported crew totals never depend on merged visible cells.
            sheet.push_str(&number_cell(
                18,
                row,
                i64::from(block.kind == BlockKind::Crew && offset == 0),
                0,
            ));
            sheet.push_str("</row>");
        }
    }

    let summary_row = data_end + 3;
    write_summary(&mut sheet, summary_row, data_end, request, schema)?;
    sheet.push_str("</sheetData>");
    sheet.push_str(&format!(
        "<mergeCells count=\"{}\">{}</mergeCells>",
        merges.len(),
        merges
            .iter()
            .map(|range| format!("<mergeCell ref=\"{range}\"/>"))
            .collect::<String>()
    ));

    let format_range = format!("A7:P{data_end}");
    let lookup = "IFERROR(LOOKUP(2,1/($H$7:$H7&lt;&gt;&quot;&quot;),$H$7:$H7),&quot;&quot;)";
    sheet.push_str(&format!(
        "<conditionalFormatting sqref=\"{format_range}\"><cfRule type=\"expression\" dxfId=\"8\" priority=\"1\"><formula>AND($Q7=&quot;Екіпаж&quot;,{lookup}=&quot;Працюючий&quot;)</formula></cfRule><cfRule type=\"expression\" dxfId=\"4\" priority=\"2\"><formula>AND($Q7=&quot;Екіпаж&quot;,{lookup}=&quot;Формується&quot;)</formula></cfRule><cfRule type=\"expression\" dxfId=\"9\" priority=\"3\"><formula>AND($Q7=&quot;Екіпаж&quot;,{lookup}=&quot;Не активний&quot;)</formula></cfRule></conditionalFormatting>"
    ));

    let h_cells = crew_validation_cells
        .iter()
        .map(|row| format!("H{row}"))
        .collect::<Vec<_>>()
        .join(" ");
    let j_cells = crew_validation_cells
        .iter()
        .map(|row| format!("J{row}"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut validations = Vec::new();
    if !crew_validation_cells.is_empty() {
        validations.push(inline_data_validation(
            &h_cells,
            CREW_STATUSES.iter().copied(),
            "Оберіть статус зі списку.",
        )?);
        validations.push(inline_data_validation(
            &j_cells,
            UAV_TYPES.iter().copied(),
            "Оберіть тип БпАК зі списку.",
        )?);
    }
    validations.push(inline_data_validation(
        &format!("L7:L{data_end}"),
        RANKS.iter().copied(),
        "Оберіть військове звання зі списку.",
    )?);
    validations.push(inline_data_validation(
        &format!("O7:O{data_end}"),
        schema.locations.iter().map(String::as_str),
        "Оберіть місце зі списку.",
    )?);
    sheet.push_str(&format!(
        "<dataValidations count=\"{}\">{}</dataValidations>",
        validations.len(),
        validations.concat()
    ));

    sheet.push_str("<pageMargins left=\"0.25\" right=\"0.25\" top=\"0.3\" bottom=\"0.3\" header=\"0\" footer=\"0\"/><pageSetup paperSize=\"8\" orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>");
    Ok(sheet)
}

fn inline_data_validation<'a>(
    cells: &str,
    values: impl IntoIterator<Item = &'a str>,
    error: &str,
) -> Result<String, String> {
    let values = values.into_iter().collect::<Vec<_>>();
    if values.is_empty() {
        return Err("Випадаючий список не може бути порожнім.".into());
    }
    if values
        .iter()
        .any(|value| value.contains(',') || value.contains('"'))
    {
        return Err("Значення випадаючого списку не може містити кому або лапки.".into());
    }

    // Excel limits a literal data-validation list (including its surrounding
    // quotes) to 255 UTF-16 code units. Keeping the values inline removes the
    // need for a separate lookup worksheet or workbook-level defined names.
    let formula = format!("\"{}\"", values.join(","));
    if formula.encode_utf16().count() > 255 {
        return Err("Випадаючий список перевищує обмеження Excel у 255 символів.".into());
    }

    Ok(format!(
        "<dataValidation type=\"list\" allowBlank=\"1\" showErrorMessage=\"1\" errorStyle=\"stop\" errorTitle=\"Недопустиме значення\" error=\"{}\" sqref=\"{}\"><formula1>{}</formula1></dataValidation>",
        esc(error),
        esc(cells),
        esc(&formula),
    ))
}

fn countifs_formula(data_end: usize, extra_pairs: &[(&str, &str)], exclude_absent: bool) -> String {
    let mut formula = format!("COUNTIFS($M$7:$M${data_end},\"<>\"");
    for (column, criterion) in extra_pairs {
        formula.push_str(&format!(
            ",$${column}$$7:$${column}$${data_end},\"{}\"",
            formula_text(criterion)
        ));
    }
    if exclude_absent {
        for location in ABSENT_LOCATIONS {
            formula.push_str(&format!(
                ",$O$7:$O${data_end},\"{}\"",
                formula_text(&format!("<>{location}"))
            ));
        }
    }
    formula.push(')');
    // The doubled dollar signs above make the format string readable. OOXML
    // formulas themselves need a single dollar sign.
    formula.replace("$$", "$")
}

fn formula_text(value: &str) -> String {
    value.replace('"', "\"\"")
}

fn capitalize_name_part(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut capitalize_next = true;
    for character in value.chars() {
        if character.is_alphabetic() {
            if capitalize_next {
                result.extend(character.to_uppercase());
            } else {
                result.extend(character.to_lowercase());
            }
            capitalize_next = false;
        } else {
            result.push(character);
            capitalize_next = matches!(character, '-' | '\'' | '’' | '.');
        }
    }
    result
}

fn capitalize_first_letter(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut capitalized = false;
    for character in value.chars() {
        if !capitalized && character.is_alphabetic() {
            result.extend(character.to_uppercase());
            capitalized = true;
        } else {
            result.push(character);
        }
    }
    result
}

fn format_full_name(value: &str) -> String {
    value
        .split_whitespace()
        .enumerate()
        .map(|(index, part)| {
            if index == 0 {
                part.to_uppercase()
            } else {
                capitalize_name_part(part)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_external_kind(kind: BlockKind) -> bool {
    matches!(
        kind,
        BlockKind::Attached | BlockKind::OperationalSubordination | BlockKind::Temporary
    )
}

fn crew_status_group(status: &str) -> &'static str {
    let normalized = status.to_uppercase().replace(' ', "");
    if normalized.starts_with("ФОРМ") {
        "forming"
    } else if normalized.starts_with("ПРАЦ") || normalized == "АКТИВНИЙ" {
        "working"
    } else {
        "inactive"
    }
}

fn crew_status_formulas(data_end: usize) -> (String, String, String) {
    let crew_count = crew_count_formula(data_end);
    let forming = format!("COUNTIFS($S$7:$S${data_end},1,$H$7:$H${data_end},\"Формується\")");
    let working = format!(
        "COUNTIFS($S$7:$S${data_end},1,$H$7:$H${data_end},\"Працюючий\")+COUNTIFS($S$7:$S${data_end},1,$H$7:$H${data_end},\"Активний\")"
    );
    let inactive = format!("({crew_count})-({forming})-({working})");
    (forming, working, inactive)
}

fn crew_count_formula(data_end: usize) -> String {
    format!("SUM($S$7:$S${data_end})")
}

fn crew_personnel_formula(data_end: usize) -> String {
    format!("SUM($R$7:$R${data_end})")
}

fn write_summary(
    sheet: &mut String,
    summary: usize,
    data_end: usize,
    request: &PreparedRequest,
    schema: &Schema,
) -> Result<(), String> {
    let all_people = request
        .blocks
        .iter()
        .flat_map(|block| block.people.iter().map(move |person| (block, person)))
        .filter(|(_, person)| !person.full_name.is_empty())
        .collect::<Vec<_>>();
    let temp_acting = |block: &&PreparedBlock, person: &&PersonInput| {
        block.kind == BlockKind::Temporary && person.position.to_uppercase().contains("ТВО")
    };
    let is_own = |block: &&PreparedBlock| !is_external_kind(block.kind);
    let by_list = all_people
        .iter()
        .filter(|(block, person)| is_own(block) || temp_acting(block, person))
        .count() as i64;
    let present = all_people
        .iter()
        .filter(|(block, person)| {
            is_own(block) && !ABSENT_LOCATIONS.contains(&person.location.as_str())
        })
        .count() as i64;
    let count_own_location = |location: &str| {
        all_people
            .iter()
            .filter(|(block, person)| is_own(block) && person.location == location)
            .count() as i64
    };
    let count_all_location = |location: &str| {
        all_people
            .iter()
            .filter(|(_, person)| person.location == location)
            .count() as i64
    };

    let own_normal_formula = countifs_formula(
        data_end,
        &[
            ("Q", "<>Прикомандировані"),
            ("Q", "<>Оперативне підпорядкування"),
            ("Q", "<>Тимчасово прибулі"),
        ],
        false,
    );
    let temp_acting_formula = countifs_formula(
        data_end,
        &[("Q", "Тимчасово прибулі"), ("K", "*ТВО*")],
        false,
    );
    let present_normal_formula = countifs_formula(
        data_end,
        &[
            ("Q", "<>Прикомандировані"),
            ("Q", "<>Оперативне підпорядкування"),
            ("Q", "<>Тимчасово прибулі"),
        ],
        true,
    );
    let own_location_formula = |location: &str| {
        countifs_formula(
            data_end,
            &[
                ("O", location),
                ("Q", "<>Прикомандировані"),
                ("Q", "<>Оперативне підпорядкування"),
                ("Q", "<>Тимчасово прибулі"),
            ],
            false,
        )
    };
    let main = vec![
        (
            "По штату".to_string(),
            None,
            request.authorized_strength as i64,
        ),
        (
            "По списку".to_string(),
            Some(format!("{own_normal_formula}+{temp_acting_formula}")),
            by_list,
        ),
        (
            "В наявності".to_string(),
            Some(present_normal_formula),
            present,
        ),
        (
            "Відпустка".to_string(),
            Some(own_location_formula("ВІДП")),
            count_own_location("ВІДП"),
        ),
        (
            "Шпиталь".to_string(),
            Some(format!(
                "{}+{}",
                own_location_formula("ЛІК"),
                own_location_formula("ВЛК")
            )),
            count_own_location("ЛІК") + count_own_location("ВЛК"),
        ),
        (
            "Відрядження".to_string(),
            Some(format!(
                "{}+{}",
                own_location_formula("НАВЧ"),
                own_location_formula("ВІДР")
            )),
            count_own_location("НАВЧ") + count_own_location("ВІДР"),
        ),
        (
            "Відкомандировані".to_string(),
            Some(own_location_formula("Відкомандировані")),
            count_own_location("Відкомандировані"),
        ),
        (
            "Прикомандировані".to_string(),
            Some(countifs_formula(
                data_end,
                &[("Q", "Прикомандировані")],
                false,
            )),
            all_people
                .iter()
                .filter(|(block, _)| block.kind == BlockKind::Attached)
                .count() as i64,
        ),
        (
            "Оперативне підпорядкування".to_string(),
            Some(countifs_formula(
                data_end,
                &[("Q", "Оперативне підпорядкування")],
                false,
            )),
            all_people
                .iter()
                .filter(|(block, _)| block.kind == BlockKind::OperationalSubordination)
                .count() as i64,
        ),
        (
            "ПТЗ Новостав".to_string(),
            Some(own_location_formula("ПТЗ Новостав")),
            count_own_location("ПТЗ Новостав"),
        ),
        (
            "СЗЧ".to_string(),
            Some(own_location_formula("СЗЧ")),
            count_own_location("СЗЧ"),
        ),
        (
            "Тимчасово прибулі".to_string(),
            Some(countifs_formula(
                data_end,
                &[("Q", "Тимчасово прибулі")],
                false,
            )),
            all_people
                .iter()
                .filter(|(block, _)| block.kind == BlockKind::Temporary)
                .count() as i64,
        ),
        (
            "Тимчасово прибулі з ТВО".to_string(),
            Some(temp_acting_formula),
            all_people
                .iter()
                .filter(|(block, person)| temp_acting(block, person))
                .count() as i64,
        ),
    ];

    let unique_crew_personnel = all_people
        .iter()
        .filter(|(block, _)| block.kind == BlockKind::Crew)
        .map(|(_, person)| person.full_name.to_uppercase())
        .collect::<HashSet<_>>()
        .len() as i64;
    let crew_personnel_formula = crew_personnel_formula(data_end);
    let crew_count_formula = crew_count_formula(data_end);
    let total_crews = request
        .blocks
        .iter()
        .filter(|block| block.kind == BlockKind::Crew)
        .count() as i64;
    let forming_crews = request
        .blocks
        .iter()
        .filter(|block| {
            block.kind == BlockKind::Crew && crew_status_group(&block.status) == "forming"
        })
        .count() as i64;
    let working_crews = request
        .blocks
        .iter()
        .filter(|block| {
            block.kind == BlockKind::Crew && crew_status_group(&block.status) == "working"
        })
        .count() as i64;
    let inactive_crews = total_crews - forming_crews - working_crews;

    let mut functional = vec![
        (
            "Екіпажів (ос-загально)".to_string(),
            crew_personnel_formula,
            unique_crew_personnel,
        ),
        (
            "Екіпажів (загально)".to_string(),
            crew_count_formula,
            total_crews,
        ),
    ];
    for uav_type in SUMMARY_UAV_TYPES {
        let crew_count = request
            .blocks
            .iter()
            .filter(|block| block.kind == BlockKind::Crew && block.uav_type == uav_type)
            .count() as i64;
        if crew_count == 0 {
            continue;
        }
        functional.push((
            format!("Екіпажів — {uav_type}"),
            format!(
                "COUNTIFS($S$7:$S${data_end},1,$J$7:$J${data_end},\"{}\")",
                formula_text(uav_type)
            ),
            crew_count,
        ));
    }
    let (forming_formula, working_formula, inactive_formula) = crew_status_formulas(data_end);
    functional.push((
        "Екіпажів — Формуються".to_string(),
        forming_formula.clone(),
        forming_crews,
    ));
    functional.push((
        "Екіпажів — Працюючі".to_string(),
        working_formula.clone(),
        working_crews,
    ));
    functional.push((
        "Екіпажів — Не активні".to_string(),
        inactive_formula,
        inactive_crews,
    ));
    let mut seen_sections = HashSet::new();
    for block in &request.blocks {
        if block.kind == BlockKind::Crew
            || is_external_kind(block.kind)
            || !seen_sections.insert(block.section.clone())
        {
            continue;
        }
        functional.push((
            block.section.clone(),
            countifs_formula(data_end, &[("Q", &block.section)], true),
            all_people
                .iter()
                .filter(|(candidate, person)| {
                    candidate.section == block.section
                        && !ABSENT_LOCATIONS.contains(&person.location.as_str())
                })
                .count() as i64,
        ));
    }

    sheet.push_str(&format!(
        "<row r=\"{summary}\" ht=\"25\" customHeight=\"1\">{}{}</row>",
        text_cell(4, summary, &format!("БЧС {}:", request.unit_name), 5),
        text_cell(8, summary, "БЧС по функціоналу:", 5)
    ));
    // The third title is appended separately to keep the format string readable.
    let insert_at = sheet
        .rfind("</row>")
        .ok_or_else(|| "Не вдалося сформувати підсумок.".to_string())?;
    sheet.insert_str(insert_at, &text_cell(11, summary, "Де знаходиться", 5));

    let row_count = main
        .len()
        .max(functional.len())
        .max(schema.locations.len() + 2);
    for index in 0..row_count {
        let row = summary + index + 1;
        sheet.push_str(&format!("<row r=\"{row}\" ht=\"24\" customHeight=\"1\">"));
        if let Some((label, formula, cached)) = main.get(index) {
            sheet.push_str(&text_cell(4, row, label, 3));
            if let Some(formula) = formula {
                sheet.push_str(&formula_cell(5, row, formula, *cached, 3));
            } else {
                sheet.push_str(&number_cell(5, row, *cached, 3));
            }
        }
        if let Some((label, formula, cached)) = functional.get(index) {
            sheet.push_str(&text_cell(8, row, label, 3));
            sheet.push_str(&formula_cell(9, row, formula, *cached, 3));
        }
        if let Some(location) = schema.locations.get(index) {
            let cached = count_all_location(location);
            let formula = countifs_formula(data_end, &[("O", location)], false);
            sheet.push_str(&text_cell(11, row, location, 3));
            sheet.push_str(&formula_cell(12, row, &formula, cached, 3));
        } else if index == schema.locations.len() {
            let cached = all_people
                .iter()
                .filter(|(_, person)| {
                    person.location.is_empty() || !schema.locations.contains(&person.location)
                })
                .count() as i64;
            let known_total = schema
                .locations
                .iter()
                .map(|location| countifs_formula(data_end, &[("O", location)], false))
                .collect::<Vec<_>>()
                .join("+");
            let formula = format!("COUNTIF($M$7:$M${data_end},\"<>\")-({known_total})");
            sheet.push_str(&text_cell(11, row, "Не вказано / інше", 3));
            sheet.push_str(&formula_cell(12, row, &formula, cached, 3));
        } else if index == schema.locations.len() + 1 {
            sheet.push_str(&text_cell(11, row, "Загалом", 3));
            sheet.push_str(&formula_cell(
                12,
                row,
                &format!("COUNTIF($M$7:$M${data_end},\"<>\")"),
                all_people.len() as i64,
                3,
            ));
        }
        sheet.push_str("</row>");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::File,
        io::Read,
        path::{Path, PathBuf},
    };
    use zip::ZipArchive;

    fn blocks() -> Vec<StructureBlock> {
        vec![
            StructureBlock {
                id: "management".into(),
                kind: BlockKind::CompanyManagement,
                name: "Управління".into(),
                position_name: String::new(),
                slots: 2,
                status: None,
                uav_type: None,
                bro: String::new(),
                work_sector: String::new(),
                uav_name: String::new(),
                crew_actual: 0,
            },
            StructureBlock {
                id: "crew-1".into(),
                kind: BlockKind::Crew,
                name: "екіпаж альфа".into(),
                position_name: "позиція альфа".into(),
                slots: 3,
                status: Some("Працюючий".into()),
                uav_type: Some("ФПВ".into()),
                bro: "бро-1".into(),
                work_sector: "сектор-1".into(),
                uav_name: "Назва БпАК".into(),
                crew_actual: 4,
            },
        ]
    }

    fn complete_people() -> Vec<PersonInput> {
        [
            ("management", "КОМАНДИРЕНКО Один"),
            ("management", "СЕРЖАНТЕНКО Два"),
            ("crew-1", "ІВАНОВ Три"),
            ("crew-1", "ПЕТРЕНКО Чотири"),
            ("crew-1", "СИДОРЕНКО П’ять"),
        ]
        .into_iter()
        .map(|(block_id, full_name)| PersonInput {
            block_id: block_id.into(),
            position: String::new(),
            rank: "солдат".into(),
            full_name: full_name.into(),
            duties: String::new(),
            location: "На позиції".into(),
            note: String::new(),
        })
        .collect()
    }

    fn read_entry(path: &Path, name: &str) -> String {
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

    fn entry_names(path: &Path) -> Vec<String> {
        let file = File::open(path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect()
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

    #[test]
    fn exports_blank_template_with_inline_validations_and_formulas() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("template.xlsx");
        export_template(TemplateRequest {
            unit_name: "ТЕСТОВИЙ ПІДРОЗДІЛ".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: blocks(),
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();

        let workbook = read_entry(&path, "xl/workbook.xml");
        let sheet = read_entry(&path, "xl/worksheets/sheet1.xml");
        let styles = read_entry(&path, "xl/styles.xml");
        let names = entry_names(&path);
        assert!(workbook.contains("<sheet name=\"БЧС\""));
        assert!(workbook.contains("calcMode=\"auto\""));
        assert!(!workbook.contains("Довідники"));
        assert!(!workbook.contains("Аналітика"));
        assert_eq!(workbook.matches("<sheet ").count(), 1);
        assert!(!workbook.contains("<definedNames>"));
        assert!(!workbook.contains("name=\"Locations\""));
        assert!(!workbook.contains("name=\"Ranks\""));
        assert_eq!(
            names
                .iter()
                .filter(|name| name.starts_with("xl/worksheets/sheet"))
                .count(),
            1
        );
        assert!(!names.iter().any(|name| name == "xl/worksheets/sheet2.xml"));
        assert!(sheet.contains("sqref=\"L7:L11\""));
        assert!(sheet.contains("sqref=\"O7:O11\""));
        assert!(sheet.contains("<formula1>&quot;Працюючий,Формується,Не активний&quot;</formula1>"));
        assert!(sheet.contains("Літаковий Ударний"));
        assert!(sheet.contains("ПТЗ Новостав"));
        assert!(sheet.contains("старший майстер-сержант"));
        assert!(!sheet.contains("<formula1>CrewStatuses</formula1>"));
        assert!(!sheet.contains("<formula1>UavTypes</formula1>"));
        assert!(!sheet.contains("<formula1>Locations</formula1>"));
        assert!(!sheet.contains("<formula1>Ranks</formula1>"));
        assert!(!sheet.contains("COUNTA(M9:M11)"));
        assert!(sheet.contains("<c r=\"F7\" s=\"171\"><v>4</v></c>"));
        assert!(sheet.contains("SUM($R$7:$R$11)"));
        assert!(sheet.contains("COUNTIFS($Q$7:$Q7,&quot;Екіпаж&quot;,$M$7:$M7,$M7)"));
        assert!(sheet.contains("Оперативне підпорядкування"));
        assert!(sheet.contains("$K$7:$K$11,&quot;*ТВО*&quot;"));
        assert!(sheet.contains("ЕКІПАЖ АЛЬФА"));
        assert!(sheet.contains("ПОЗИЦІЯ АЛЬФА"));
        assert!(sheet.contains("БРО-1"));
        assert!(sheet.contains("СЕКТОР-1"));
        assert!(sheet.contains("Назва БпАК"));
        assert!(sheet.contains("conditionalFormatting"));
        assert!(sheet.contains("<row r=\"1\" ht=\"18\" customHeight=\"1\">"));
        assert!(sheet.contains("<row r=\"2\" ht=\"44.25\" customHeight=\"1\"/>"));
        assert!(sheet.contains("ТЕСТОВИЙ ПІДРОЗДІЛ 419 окремого батальйону безпілотних систем"));
        assert!(sheet.contains("<c r=\"P6\" s=\"6\""));
        assert!(styles.contains("<fgColor rgb=\"FFD7E48D\"/><bgColor rgb=\"FFD7E48D\"/>"));
        assert!(styles.contains("<fgColor rgb=\"FFFDEADA\"/><bgColor rgb=\"FFFDEADA\"/>"));
        assert!(!styles.contains("<fgColor rgb=\"FFD7E48D\"/><bgColor rgb=\"FF000000\"/>"));
        assert!(!sheet.contains("ТЕСТОВИЙ ПІДРОЗДІЛ (Рота)"));
        assert!(sheet.contains("<col min=\"17\" max=\"19\" width=\"0\" hidden=\"1\""));
        assert!(sheet.contains("<mergeCell ref=\"A7:A9\"/>"));
        assert!(sheet.contains("<c r=\"A8\" s=\"171\""));
        assert!(sheet.contains("<c r=\"J9\" s=\"171\""));
        assert!(sheet.contains("$Q$7:$Q$11"));
        assert!(!sheet.contains("Реко та облаштування"));
        assert!(sheet.contains("Реко"));
        assert!(sheet.contains("Облаштування"));
        assert!(!sheet.contains("ОСОБА-"));
        assert!(sheet.contains("<c r=\"E14\" s=\"5\""));
        assert!(sheet.contains("<c r=\"E15\" s=\"3\""));
        assert!(sheet.contains("<c r=\"F15\" s=\"3\""));
        assert!(!sheet.contains("<c r=\"G15\" s=\"3\""));

        let crew_position = sheet.find("ПОЗИЦІЯ АЛЬФА").unwrap();
        let management = sheet.find("Управління роти").unwrap();
        assert!(crew_position < management);
    }

    #[test]
    fn exports_empty_template_with_default_block_names_and_blank_crew_details() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty.xlsx");
        let mut empty_blocks = blocks();
        for block in &mut empty_blocks {
            block.name.clear();
            block.position_name.clear();
            block.bro.clear();
            block.work_sector.clear();
            block.uav_name.clear();
        }

        export_template(TemplateRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: empty_blocks,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();

        let sheet = read_entry(&path, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("ЕКІПАЖ"));
        assert!(sheet.contains("Управління роти"));
    }

    #[test]
    fn keeps_other_block_single_sentence_cased_and_reference_colored() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("other-block.xlsx");
        let mut other_blocks = blocks();
        other_blocks.push(StructureBlock {
            id: "other".into(),
            kind: BlockKind::Custom,
            name: "інші підрозділи".into(),
            position_name: String::new(),
            slots: 1,
            status: None,
            uav_type: None,
            bro: String::new(),
            work_sector: String::new(),
            uav_name: String::new(),
            crew_actual: 0,
        });

        export_template(TemplateRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 6,
            blocks: other_blocks.clone(),
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();

        let sheet = read_entry(&path, "xl/worksheets/sheet1.xml");
        let styles = read_entry(&path, "xl/styles.xml");
        assert!(sheet.contains("<c r=\"A12\" s=\"177\""));
        assert!(sheet.contains("Інші підрозділи"));
        assert!(!sheet.contains("ІНШІ ПІДРОЗДІЛИ"));
        assert!(styles.contains(
            "<fgColor rgb=\"FFD7E4BD\"/><bgColor indexed=\"64\"/>"
        ));

        other_blocks.push(StructureBlock {
            id: "other-duplicate".into(),
            ..other_blocks.last().unwrap().clone()
        });
        let error = export_template(TemplateRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 7,
            blocks: other_blocks,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();
        assert!(error.contains("Блок «Інші» можна додати лише один раз"));
    }

    #[test]
    fn exported_summary_matches_the_editor_for_seven_multi_person_crews() {
        let directory = tempfile::tempdir().unwrap();
        let path = std::env::var_os("BCS_PARITY_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.path().join("crew-parity.xlsx"));
        let mut parity_blocks = vec![StructureBlock {
            id: "management".into(),
            kind: BlockKind::CompanyManagement,
            name: "Управління роти".into(),
            position_name: String::new(),
            slots: 1,
            status: None,
            uav_type: None,
            bro: String::new(),
            work_sector: String::new(),
            uav_name: String::new(),
            crew_actual: 0,
        }];
        for index in 0..7 {
            parity_blocks.push(StructureBlock {
                id: format!("crew-{index}"),
                kind: BlockKind::Crew,
                name: format!("Екіпаж {}", index + 1),
                position_name: String::new(),
                slots: 2,
                status: Some(
                    if index < 4 {
                        "Працюючий"
                    } else {
                        "Не активний"
                    }
                    .into(),
                ),
                uav_type: Some("Літаковий Розвідувальний".into()),
                bro: String::new(),
                work_sector: String::new(),
                uav_name: String::new(),
                crew_actual: 2,
            });
        }
        let mut people = vec![PersonInput {
            block_id: "management".into(),
            position: String::new(),
            rank: "капітан".into(),
            full_name: "КОМАНДИР Роти".into(),
            duties: String::new(),
            location: "ПУ".into(),
            note: String::new(),
        }];
        for crew_index in 0..7 {
            for person_index in 0..2 {
                people.push(PersonInput {
                    block_id: format!("crew-{crew_index}"),
                    position: String::new(),
                    rank: "солдат".into(),
                    full_name: format!("ОСОБА-{crew_index}-{person_index}"),
                    duties: String::new(),
                    location: "На позиції".into(),
                    note: String::new(),
                });
            }
        }

        export_filled(FilledBcsRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 15,
            blocks: parity_blocks,
            people,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();

        let workbook = read_entry(&path, "xl/workbook.xml");
        let sheet = read_entry(&path, "xl/worksheets/sheet1.xml");
        assert!(workbook.contains("calcMode=\"auto\""));
        assert_eq!(summary_value(&sheet, "Екіпажів (ос-загально)"), 14);
        assert_eq!(summary_value(&sheet, "Екіпажів (загально)"), 7);
        assert_eq!(
            summary_value(&sheet, "Екіпажів — Літаковий Розвідувальний"),
            7
        );
        assert_eq!(summary_value(&sheet, "Екіпажів — Формуються"), 0);
        assert_eq!(summary_value(&sheet, "Екіпажів — Працюючі"), 4);
        assert_eq!(summary_value(&sheet, "Екіпажів — Не активні"), 3);
        assert!(sheet.contains("SUM($S$7:$S$21)"));
        assert!(sheet
            .contains("COUNTIFS($S$7:$S$21,1,$J$7:$J$21,&quot;Літаковий Розвідувальний&quot;)"));
    }

    #[test]
    fn rejects_filled_export_when_created_people_slots_are_empty() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty-filled.xlsx");
        let people = ["management", "management", "crew-1", "crew-1", "crew-1"]
            .into_iter()
            .map(|block_id| PersonInput {
                block_id: block_id.into(),
                ..PersonInput::default()
            })
            .collect();
        let error = export_filled(FilledBcsRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: blocks(),
            people,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();

        assert!(error.contains("Заповніть кожне створене місце"));
        assert!(error.contains("Звання, П.І.Б., Де знаходиться"));
        assert!(!path.exists());
    }

    #[test]
    fn rejects_filled_export_when_created_people_slots_are_omitted() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("omitted-filled.xlsx");
        let error = export_filled(FilledBcsRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: blocks(),
            people: Vec::new(),
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();

        assert!(error.contains("Заповніть усі створені місця"));
        assert!(error.contains("Звання, П.І.Б., Де знаходиться"));
        assert!(!path.exists());
    }

    #[test]
    fn rejects_an_incomplete_person_without_rank_name_or_location() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("incomplete-person.xlsx");
        let error = export_filled(FilledBcsRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: blocks(),
            people: vec![PersonInput {
                block_id: "crew-1".into(),
                position: "Оператор".into(),
                rank: "солдат".into(),
                full_name: String::new(),
                duties: String::new(),
                location: String::new(),
                note: String::new(),
            }],
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();

        assert!(error.contains("П.І.Б."));
        assert!(error.contains("Де знаходиться"));
        assert!(!path.exists());
    }

    #[test]
    fn accepts_information_department_as_a_standard_block_type() {
        let kind: BlockKind = serde_json::from_str("\"informationDepartment\"").unwrap();
        assert_eq!(kind, BlockKind::InformationDepartment);
        let operational: BlockKind = serde_json::from_str("\"operationalSubordination\"").unwrap();
        assert_eq!(operational, BlockKind::OperationalSubordination);
    }

    #[test]
    fn formats_only_the_surname_in_uppercase() {
        assert_eq!(
            format_full_name("іванов іВАН іванович"),
            "ІВАНОВ Іван Іванович"
        );
        assert_eq!(format_full_name("петренко о.п."), "ПЕТРЕНКО О.П.");
    }

    #[test]
    fn crew_formulas_handle_blank_rows_and_active_status_without_false_inactive_count() {
        assert_eq!(crew_status_group("Активний"), "working");

        assert_eq!(crew_personnel_formula(11), "SUM($R$7:$R$11)");
        assert_eq!(crew_count_formula(11), "SUM($S$7:$S$11)");

        let (forming, working, inactive) = crew_status_formulas(11);
        assert_eq!(
            working,
            "COUNTIFS($S$7:$S$11,1,$H$7:$H$11,\"Працюючий\")+COUNTIFS($S$7:$S$11,1,$H$7:$H$11,\"Активний\")"
        );
        assert_eq!(
            inactive,
            format!("({})-({forming})-({working})", crew_count_formula(11))
        );
        assert!(inactive.ends_with(&format!("-({working})")));
    }

    #[test]
    fn inline_validations_fit_excel_limit_and_reject_oversized_sources() {
        let schema = schema().unwrap();
        assert!(inline_data_validation("A1", CREW_STATUSES.iter().copied(), "Помилка").is_ok());
        assert!(inline_data_validation("A1", UAV_TYPES.iter().copied(), "Помилка").is_ok());
        assert!(inline_data_validation("A1", RANKS.iter().copied(), "Помилка").is_ok());
        assert!(inline_data_validation(
            "A1",
            schema.locations.iter().map(String::as_str),
            "Помилка"
        )
        .is_ok());

        let oversized = "а".repeat(254);
        let error = inline_data_validation("A1", [oversized.as_str()], "Помилка").unwrap_err();
        assert!(error.contains("255"));
    }

    #[test]
    fn exports_filled_bcs_and_keeps_personal_values_as_plain_text() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("filled.xlsx");
        let mut people = complete_people();
        people[2] = PersonInput {
            block_id: "crew-1".into(),
            position: "Оператор".into(),
            rank: "солдат".into(),
            full_name: "іванов іВАН іванович".into(),
            duties: "Оператор".into(),
            location: "На позиції".into(),
            note: "=НЕ ФОРМУЛА".into(),
        };
        export_filled(FilledBcsRequest {
            unit_name: "ТЕСТОВИЙ ПІДРОЗДІЛ".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: blocks(),
            people,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();
        let sheet = read_entry(&path, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("ІВАНОВ Іван Іванович"));
        assert!(sheet.contains("<t xml:space=\"preserve\">=НЕ ФОРМУЛА</t>"));
        assert!(sheet.contains("<c r=\"F7\" s=\"171\"><v>4</v></c>"));
    }

    #[test]
    fn exports_macro_free_one_sheet_bcs_without_helpers_and_keeps_nonzero_uav_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("one-sheet.xlsx");
        let mut people = complete_people();
        people[2] = PersonInput {
            block_id: "crew-1".into(),
            position: "Оператор".into(),
            rank: "солдат".into(),
            full_name: "іванов іван іванович".into(),
            duties: "Оператор БпАК".into(),
            location: "На позиції".into(),
            note: "Тест".into(),
        };
        export_filled(FilledBcsRequest {
            unit_name: "1 РУБАК".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: blocks(),
            people,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();

        let content_types = read_entry(&path, "[Content_Types].xml");
        let workbook = read_entry(&path, "xl/workbook.xml");
        let relationships = read_entry(&path, "xl/_rels/workbook.xml.rels");
        let bcs = read_entry(&path, "xl/worksheets/sheet1.xml");
        let styles = read_entry(&path, "xl/styles.xml");
        let names = entry_names(&path);

        assert!(content_types.contains(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
        ));
        assert!(!content_types.contains("sheet.macroEnabled.main+xml"));
        assert!(!content_types.contains("vbaProject"));
        assert!(!content_types.contains("activeX"));
        assert!(!content_types.contains("vmlDrawing"));
        assert!(!content_types.contains("/xl/worksheets/sheet2.xml"));
        assert!(workbook.contains("<sheet name=\"БЧС\""));
        assert!(!workbook.contains("Довідники"));
        assert!(!workbook.contains("Аналітика"));
        assert!(!workbook.contains("Фільтр за місцем"));
        assert!(!workbook.contains("<definedNames>"));
        assert_eq!(workbook.matches("<sheet ").count(), 1);
        assert!(!relationships.contains("Target=\"worksheets/sheet2.xml\""));
        assert!(!relationships.contains("vbaProject"));
        assert!(!bcs.contains("<autoFilter"));
        assert!(!bcs.contains("<sheetPr codeName="));
        assert!(!bcs.contains("<legacyDrawing"));
        assert!(!bcs.contains("<controls>"));
        assert!(!bcs.contains("<hyperlinks>"));
        assert!(!bcs.contains("<hyperlink "));
        assert!(bcs.contains("Екіпажів — ФПВ"));
        assert!(!bcs.contains("Екіпажів — Бомбер"));
        assert!(bcs.contains("COUNTIFS($S$7:$S$11,1,$H$7:$H$11,&quot;Працюючий&quot;)"));
        assert!(!bcs.contains("#DIV/0!"));
        assert!(styles.contains("<cellXfs count=\"180\">"));
        assert_eq!(
            names
                .iter()
                .filter(|name| name.starts_with("xl/worksheets/sheet"))
                .count(),
            1
        );
        assert!(!names.iter().any(|name| name == "xl/worksheets/sheet2.xml"));
        assert!(!names.iter().any(|name| name == "xl/vbaProject.bin"));
        assert!(!names.iter().any(|name| name.starts_with("xl/activeX/")));
        assert!(!names.iter().any(|name| name.ends_with(".vml")));
    }
    #[test]
    fn requires_the_management_block_for_company_and_platoon() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("required-management.xlsx");

        let company_blocks = blocks()
            .into_iter()
            .filter(|block| block.kind != BlockKind::CompanyManagement)
            .collect::<Vec<_>>();
        let missing_company = export_template(TemplateRequest {
            unit_name: "ТЕСТ".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 3,
            blocks: company_blocks,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();
        assert!(missing_company.contains("одне управління роти"));

        let missing_platoon = export_template(TemplateRequest {
            unit_name: "ТЕСТ".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Platoon,
            authorized_strength: 5,
            blocks: blocks(),
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();
        assert!(missing_platoon.contains("одне управління взводу"));
    }

    #[test]
    fn accepts_nominal_staffing_independent_from_rows_and_rejects_unknown_dropdown_values() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("invalid.xlsx");
        export_template(TemplateRequest {
            unit_name: "ТЕСТ".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 6,
            blocks: blocks(),
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap();
        assert!(path.exists());

        let mut invalid_blocks = blocks();
        invalid_blocks[1].uav_type = Some("Невідомий тип".into());
        let invalid_type = export_template(TemplateRequest {
            unit_name: "ТЕСТ".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: invalid_blocks,
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();
        assert!(invalid_type.contains("Оберіть значення зі списку"));
    }

    #[test]
    fn requires_macro_free_output_extension() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("macro-enabled.xlsm");
        let error = export_template(TemplateRequest {
            unit_name: "ТЕСТ".into(),
            report_date: "08.10.2026".into(),
            structure_type: StructureType::Company,
            authorized_strength: 5,
            blocks: blocks(),
            output_path: path.to_string_lossy().into_owned(),
        })
        .unwrap_err();

        assert!(error.contains(".xlsx"));
        assert!(!path.exists());
    }
}
