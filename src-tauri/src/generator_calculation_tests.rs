use super::*;
use serde_json::{json, Value};
use std::{fs::File, io::Read, path::Path};
use zip::ZipArchive;

fn block(id: &str, kind: &str, name: &str, slots: usize) -> Value {
    json!({"id":id,"kind":kind,"name":name,"slots":slots,"crewActual":7,
        "status":"Працюючий","uavType":"ФПВ"})
}

fn person(id: &str, name: &str, position: &str) -> Value {
    json!({"blockId":id,"fullName":name,"rank":"солдат","location":"ПУ","position":position})
}

fn request(path: &Path, blocks: Vec<Value>, people: Vec<Value>) -> FilledBcsRequest {
    serde_json::from_value(json!({"unitName":"АУДИТ", "reportDate":"08.10.2026",
        "structureType":"company","authorizedStrength":1,"blocks":blocks,"people":people,
        "outputPath":path.to_string_lossy()}))
    .unwrap()
}

fn xml(path: &Path) -> String {
    let mut result = String::new();
    ZipArchive::new(File::open(path).unwrap())
        .unwrap()
        .by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut result)
        .unwrap();
    result
}

fn total(xml: &str, label: &str) -> i64 {
    let marker = format!(">{}</t>", esc(label));
    let rest = &xml[xml.rfind(&marker).unwrap() + marker.len()..];
    let rest = &rest[rest.find("<v>").unwrap() + 3..];
    rest[..rest.find("</v>").unwrap()].parse().unwrap()
}

#[test]
fn semantic_category_does_not_depend_on_a_department_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("identity.xlsx");
    export_filled(request(
        &path,
        vec![
            block("m", "companyManagement", "Управління роти", 1),
            block("d", "department", "Прикомандировані", 1),
            block("a", "attached", "Прикомандировані", 1),
        ],
        vec![
            person("m", "ТЕСТ-М Іван", ""),
            person("d", "ТЕСТ-Д Іван", ""),
            person("a", "ТЕСТ-А Іван", ""),
        ],
    ))
    .unwrap();
    let sheet = xml(&path);
    assert_eq!(total(&sheet, "По списку"), 2);
    assert_eq!(total(&sheet, "Прикомандировані"), 1);
    assert!(sheet.contains("__BCS_KIND_V1"));
    assert!(sheet.contains("$T$7:$T$9,&quot;attached&quot;"));
    assert!(sheet.contains(
        "<c r=\"T8\" s=\"0\" t=\"inlineStr\"><is><t xml:space=\"preserve\">department</t>"
    ));
    assert!(!sheet.contains("$Q$7:$Q$9,&quot;&lt;&gt;Прикомандировані&quot;"));
}

#[test]
fn duplicate_names_use_one_unicode_normalized_key_before_export_and_in_formulas() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("names.xlsx");
    let names = [
        "ТЕСТОВИЙ Іван",
        "  тестовий  Іван  ",
        "ТЕСТОВИЙ\u{a0}Іван",
        "\u{feff}ТЕСТОВИЙ\u{85}Іван",
    ];
    let mut blocks = vec![block("m", "companyManagement", "Управління роти", 1)];
    let mut people = vec![person("m", "УПРАВЛІННЯ Іван", "")];
    for (index, name) in names.iter().enumerate() {
        let id = format!("crew-{index}");
        blocks.push(block(&id, "crew", &id, 1));
        people.push(person(&id, name, ""));
    }
    export_filled(request(&path, blocks, people)).unwrap();
    let sheet = xml(&path);
    assert_eq!(total(&sheet, "Екіпажів (ос-загально)"), 1);
    assert_eq!(total(&sheet, "Екіпажів (загально)"), 4);
    assert!(sheet.contains("$W$7:$W7"));
    assert!(sheet.contains("<f t=\"shared\" si=\"3\" ref=\"W7:W11\">TRIM("));
    assert!(sheet.contains("SUBSTITUTE(SUBSTITUTE(SUBSTITUTE($W7,&quot;~&quot;,&quot;~~&quot;),&quot;*&quot;,&quot;~*&quot;),&quot;?&quot;,&quot;~?&quot;)"));
}

