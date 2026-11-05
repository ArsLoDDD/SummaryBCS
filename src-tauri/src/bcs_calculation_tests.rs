use super::*;
use serde_json::json;
use std::io::Read;

fn department_fixture(path: &Path, unit: &str, label: &str) {
    let blocks = json!([
        {"id":"m","kind":"companyManagement","name":"Управління роти","slots":1},
        {"id":"c","kind":"crew","name":"ЕКІПАЖ","slots":1,"status":"Працюючий","uavType":"ФПВ","crewActual":7},
        {"id":"d","kind":"department","name":label,"slots":1},
        {"id":"a","kind":"attached","name":"Прикомандировані","slots":1}
    ]);
    let people=[("m","М"),("c","Е"),("d","Д"),("a","П")].map(|(id,tag)|json!({"blockId":id,"fullName":format!("ТЕСТ-{unit}-{tag} Іван"),"rank":"солдат","location":"ПУ","duties":tag}));
    let request=serde_json::from_value(json!({"unitName":unit,"reportDate":"08.10.2026","structureType":"company","authorizedStrength":20,"blocks":blocks,"people":people,"outputPath":path.to_string_lossy()})).unwrap();
    crate::generator::export_filled(request).unwrap();
}

fn part(path: &Path, name: &str) -> String {
    let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut text = String::new();
    archive
        .by_name(name)
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    text
}

fn rewrite(path: &Path, target: &str, edit: impl FnOnce(String) -> String) {
    let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let mut item = archive.by_index(i).unwrap();
        let mut bytes = Vec::new();
        item.read_to_end(&mut bytes).unwrap();
        entries.push((item.name().to_string(), bytes));
    }
    drop(archive);
    let mut edit = Some(edit);
    let mut writer = ZipWriter::new(File::create(path).unwrap());
    for (name, mut bytes) in entries {
        if name == target {
            bytes = edit.take().unwrap()(String::from_utf8(bytes).unwrap()).into_bytes();
        }
        writer
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap();
}

fn remove_cell(xml: &mut String, coordinate: &str) {
    let marker = format!("<c r=\"{coordinate}\"");
    if let Some(start) = xml.find(&marker) {
        let end = start + xml[start..].find("</c>").unwrap() + 4;
        xml.replace_range(start..end, "");
    }
}

fn total(xml: &str, label: &str) -> i64 {
    let marker = format!(">{}</t>", esc(label));
    let rest = &xml[xml.rfind(&marker).unwrap() + marker.len()..];
    let rest = &rest[rest.find("<v>").unwrap() + 3..];
    rest[..rest.find("</v>").unwrap()].parse().unwrap()
}

#[test]
fn explicit_kind_survives_unit_export_summary_export_and_reimport_with_reserved_names() {
    let dir = tempfile::tempdir().unwrap();
    for (index, label) in [
        "Прикомандировані",
        "Оперативне підпорядкування",
        "Тимчасово прибулі",
        "Тимчасові з ТВО",
        "Екіпаж",
        "Управління роти",
    ]
    .iter()
    .enumerate()
    {
        let file = dir.path().join(format!("unit-{index}.xlsx"));
        department_fixture(&file, "ТЕСТ", label);
        let unit = parse_file(&file).unwrap();
        let department = unit.rows.iter().find(|row| row.duties == "Д").unwrap();
        assert_eq!(department.kind, "department");
        assert!(!department.is_external);
        assert!(!row_is_crew(department));
        let summary = dir.path().join(format!("summary-{index}.xlsx"));
        export_workbook(&summary, &[unit]).unwrap();
        let xml = part(&summary, "xl/worksheets/sheet1.xml");
        assert_eq!(total(&xml, "По списку"), 3);
        assert_eq!(total(&xml, "Екіпажів (ос-загально)"), 1);
        let imported = parse_file(&summary).unwrap();
        let department = imported.rows.iter().find(|row| row.duties == "Д").unwrap();
        assert_eq!(department.kind, "department");
        assert!(!department.is_external);
        assert_eq!(imported.unit_authorized.get("тест"), Some(&20));
    }
}

#[test]
fn consolidation_rejects_a_ready_summary_even_if_the_overlap_is_not_its_first_unit() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.xlsx");
    let b = dir.path().join("b.xlsx");
    department_fixture(&a, "А", "Відділення А");
    department_fixture(&b, "Б", "Відділення Б");
    let summary = dir.path().join("summary.xlsx");
    export_workbook(
        &summary,
        &[parse_file(&a).unwrap(), parse_file(&b).unwrap()],
    )
    .unwrap();
    let error = preview_files(&[summary, b]).unwrap_err();
    assert!(error.contains("готовий зведений") || error.contains("готові зведення"));
}

