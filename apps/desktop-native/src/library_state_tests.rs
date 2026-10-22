// Included in state::tests to exercise the real engine with disposable libraries.

fn switching_candidate(title: &str) -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("library");
    let paths = LibraryPaths::resolve(None, Some(&root.join("library.sqlite"))).unwrap();
    let mut store = takio::store::LibraryStore::open(paths, true).unwrap();
    let source = temp.path().join("book.txt");
    fs::write(&source, title).unwrap();
    store.import(&source, Some(title), false).unwrap();
    (temp, root)
}

fn switching_ready(state: &Entity<LibraryState>, cx: &mut TestAppContext) {
    for _ in 0..200 {
        settle(state, cx);
        if !state.read_with(cx, |state, _| state.refreshing_devices) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("device refresh never settled");
}

#[gpui::test]
fn library_switch_resets_view_and_routes_mutation_to_new_catalogue(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    let a = f.state.read_with(cx, |state, _| state.library_root.clone());
    let before = fs::read(a.join("library.sqlite")).unwrap();
    let (_b, b) = switching_candidate("Different library");
    f.state.update(cx, |state, cx| {
        state.query = "old search".into();
        state.filters.tags.push("old tag".into());
        state.selected.insert(0);
        state.anchor = Some(0);
        state.sort.ascending = false;
        state.section = Section::Trash;
        state.recovery_outcome = Some(RecoveryOutcome { path: a.clone(), summary: "old".into(), detail: "old".into() });
        state.delivery_report = Some(SendReport::default());
        state.open_library(b.clone(), cx);
        assert!(state.switching_library && state.busy);
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.library_root, b);
        assert_eq!(state.library_epoch, 1);
        assert_eq!(state.section, Section::Library);
        assert!(state.query.is_empty() && state.filters.is_empty() && state.selected.is_empty());
        assert_eq!(state.sort, Sort::default());
        assert!(state.recovery_outcome.is_none() && state.delivery_report.is_none());
        assert_eq!(state.facets.formats.get("txt"), Some(&1));
    });
    assert_eq!(titles(&f.state, cx), ["Different library"]);
    f.state.update(cx, |state, cx| {
        state.select_all(cx);
        state.trash_selected(cx);
    });
    settle(&f.state, cx);
    assert!(titles(&f.state, cx).is_empty());
    assert_eq!(fs::read(a.join("library.sqlite")).unwrap(), before);
    f.state.update(cx, |state, cx| state.open_library(a.clone(), cx));
    settle(&f.state, cx);
    assert_eq!(titles(&f.state, cx), ["Alpha", "Beta", "Gamma"]);
    assert_eq!(f.state.read_with(cx, |state, _| state.library_epoch), 2);
    let b_store = takio::store::LibraryStore::open_read_only(LibraryPaths::resolve(None, Some(&b.join("library.sqlite"))).unwrap()).unwrap();
    assert_eq!(b_store.list_trash().unwrap()[0].title, "Different library");
}

#[gpui::test]
fn library_switch_invalid_folder_preserves_view_and_does_not_create(cx: &mut TestAppContext) {
    let f = fixture(cx);
    switching_ready(&f.state, cx);
    f.state.update(cx, |state, cx| state.select_only(1, cx));
    let before = f.state.read_with(cx, |state, _| format!("{:?}|{:?}|{:?}|{:?}|{:?}", state.library_root, state.items, state.selected, state.query, state.filters));
    let missing = f._temp.path().join("not-a-library");
    f.state.update(cx, |state, cx| state.open_library(missing.clone(), cx));
    settle(&f.state, cx);
    assert!(!missing.exists());
    f.state.read_with(cx, |state, _| {
        assert_eq!(format!("{:?}|{:?}|{:?}|{:?}|{:?}", state.library_root, state.items, state.selected, state.query, state.filters), before);
        assert_eq!(state.library_epoch, 0);
        assert!(state.status.as_ref().unwrap().text.contains("still open and unchanged"));
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
        assert!(!state.can_close(cx));
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
        assert!(state.query.is_empty() && state.filters.is_empty());
        assert_eq!(state.section, Section::Library);
    });
    let Request::OpenLibrary { reply, .. } = requests.recv().unwrap() else { panic!("expected open request") };
    assert!(requests.try_recv().is_err());
    reply.send(Err(AppError::new("storage-unavailable"))).unwrap();
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
            state.metadata_editing = guard == 0;
            state.busy = guard == 1;
            state.loading = guard == 2;
            state.refreshing_devices = guard == 3;
            state.send_preview = (guard == 4).then(|| SendPreview {
                destination: takio::destinations::Destination { id: "test".into(), name: "test".into(), path: "/unused".into(), kind: takio::destinations::DestinationKind::Generic, features: Vec::new() },
                entries: Vec::new(),
            });
            state.open_library("/unused".into(), cx);
            assert!(!state.switching_library);
        }
        state.send_preview = None;
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
        (state.generation, state.items.clone())
    });
    f.state.update(cx, |state, cx| state.open_library(b, cx));
    settle(&f.state, cx);
    let (sender, receiver) = std::sync::mpsc::channel();
    sender.send(Ok(())).unwrap();
    f.state.update(cx, |state, cx| {
        // The deterministic test executor cannot park a synchronous recv while
        // this test holds its sender. Queue a ready reply, then change identity
        // before polling it to exercise the stale generic callback boundary.
        state.await_reply(receiver, cx, |state, _: AppResult<()>, cx| state.set_status("obsolete".into(), true, cx)).detach();
        state.library_epoch = state.library_epoch.wrapping_add(1);
        let task = cx.background_executor().spawn(async move { Ok(LibrarySnapshot { items: old_items, facets: Arc::new(Facets::default()) }) });
        state.await_snapshot(task, generation, cx).detach();
    });
    cx.run_until_parked();
    assert_eq!(titles(&f.state, cx), ["New library"]);
    assert_ne!(f.state.read_with(cx, |state, _| state.status.as_ref().unwrap().text.clone()), "obsolete");
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
    assert_eq!(crate::preferences::load(&preference).unwrap(), Some(b.clone()));
    f.state.update(cx, |state, cx| {
        state.preference_path = Some(f._temp.path().to_path_buf());
        state.open_library(b.clone(), cx);
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.library_root, b);
        let status = state.status.as_ref().unwrap();
        assert!(status.is_error && status.text.contains("session only"));
    });
}