#[test]
fn acting_assignment_is_a_standalone_token_and_excel_keeps_it_dynamic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("acting.xlsx");
    export_filled(request(
        &path,
        vec![
            block("m", "companyManagement", "Управління роти", 1),
            block("t", "temporary", "Тимчасово прибулі", 4),
            block("a", "temporaryActing", "Тимчасові з ТВО", 1),
        ],
        vec![
            person("m", "УПРАВЛІННЯ Іван", ""),
            person("t", "ТЕСТ-1 Іван", "Відповідальний за діловодство"),
            person("t", "ТЕСТ-2 Іван", "Виконавець робіт (будівництво)"),
            person("t", "ТЕСТ-3 Іван", "(ТВО): оператора"),
            person("t", "ТЕСТ-4 Іван", "Водій — ТВО"),
            person("a", "ТЕСТ-5 Іван", ""),
        ],
    ))
    .unwrap();
    let sheet = xml(&path);
    assert_eq!(total(&sheet, "По списку"), 4);
    assert_eq!(total(&sheet, "Тимчасово прибулі з ТВО"), 3);
    assert_eq!(total(&sheet, "Тимчасово прибулі"), 5);
    assert!(sheet.contains("<c r=\"U8\" s=\"0\"><f t=\"shared\" si=\"1\"/>"));
    assert!(sheet.contains("<c r=\"V8\" s=\"0\" t=\"str\"><f t=\"shared\" si=\"2\"/>"));
    assert!(sheet.contains("<f t=\"shared\" si=\"1\" ref=\"U7:U12\">IF($T7=&quot;temporaryActing&quot;,1,IF($T7=&quot;temporary&quot;,IF(ISNUMBER(SEARCH("));
    assert!(sheet.contains("CHAR(11)"));
    assert!(sheet.contains("CHAR(12)"));
    assert!(sheet.contains("_xlfn.UNICHAR(160)"));
    assert!(!sheet.contains("UNICHAR(11)"));
    assert!(!sheet.contains("UNICHAR(12)"));
}

#[test]
fn free_section_names_are_literal_excel_criteria() {
    assert_eq!(literal_criterion("Відділення А?*~"), "=Відділення А~?~*~~");
    assert_eq!(literal_criterion("<>Інші"), "=<>Інші");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wildcards.xlsx");
    export_filled(request(
        &path,
        vec![
            block("m", "companyManagement", "Управління роти", 1),
            block("d", "department", "Відділення А?", 1),
            block("e", "department", "Відділення А1", 1),
        ],
        vec![
            person("m", "ТЕСТ-1 Іван", ""),
            person("d", "ТЕСТ-2 Іван", ""),
            person("e", "ТЕСТ-3 Іван", ""),
        ],
    ))
    .unwrap();
    let sheet = xml(&path);
    assert_eq!(total(&sheet, "Відділення А?"), 1);
    assert!(sheet.contains("&quot;=Відділення А~?&quot;"));
}

#[test]
fn unicode_blank_minimum_fields_cannot_bypass_filled_export_validation() {
    let dir = tempfile::tempdir().unwrap();
    for field in ["rank", "fullName", "location"] {
        for blank in ["\u{feff}", "\u{85}", "\u{a0}", " \u{feff}\t"] {
            let mut p = person("m", "ТЕСТ Іван", "");
            p[field] = json!(blank);
            let path = dir.path().join("blank.xlsx");
            let result = export_filled(request(
                &path,
                vec![block("m", "companyManagement", "Управління роти", 1)],
                vec![p],
            ));
            assert!(result.is_err(), "{field} must not accept invisible text");
            assert!(!path.exists());
        }
    }
}