#[test]
fn summary_authorized_counts_are_recovered_only_from_consistent_direct_analytics_values() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.xlsx");
    let b = dir.path().join("b.xlsx");
    department_fixture(&a, "А", "Відділення А");
    department_fixture(&b, "Б", "Відділення Б");
    let summary = dir.path().join("summary.xlsx");
    export_workbook(
        &summary,
        &[parse_file(&a).unwrap(), parse_file(&b).unwrap()],
    )
    .unwrap();
    let imported = parse_file(&summary).unwrap();
    assert_eq!(
        imported.unit_authorized,
        BTreeMap::from([("а".into(), 20), ("б".into(), 20)])
    );
    rewrite(&summary, "xl/worksheets/sheet2.xml", |xml| {
        xml.replacen(
            "<c r=\"B6\" s=\"180\"><v>20</v>",
            "<c r=\"B6\" s=\"180\"><v>21</v>",
            1,
        )
    });
    assert!(parse_file(&summary).unwrap().unit_authorized.is_empty());
}

#[test]
fn an_internal_blank_service_row_does_not_hide_people_after_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("blank-row.xlsx");
    let request:crate::generator::FilledBcsRequest=serde_json::from_value(json!({"unitName":"ТЕСТ","reportDate":"08.10.2026","structureType":"company","authorizedStrength":1,"blocks":[{"id":"c","kind":"crew","name":"ЕКІПАЖ","slots":3,"status":"Працюючий","uavType":"ФПВ","crewActual":3},{"id":"m","kind":"companyManagement","name":"Управління роти","slots":1}],"people":[{"blockId":"c","fullName":"ТЕСТ-ПЕРШИЙ Іван","rank":"солдат","location":"ПУ"},{"blockId":"c","fullName":"ТЕСТ-ПОРОЖНІЙ Іван","rank":"солдат","location":"ПУ"},{"blockId":"c","fullName":"ТЕСТ-ОСТАННІЙ Іван","rank":"солдат","location":"ПУ"},{"blockId":"m","fullName":"ТЕСТ-УПРАВЛІННЯ Іван","rank":"солдат","location":"ПУ"}],"outputPath":file.to_string_lossy()})).unwrap();
    crate::generator::export_filled(request).unwrap();
    rewrite(&file, "xl/worksheets/sheet1.xml", |mut xml| {
        for column in b'A'..=b'P' {
            remove_cell(&mut xml, &format!("{}8", column as char));
        }
        xml
    });
    let parsed = parse_file(&file).unwrap();
    let names = parsed
        .rows
        .iter()
        .map(|row| row.full_name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 3);
    assert!(names.contains(&"ТЕСТ-ОСТАННІЙ ІВАН"));
    assert!(names.contains(&"ТЕСТ-УПРАВЛІННЯ ІВАН"));
}

#[test]
fn declared_kind_metadata_is_validated_instead_of_silently_reclassified() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("kind.xlsx");
    department_fixture(&file, "ТЕСТ", "Відділення");
    rewrite(&file, "xl/worksheets/sheet1.xml", |xml| {
        xml.replacen(">crew</t>", ">not-a-known-kind</t>", 1)
    });
    let error = parse_file(&file).unwrap_err();
    assert!(error.contains("невідомий тип підрозділу"));
}

#[test]
fn semantic_helpers_are_never_used_as_a_substitute_for_actual_personnel_data() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("untrusted-helpers.xlsx");
    let mut source = serde_json::json!({"unitName":"ТЕСТ","reportDate":"08.10.2026","structureType":"company","authorizedStrength":1,"blocks":[{"id":"m","kind":"companyManagement","name":"Управління роти","slots":1},{"id":"t","kind":"temporary","name":"Тимчасово прибулі","slots":1}],"people":[{"blockId":"m","fullName":"ТЕСТ-М Іван","rank":"солдат","location":"ПУ"},{"blockId":"t","fullName":"ТЕСТ-Т Іван","rank":"солдат","location":"ПУ","position":"Відповідальний за діловодство"}],"outputPath":file.to_string_lossy()});
    crate::generator::export_filled(
        serde_json::from_value::<crate::generator::FilledBcsRequest>(source.take()).unwrap(),
    )
    .unwrap();
    rewrite(&file, "xl/worksheets/sheet1.xml", |xml| {
        let start = xml.find("<c r=\"U8\"").unwrap();
        let end = start + xml[start..].find("</c>").unwrap() + 4;
        let mut result = xml;
        result.replace_range(start..end, "<c r=\"U8\"><v>1</v></c>");
        result
    });
    let unit = parse_file(&file).unwrap();
    assert_eq!(
        unit.rows
            .iter()
            .filter(|row| is_temporary_acting(row))
            .count(),
        0
    );
    let summary = dir.path().join("summary.xlsx");
    export_workbook(&summary, &[unit]).unwrap();
    assert_eq!(
        total(&part(&summary, "xl/worksheets/sheet1.xml"), "По списку"),
        1
    );
}

