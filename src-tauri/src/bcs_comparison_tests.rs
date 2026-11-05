use super::*;

fn person(id: usize, kind: &str, section: &str, location: &str) -> BcsRow {
    BcsRow {
        kind: kind.into(),
        group_key: format!("group-{id}"),
        section: section.into(),
        full_name: format!("ТЕСТОВИЙ-{id:04} Іван Миколайович"),
        rank: "солдат".into(),
        personnel_position: "оператор".into(),
        location: location.into(),
        crew_official: "1".into(),
        is_external: kind_is_external(kind),
        is_temporary: matches!(kind, "temporary" | "temporaryActing"),
        ..BcsRow::default()
    }
}

fn crew(id: usize, name: &str, status: &str, location: &str) -> BcsRow {
    BcsRow {
        crew_name: name.into(),
        crew_status: status.into(),
        uav_type: "ФПВ".into(),
        uav_name: "Тестовий БпАК".into(),
        position_name: format!("ПОЗИЦІЯ-{name}"),
        battle_order: "ТЕСТ-БРО".into(),
        sector: "ТЕСТ-СЕКТОР".into(),
        crew_actual: "1".into(),
        color_key: format!("crew-{}", crew_status_group(status)),
        ..person(id, "crew", "Екіпаж", location)
    }
}

fn unit(id: &str, name: &str, date: &str, authorized: i64, rows: Vec<BcsRow>) -> ParsedBcs {
    ParsedBcs {
        id: id.into(),
        path: PathBuf::from(format!("{id}.xlsx")),
        file_name: format!("{id}.xlsx"),
        unit_name: name.into(),
        date: date.into(),
        is_summary: false,
        authorized_strength: authorized,
        unit_authorized: BTreeMap::new(),
        rows,
    }
}

fn compare(old: Vec<BcsRow>, new: Vec<BcsRow>) -> ComparisonResult {
    compare_parsed(
        &[unit("before", "1 РУБАК", "08.10.2026", 10, old)],
        &[unit("after", "1 РУБАК", "09.10.2026", 10, new)],
    )
    .unwrap()
}

fn compare_exported(old: &[ParsedBcs], new: &[ParsedBcs]) -> ComparisonResult {
    let directory = tempfile::tempdir().unwrap();
    let before = directory.path().join("before.xlsx");
    let after = directory.path().join("after.xlsx");
    export_workbook(&before, old).unwrap();
    export_workbook(&after, new).unwrap();
    compare_request(ComparisonRequest {
        before_paths: vec![before.to_string_lossy().into_owned()],
        after_paths: vec![after.to_string_lossy().into_owned()],
    })
    .unwrap()
}

fn pair_of_units() -> Vec<ParsedBcs> {
    vec![
        unit(
            "b1",
            "1 РУБАК",
            "08.10.2026",
            5,
            vec![crew(1, "А", "Працюючий", "ПУ")],
        ),
        unit(
            "b2",
            "2 РУБАК",
            "08.10.2026",
            7,
            vec![crew(2, "Б", "Працюючий", "ПУ")],
        ),
    ]
}

fn next_day(units: &[ParsedBcs]) -> Vec<ParsedBcs> {
    units
        .iter()
        .map(|unit| ParsedBcs {
            id: format!("after-{}", unit.id),
            date: "09.10.2026".into(),
            ..unit.clone()
        })
        .collect()
}