#[test]
fn dynamic_helper_formulas_stay_within_excels_nesting_limit() {
    let (spaces, acting) = temporary_acting_formulas(7);
    let name = format!("TRIM({})", whitespace_formula("$M7"));
    for formula in [spaces, acting, name] {
        let mut quoted = false;
        let mut depth = 0;
        let mut maximum = 0;
        for character in formula.chars() {
            if character == '"' {
                quoted = !quoted;
            }
            if quoted {
                continue;
            }
            if character == '(' {
                depth += 1;
                maximum = maximum.max(depth);
            } else if character == ')' {
                depth -= 1;
            }
        }
        assert_eq!(depth, 0);
        assert!(maximum <= 64, "helper uses {maximum} levels");
    }
}

#[test]
fn blank_template_counts_only_canonical_names_with_at_least_one_character() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.xlsx");
    export_template(serde_json::from_value(serde_json::json!({"unitName":"ТЕСТ","reportDate":"08.10.2026","structureType":"company","authorizedStrength":2,"blocks":[block("m","companyManagement","Управління роти",1),block("c","crew","ЕКІПАЖ",2)],"outputPath":path.to_string_lossy()})).unwrap()).unwrap();
    let sheet = xml(&path);
    assert_eq!(total(&sheet, "По списку"), 0);
    assert_eq!(total(&sheet, "Загалом"), 0);
    assert!(sheet.contains("COUNTIFS($W$7:$W$9,&quot;?*&quot;"));
    assert!(sheet.contains("COUNTIF($W$7:$W$9,&quot;?*&quot;)"));
    assert!(!sheet.contains("$W$7:$W$9,&quot;&lt;&gt;&quot;"));
    for (column, id) in [('R', 0), ('U', 1), ('V', 2), ('W', 3)] {
        assert!(sheet.contains(&format!(
            "<f t=\"shared\" si=\"{id}\" ref=\"{column}7:{column}9\">"
        )));
        assert!(sheet.contains(&format!("<f t=\"shared\" si=\"{id}\"/>")));
    }
    assert!(sheet.contains("<c r=\"A8\" s=\"171\"/>"));
}

#[test]
fn five_thousand_temporary_personnel_export_and_reopen_without_exceeding_safe_limits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.xlsx");
    let mut blocks = vec![block("m", "companyManagement", "Управління роти", 1)];
    let mut people = vec![person("m", "УПРАВЛІННЯ Іван", "")];
    for i in 0..3 {
        let id = format!("temporary-{i}");
        let size = if i == 2 { 1000 } else { 2000 };
        blocks.push(block(&id, "temporary", "Тимчасово прибулі", size));
        for j in 0..size {
            people.push(person(&id, &format!("ТЕСТ-{i}-{j} Іван"), "Оператор (ТВО)"));
        }
    }
    export_filled(request(&path, blocks, people)).unwrap();
    let mut archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
    xlsx::validate_archive(&mut archive).unwrap();
    let rows = xlsx::read_bcs_sheet(&mut archive).unwrap();
    assert_eq!(
        rows.iter()
            .filter(|row| row.number >= 7
                && row.cells.get(19).is_some_and(|c| c.value == "temporary")
                && row.cells.get(12).is_some_and(|c| !c.value.is_empty()))
            .count(),
        5000
    );
    assert_eq!(total(&xml(&path), "По списку"), 5001);
}

#[test]
fn oversized_output_fails_before_touching_an_existing_destination() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.xlsx");
    std::fs::write(&path, b"unchanged original").unwrap();
    let sheet = " ".repeat(20 * 1024 * 1024 + 1);
    let error = xlsx::write_bcs_workbook(&path, &sheet, "", " ").unwrap_err();
    assert!(error.contains("20 МБ"));
    assert_eq!(std::fs::read(&path).unwrap(), b"unchanged original");
}
