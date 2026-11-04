use super::*;

pub(super) fn switching_candidate(title: &str) -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("library");
    let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
    let mut store = takio::library::store::LibraryStore::create_or_migrate(paths).unwrap();
    let source = temp.path().join("book.txt");
    fs::write(&source, title).unwrap();
    store
        .import(
            &source,
            Some(title),
            takio::library::model::ImportMode::Copy,
        )
        .unwrap();
    (temp, root)
}

fn switching_ready(state: &Entity<LibraryState>, cx: &mut TestAppContext) {
    settle(state, cx);
}

#[gpui::test]
fn library_switch_resets_view_and_routes_mutation_to_new_catalogue(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    let a = f.state.read_with(cx, |state, _| state.library_root.clone());
    let before = fs::read(a.join("library.sqlite")).unwrap();
    let (_b, b) = switching_candidate("Different library");
    f.state.update(cx, |state, cx| {
        state.session.query = "old search".into();
        state.session.filters.tags.push("old tag".into());
        state.session.selected.insert(0);
        state.session.anchor = Some(0);
        state.session.sort.ascending = false;
        state.session.section = Section::Trash;
        state.session.recovery_outcome = Some(RecoveryOutcome {
            path: a.clone(),
            summary: "old".into(),
            detail: "old".into(),
        });
        state.session.delivery_report = Some(SendReport::default());
        state.session.destination_error = Some(takio::app_error!("unknown-destination"));
        state.session.metadata_save_result = Some(Err(takio::app_error!("metadata-unavailable")));
        state
            .session
            .on_reader
            .insert("old-library-book".into(), vec!["old-reader".into()]);
        state.open_library(b.clone(), cx);
        assert!(state.switching_library() && state.busy());
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.library_root, b);
        assert_eq!(state.library_epoch, 1);
        assert_eq!(state.session.section, Section::Library);
        assert!(
            state.session.query.is_empty()
                && state.session.filters.is_empty()
                && state.session.selected.is_empty()
        );
        assert_eq!(state.session.sort, Sort::default());
        assert_ne!(
            state
                .session()
                .destination_error
                .as_ref()
                .map(AppError::code),
            Some("unknown-destination")
        );
        assert!(state.session().metadata_save_result.is_none());
        assert!(!state.session().on_reader.contains_key("old-library-book"));
        assert!(
            state.session.recovery_outcome.is_none() && state.session.delivery_report.is_none()
        );
        assert_eq!(state.session().facets.formats.get("txt"), Some(&1));
    });
    assert_eq!(titles(&f.state, cx), ["Different library"]);
    f.state.update(cx, |state, cx| {
        state.select_all(cx);
        state.trash_selected(cx);
    });
    settle(&f.state, cx);
    assert!(titles(&f.state, cx).is_empty());
    assert_eq!(fs::read(a.join("library.sqlite")).unwrap(), before);
    f.state
        .update(cx, |state, cx| state.open_library(a.clone(), cx));
    settle(&f.state, cx);
    assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
    assert_eq!(f.state.read_with(cx, |state, _| state.library_epoch), 2);
    let b_store = takio::library::store::LibraryStore::open_read_only(
        LibraryPaths::resolve(None, Some(&b.join("library.sqlite"))).unwrap(),
    )
    .unwrap();
    assert_eq!(b_store.list_trash().unwrap()[0].title, "Different library");
}

#[gpui::test]
fn library_switch_invalid_folder_preserves_view_and_does_not_create(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    f.state.update(cx, |state, cx| state.select_only(1, cx));
    let before = f.state.read_with(cx, |state, _| {
        format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}",
            state.library_root,
            state.session().items,
            state.session.selected,
            state.session.query,
            state.session.filters
        )
    });
    let missing = f._temp.path().join("not-a-library");
    f.state
        .update(cx, |state, cx| state.open_library(missing.clone(), cx));
    settle(&f.state, cx);
    assert!(!missing.exists());
    f.state.read_with(cx, |state, _| {
        assert_eq!(
            format!(
                "{:?}|{:?}|{:?}|{:?}|{:?}",
                state.library_root,
                state.session().items,
                state.session.selected,
                state.session.query,
                state.session.filters
            ),
            before
        );
        assert_eq!(state.library_epoch, 0);
        assert!(
            state
                .session()
                .status
                .as_ref()
                .unwrap()
                .text
                .contains("still open and unchanged")
        );
        assert!(state.can_switch_library());
    });
}