#[test]
fn analytics_population_matrix_covers_220_cases_without_service_rows() {
    let states = [
        "ПУ",
        "ШТАБ",
        "На позиції",
        "ЗАБ",
        "ВІДП",
        "ЛІК",
        "ВЛК",
        "НАВЧ",
        "ВІДР",
        "Відкомандировані",
        "СЗЧ",
        "ПТЗ Новостав",
        "",
        "НЕВІДОМО",
        "УПР",
        "КСП Роти",
        "ОХ",
        "ГШР",
        "ЗБЗ",
        "ПБЗ",
        "ЗХВ",
        "ОХП",
        "Реко",
        "Облаштування",
        "Логістика на позиції",
    ];
    let categories = [
        ("companyManagement", "Управління роти"),
        ("platoonManagement", "Управління взводу"),
        ("custom", "Інші"),
        ("department", "Відділення"),
        ("attached", "Прикомандировані"),
        ("operationalSubordination", "Оперативне підпорядкування"),
        ("temporary", "Тимчасово прибулі"),
        ("temporaryActing", "Тимчасові з ТВО"),
    ];
    let locations = schema().unwrap().locations;
    let mut checked = 0;
    for (category_index, (kind, section)) in categories.iter().enumerate() {
        for (state_index, state) in states.iter().enumerate() {
            let data = analytics_data(
                &[unit(
                    "matrix",
                    "Рота",
                    "08.10.2026",
                    2,
                    vec![person(1, kind, section, state)],
                )],
                &locations,
            )
            .unwrap();
            let own = category_index < 4;
            let listed = i64::from(own || category_index == 7);
            let present = i64::from(own && !(4..12).contains(&state_index));
            assert_eq!(
                (data.units[0].listed, data.units[0].present),
                (listed, present),
                "{section}: {state}"
            );
            assert_eq!(data.units[0].deficit, 2 - listed);
            assert_eq!(data.units[0].staffing_percent, listed as f64 * 50.0);
            assert_eq!(
                data.locations.iter().map(|(_, count)| *count).sum::<i64>(),
                1
            );
            checked += 1;
        }
    }
    for index in 0..20 {
        let mut temporary = person(index, "temporary", "Тимчасово прибулі", "ПУ");
        temporary.personnel_position = if index % 2 == 0 {
            "ТВО командира"
        } else {
            "оператор"
        }
        .into();
        let mut blank = person(100 + index, "companyManagement", "Управління роти", "ВІДП");
        blank.full_name.clear();
        let data = analytics_data(
            &[unit(
                "matrix",
                "Рота",
                "08.10.2026",
                1,
                vec![temporary, blank],
            )],
            &locations,
        )
        .unwrap();
        assert_eq!(data.units[0].listed, i64::from(index % 2 == 0));
        assert_eq!(data.units[0].present, 0);
        assert_eq!(
            data.locations.iter().map(|(_, count)| *count).sum::<i64>(),
            1
        );
        checked += 1;
    }
    assert_eq!(checked, 220);
}

#[test]
fn summary_comparison_includes_first_unit_and_ignores_unit_order() {
    let old = pair_of_units();
    let mut changed = next_day(&old);
    changed[0].rows[0].location = "ВІДП".into();
    let result = compare_exported(&old, &changed);
    assert!(result
        .unit_changes
        .iter()
        .any(|line| line.contains("1 РУБАК: в наявності 1 → 0")));
    assert_eq!((result.before_unit_count, result.after_unit_count), (2, 2));
    let mut reordered = next_day(&old);
    reordered.reverse();
    let result = compare_exported(&old, &reordered);
    assert!(!result.has_changes, "{:?}", result.unit_changes);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!((result.before_unit_count, result.after_unit_count), (2, 2));
}

#[test]
fn summary_comparison_removes_the_first_unit_not_the_survivor() {
    let old = pair_of_units();
    let mut new = next_day(&old);
    new.remove(0);
    let result = compare_exported(&old, &new);
    assert!(result
        .unit_changes
        .iter()
        .any(|line| line.contains("Відсутній у новому БЧС підрозділ «1 РУБАК»")));
    assert!(!result
        .unit_changes
        .iter()
        .any(|line| line.contains("Відсутній у новому БЧС підрозділ «2 РУБАК»")));
    assert_eq!((result.before_unit_count, result.after_unit_count), (2, 1));
}

#[test]
fn summary_comparison_reads_offsetting_authorized_changes_from_analytics() {
    let old = pair_of_units();
    let mut new = next_day(&old);
    new[0].authorized_strength = 6;
    new[1].authorized_strength = 6;
    let result = compare_exported(&old, &new);
    assert!(result.headline.iter().all(|metric| metric.delta == 0));
    assert!(result
        .unit_changes
        .iter()
        .any(|line| line.contains("1 РУБАК: по штату 5 → 6")));
    assert!(result
        .unit_changes
        .iter()
        .any(|line| line.contains("2 РУБАК: по штату 7 → 6")));
    assert!(result.warnings.is_empty());
}