#[test]
fn footer_titles_in_personnel_fields_do_not_truncate_unit_or_summary_data() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("footer-text-a.xlsx");
    let b = dir.path().join("footer-text-b.xlsx");
    for (unit, path, with_titles) in [("А", &a, true), ("Б", &b, false)] {
        let people = (0..5).map(|index| json!({
            "blockId": if index < 2 { "management" } else { "crew" },
            "fullName": format!("ТЕСТ-{unit}-{index} Іван"),
            "rank": "солдат", "location": "ПУ",
            "duties": if with_titles && index == 3 { "БЧС по функціоналу:" } else { "Оператор" },
            "note": if with_titles && index == 3 { "Де знаходиться" } else { "" }
        })).collect::<Vec<_>>();
        let request = serde_json::from_value(json!({
            "unitName": unit, "reportDate": "08.10.2026", "structureType": "company",
            "authorizedStrength": 5,
            "blocks": [
                {"id":"management","kind":"companyManagement","name":"Управління роти","slots":2},
                {"id":"crew","kind":"crew","name":"ЕКІПАЖ","slots":3,"status":"Працюючий","uavType":"ФПВ","crewActual":3}
            ],
            "people": people, "outputPath": path.to_string_lossy()
        })).unwrap();
        crate::generator::export_filled(request).unwrap();
    }
    for legacy in [false, true] {
        if legacy {
            rewrite(&a, "xl/worksheets/sheet1.xml", |mut xml| {
                remove_cell(&mut xml, "T4");
                xml
            });
        }
        let unit = parse_file(&a).unwrap();
        assert_eq!(
            unit.rows
                .iter()
                .filter(|row| !row.full_name.is_empty())
                .count(),
            5
        );
        assert!(unit
            .rows
            .iter()
            .any(|row| row.duties == "БЧС по функціоналу:" && row.notes == "Де знаходиться"));
        assert_eq!(
            preview_files(&[a.clone(), b.clone()])
                .unwrap()
                .total_personnel,
            10
        );
        let summary = dir
            .path()
            .join(format!("footer-text-summary-{legacy}.xlsx"));
        export_workbook(&summary, &[unit, parse_file(&b).unwrap()]).unwrap();
        assert_eq!(
            total(&part(&summary, "xl/worksheets/sheet1.xml"), "По списку"),
            10
        );
        assert_eq!(
            parse_file(&summary)
                .unwrap()
                .rows
                .iter()
                .filter(|row| !row.full_name.is_empty())
                .count(),
            10
        );
    }
}

#[test]
fn authorized_strength_is_read_from_the_footer_not_a_crew_name_or_personnel_position() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("authorized-label.xlsx");
    let peer = dir.path().join("peer.xlsx");
    let request=serde_json::from_value(json!({"unitName":"ТЕСТ ШТАТУ","reportDate":"08.10.2026","structureType":"company","authorizedStrength":78,"blocks":[{"id":"crew","kind":"crew","name":"По штату","slots":2,"status":"Працюючий","uavType":"ФПВ","crewActual":3},{"id":"management","kind":"companyManagement","name":"Управління роти","slots":1}],"people":[{"blockId":"crew","fullName":"ТЕСТ-1 Іван","rank":"солдат","location":"ПУ","position":"По штату"},{"blockId":"crew","fullName":"ТЕСТ-2 Іван","rank":"солдат","location":"ПУ"},{"blockId":"management","fullName":"ТЕСТ-3 Іван","rank":"солдат","location":"ПУ"}],"outputPath":source.to_string_lossy()})).unwrap();
    crate::generator::export_filled(request).unwrap();
    department_fixture(&peer, "ІНШИЙ", "Відділення");
    for legacy in [false, true] {
        if legacy {
            rewrite(&source, "xl/worksheets/sheet1.xml", |mut xml| {
                remove_cell(&mut xml, "T4");
                xml
            });
        }
        let unit = parse_file(&source).unwrap();
        assert_eq!(unit.authorized_strength, 78, "legacy={legacy}");
        let summary = dir.path().join(format!("summary-authorized-{legacy}.xlsx"));
        export_workbook(&summary, &[unit, parse_file(&peer).unwrap()]).unwrap();
        assert_eq!(
            total(&part(&summary, "xl/worksheets/sheet1.xml"), "По штату"),
            98
        );
        assert_eq!(parse_file(&summary).unwrap().authorized_strength, 98);
    }
}