#[gpui::test]
fn library_switch_pending_freezes_dispatch_and_failure_releases_busy(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    let (engine, requests) = Engine::test_channel();
    let before = titles(&f.state, cx);
    f.state.update(cx, |state, cx| {
        state.engine = engine;
        state.select_only(0, cx);
        state.open_library("/unused/candidate".into(), cx);
        assert!(!state.request_close(cx));
        assert!(!state.can_mutate());
        state.open_library("/unused/duplicate".into(), cx);
        state.import(vec!["/unused/book".into()], ImportMode::Move, cx);
        state.trash_selected(cx);
        state.reload(cx);
        state.set_query("wrong".into(), cx);
        state.set_section(Section::Trash, cx);
        state.set_sort(SortColumn::Author, cx);
        state.toggle_filter(FilterDimension::Tag, "wrong", cx);
        state.select_all(cx);
        state.select_only(1, cx);
        assert_eq!(state.selected_ids().len(), 1);
        assert!(state.session.query.is_empty() && state.session.filters.is_empty());
        assert_eq!(state.session.section, Section::Library);
    });
    let Request::OpenLibrary { reply, .. } = requests.recv().unwrap() else {
        panic!("expected open request")
    };
    assert!(requests.try_recv().is_err());
    reply
        .send(Err(takio::app_error!("storage-unavailable")))
        .unwrap();
    settle(&f.state, cx);
    assert_eq!(titles(&f.state, cx), before);
    assert!(f.state.read_with(cx, |state, _| state.can_switch_library()));
}

#[gpui::test]
fn library_switch_guards_edits_operations_loading_and_reviews(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    let (engine, requests) = Engine::test_channel();
    f.state.update(cx, |state, cx| {
        state.engine = engine;
        for guard in 0..5 {
            state.session.metadata_editing = guard == 0;
            state.session.activity = if guard == 1 {
                Activity::Running(Operation::Mutation)
            } else {
                Activity::Idle
            };
            state.session.loading = guard == 2;
            state.refreshing_destinations = guard == 3;
            if guard == 4 {
                state.session.activity = Activity::ReviewingSend(SendPreview {
                    destination: takio::delivery::destinations::Destination {
                        id: "test".into(),
                        name: "test".into(),
                        path: "/unused".into(),
                        kind: takio::delivery::destinations::DestinationKind::Generic,
                        features: Vec::new(),
                    },
                    entries: Vec::new(),
                });
            }
            state.open_library("/unused".into(), cx);
            assert!(!state.switching_library());
        }
        state.session.activity = Activity::Idle;
    });
    assert!(requests.try_recv().is_err());
}

#[gpui::test]
fn library_switch_rejects_stale_snapshot_and_old_generic_reply(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    let (_temp, b) = switching_candidate("New library");
    let (generation, old_items) = f.state.update(cx, |state, cx| {
        let _ = cx;
        (state.generation, state.session().items.clone())
    });
    f.state.update(cx, |state, cx| state.open_library(b, cx));
    settle(&f.state, cx);
    let (sender, receiver) = std::sync::mpsc::channel();
    sender.send(Ok(())).unwrap();
    f.state.update(cx, |state, cx| {
        // The deterministic test executor cannot park a synchronous recv while
        // this test holds its sender. Queue a ready reply, then change identity
        // before polling it to exercise the stale generic callback boundary.
        state
            .await_reply(receiver, cx, |state, _: AppResult<()>, cx| {
                state.set_status("obsolete".into(), true, cx)
            })
            .detach();
        state.library_epoch = state.library_epoch.wrapping_add(1);
        let task = cx.background_executor().spawn(async move {
            Ok(LibrarySnapshot {
                items: old_items,
                facets: Arc::new(Facets::default()),
            })
        });
        state.await_snapshot(task, generation, cx).detach();
    });
    cx.run_until_parked();
    assert_eq!(titles(&f.state, cx), ["New library"]);
    assert_ne!(
        f.state.read_with(cx, |state, _| state
            .session()
            .status
            .as_ref()
            .unwrap()
            .text
            .clone()),
        "obsolete"
    );
}

#[gpui::test]
fn library_switch_persists_selection_and_reports_preference_failure(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    let (_temp, b) = switching_candidate("Remembered");
    let preference = f._temp.path().join("profile/last-library");
    f.state.update(cx, |state, cx| {
        state.preference_path = Some(preference.clone());
        state.open_library(b.clone(), cx);
    });
    settle(&f.state, cx);
    assert_eq!(
        crate::preferences::load(&preference).unwrap(),
        Some(b.clone())
    );
    f.state.update(cx, |state, cx| {
        state.preference_path = Some(f._temp.path().to_path_buf());
        state.open_library(b.clone(), cx);
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.library_root, b);
        let status = state.session().status.as_ref().unwrap();
        assert!(status.is_error && status.text.contains("session only"));
    });
}