#[test]
fn legacy_general_without_unit_authorized_values_has_an_explicit_warning() {
    let mut old = pair_of_units().remove(0);
    old.is_summary = true;
    let mut new = old.clone();
    new.id = "new".into();
    new.date = "09.10.2026".into();
    let result = compare_parsed(&[old], &[new]).unwrap();
    assert!(!result.has_changes);
    assert!(result
        .warnings
        .iter()
        .any(|line| line.contains("штатної чисельності кожного підрозділу")));
}

#[test]
fn people_exchanging_crews_and_positions_are_detected_without_total_deltas() {
    let old = vec![
        crew(1, "А", "Працюючий", "ПУ"),
        crew(2, "Б", "Працюючий", "ПУ"),
    ];
    let mut new = old.clone();
    new[0].full_name = old[1].full_name.clone();
    new[1].full_name = old[0].full_name.clone();
    let result = compare(old, new);
    assert!(result.has_changes);
    assert!(result.headline.iter().all(|metric| metric.delta == 0));
    assert_eq!(result.personnel_changes.len(), 2);
    assert!(result
        .personnel_changes
        .iter()
        .all(|change| change.details.contains("Екіпаж:")
            && change.details.contains("Назва позиції:")));
}

#[test]
fn comparison_detects_all_person_and_crew_metadata_edits() {
    for field in [
        "rank",
        "position",
        "location",
        "crew",
        "positionName",
        "bro",
        "sector",
        "uavName",
        "uavType",
        "status",
        "actual",
        "official",
        "duties",
        "notes",
    ] {
        let old = crew(1, "А", "Працюючий", "ПУ");
        let mut new = old.clone();
        match field {
            "rank" => new.rank = "сержант".into(),
            "position" => new.personnel_position = "командир".into(),
            "location" => new.location = "ВІДП".into(),
            "crew" => new.crew_name = "НОВА НАЗВА".into(),
            "positionName" => new.position_name = "НОВА ПОЗИЦІЯ".into(),
            "bro" => new.battle_order = "НОВИЙ БРО".into(),
            "sector" => new.sector = "НОВИЙ СЕКТОР".into(),
            "uavName" => new.uav_name = "НОВИЙ БпАК".into(),
            "uavType" => new.uav_type = "Коптер".into(),
            "status" => new.crew_status = "Формується".into(),
            "actual" => new.crew_actual = "3".into(),
            "official" => new.crew_official = "2".into(),
            "duties" => new.duties = "НОВІ ОБОВ’ЯЗКИ".into(),
            _ => new.notes = "НОВА ПРИМІТКА".into(),
        }
        let result = compare(vec![old], vec![new]);
        assert!(result.has_changes, "lost field: {field}");
        assert_eq!(
            result.personnel_changes.len(),
            1,
            "lost person edit: {field}"
        );
    }
}

#[test]
fn exchanging_crew_statuses_and_types_does_not_disappear_in_unchanged_aggregates() {
    for status in [true, false] {
        let mut old = vec![
            crew(1, "А", "Працюючий", "ПУ"),
            crew(2, "Б", "Формується", "ПУ"),
        ];
        old[1].uav_type = "Коптер".into();
        let mut new = old.clone();
        if status {
            new[0].crew_status = old[1].crew_status.clone();
            new[1].crew_status = old[0].crew_status.clone();
        } else {
            new[0].uav_type = old[1].uav_type.clone();
            new[1].uav_type = old[0].uav_type.clone();
        }
        let result = compare(old, new);
        assert!(result.has_changes);
        assert!(result.sections.is_empty());
        assert_eq!(result.structure_changes.len(), 2);
    }
}

#[test]
fn empty_crew_edits_are_structure_changes_not_fake_person_changes() {
    let mut old = crew(1, "А", "Працюючий", "");
    old.full_name.clear();
    old.rank.clear();
    old.personnel_position.clear();
    let mut new = old.clone();
    new.crew_actual = "3".into();
    new.position_name = "НОВА ПОЗИЦІЯ".into();
    let result = compare(vec![old], vec![new]);
    assert!(result.has_changes);
    assert!(result.headline.iter().all(|metric| metric.delta == 0));
    assert!(result.personnel_changes.is_empty());
    assert_eq!(result.structure_changes.len(), 1);
    assert!(result.structure_changes[0].contains("Фактично в/с в екіпажі: 1 → 3"));
}

#[test]
fn homonyms_in_different_units_are_not_merged_or_dropped() {
    let mut old = pair_of_units();
    old[1].rows[0].full_name = old[0].rows[0].full_name.clone();
    let mut new = next_day(&old);
    new[1].rows[0].rank = "сержант".into();
    let result = compare_exported(&old, &new);
    assert!(result.has_changes);
    assert_eq!(result.personnel_changes.len(), 1);
    assert!(result.personnel_changes[0].details.contains("2 РУБАК:"));
    assert!(result.personnel_changes[0]
        .details
        .contains("Звання: солдат → сержант"));
    assert!(result.warnings.is_empty());
}

#[test]
fn ambiguous_homonyms_are_retained_and_warned_instead_of_guessed() {
    let first = crew(1, "А", "Працюючий", "ПУ");
    let mut second = crew(2, "Б", "Працюючий", "ПУ");
    second.full_name = first.full_name.clone();
    let old = vec![first, second];
    let mut new = old.clone();
    new[0].rank = "сержант".into();
    new[1].rank = "сержант".into();
    let old_unit = unit("old", "1 РУБАК", "08.10.2026", 5, old);
    let snapshot = snapshot(
        std::slice::from_ref(&old_unit),
        &schema().unwrap().locations,
    )
    .unwrap();
    assert_eq!(snapshot.people.values().map(Vec::len).sum::<usize>(), 2);
    let result =
        compare_parsed(&[old_unit], &[unit("new", "1 РУБАК", "09.10.2026", 5, new)]).unwrap();
    assert!(result.personnel_changes.is_empty());
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("Неоднозначний ПІБ")));
}

#[test]
fn unique_person_is_recognized_when_transferred_between_units() {
    let mut old = pair_of_units();
    old[1].rows.clear();
    let mut new = next_day(&old);
    new[1].rows = std::mem::take(&mut new[0].rows);
    let result = compare_parsed(&old, &new).unwrap();
    assert_eq!(result.personnel_changes.len(), 1);
    assert!(result.personnel_changes[0]
        .details
        .contains("Підрозділ: 1 РУБАК → 2 РУБАК"));
}

#[test]
fn semantic_block_type_change_is_visible_even_when_the_display_name_is_reserved() {
    let old = person(1, "custom", "Тимчасові з ТВО", "ВІДП");
    let mut new = old.clone();
    new.kind = "temporaryActing".into();
    new.is_temporary = true;
    new.is_external = true;
    let result = compare(vec![old], vec![new]);
    assert!(result.has_changes);
    assert_eq!(result.personnel_changes.len(), 1);
    assert!(result.personnel_changes[0]
        .details
        .contains("Тип блоку: Інші → Тимчасові з ТВО"));
    assert_eq!(result.structure_changes.len(), 2);
}

#[test]
fn analytics_percent_chart_supports_legitimate_overstaffing_and_matches_cell_precision() {
    let unit = unit(
        "over",
        "ТЕСТОВА РОТА",
        "08.10.2026",
        1,
        vec![
            person(1, "companyManagement", "Управління роти", "ПУ"),
            person(2, "companyManagement", "Управління роти", "ПУ"),
        ],
    );
    let (sheet, charts) = build_analytics_sheet(&[unit], &schema().unwrap().locations).unwrap();
    assert!(sheet.contains("<v>200.0</v>"));
    let spec = charts.iter().find(|spec| spec.percent_axis).unwrap();
    let xml = chart_xml(spec, 1);
    assert!(xml.contains("<c:max val=\"200\"/>"));
    assert!(xml.contains("<c:majorUnit val=\"20\"/>"));
    assert!(xml.contains("<c:v>200.0</c:v>"));
}

#[test]
fn chart_ranges_and_caches_follow_one_to_one_hundred_units() {
    for count in [1, 2, 5, 25, 100] {
        let units = (0..count)
            .map(|index| {
                unit(
                    &format!("id{index}"),
                    &format!("{index} РУБАК"),
                    "08.10.2026",
                    3,
                    vec![
                        crew(index, "ТЕСТ", "Формується", "ПУ"),
                        person(1000 + index, "companyManagement", "Управління роти", "ВІДП"),
                    ],
                )
            })
            .collect::<Vec<_>>();
        let (_, charts) = build_analytics_sheet(&units, &schema().unwrap().locations).unwrap();
        for (index, spec) in charts.iter().enumerate() {
            assert_eq!(spec.last_row - spec.first_row + 1, spec.categories.len());
            for series in &spec.series {
                assert_eq!(series.values.len(), spec.categories.len());
            }
            let xml = chart_xml(spec, index);
            assert!(xml.contains(&format!(
                "${}${}:${}${}",
                spec.category_column, spec.first_row, spec.category_column, spec.last_row
            )));
            if spec.percent_axis {
                assert!(xml.contains("<c:v>66.7</c:v>"));
            }
        }
    }
}

#[test]
fn calendar_validation_handles_month_lengths_and_century_leap_rules() {
    for valid in [
        "29.02.2024",
        "30.04.2026",
        "31.12.2026",
        "29.02.2000",
        "29.02.2400",
    ] {
        assert!(valid_date(valid), "{valid}");
    }
    for invalid in [
        "31.02.2026",
        "29.02.2025",
        "31.04.2026",
        "29.02.2100",
        "00.10.2026",
        "01.00.2026",
        "1.10.2026",
        "01.01.1999",
    ] {
        assert!(!valid_date(invalid), "{invalid}");
    }
}

#[test]
fn large_export_reimport_retains_fifty_units_five_thousand_people_and_one_thousand_crews() {
    let units = (0..50)
        .map(|unit_index| {
            let rows = (0..100)
                .map(|person_index| {
                    let group = person_index / 5;
                    let mut row = crew(
                        unit_index * 1000 + person_index,
                        &format!("ЕКІПАЖ-{group}"),
                        ["Формується", "Працюючий", "Не активний"][group % 3],
                        if person_index % 2 == 0 {
                            "ПУ"
                        } else {
                            "ВІДП"
                        },
                    );
                    row.group_key = format!("{unit_index}-{group}");
                    row.crew_actual = "5".into();
                    row.crew_official = "5".into();
                    row
                })
                .collect();
            unit(
                &format!("stress-{unit_index}"),
                &format!("{} РУБАК", unit_index + 1),
                "08.10.2026",
                120,
                rows,
            )
        })
        .collect::<Vec<_>>();
    let source = analytics_data(&units, &schema().unwrap().locations).unwrap();
    assert_eq!(
        source.units.iter().map(|unit| unit.listed).sum::<i64>(),
        5000
    );
    assert_eq!(
        source.units.iter().map(|unit| unit.present).sum::<i64>(),
        2500
    );
    assert_eq!(source.crew_types, vec![("ФПВ".into(), 1000)]);
    assert_eq!(
        source.crew_statuses,
        vec![
            ("Формуються".into(), 350),
            ("Працюючі".into(), 350),
            ("Не активні".into(), 300)
        ]
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("stress.xlsx");
    export_workbook(&path, &units).unwrap();
    let parsed = parse_file(&path).unwrap();
    assert_eq!(
        parsed
            .rows
            .iter()
            .filter(|row| !row.full_name.is_empty())
            .count(),
        5000
    );
    let reloaded =
        analytics_data(std::slice::from_ref(&parsed), &schema().unwrap().locations).unwrap();
    assert_eq!(
        (
            reloaded.units[0].authorized,
            reloaded.units[0].listed,
            reloaded.units[0].present
        ),
        (6000, 5000, 2500)
    );
    assert_eq!(reloaded.crew_statuses, source.crew_statuses);
    assert_eq!(reloaded.crew_types, source.crew_types);
    assert_eq!(reloaded.locations, source.locations);
    let restored = snapshot(&[parsed], &schema().unwrap().locations).unwrap();
    assert_eq!(restored.units.len(), 50);
    assert!(restored
        .units
        .values()
        .all(|unit| unit.authorized == Some(120)));
}
