// Included in state::tests. Every reader and library is disposable.
fn shelf_reader(f: &Fixture, cx: &mut TestAppContext) -> Destination {
    let volumes = f._temp.path().join("volumes");
    let mount = volumes.join("Kindle");
    for directory in ["documents", "system", "koreader"] {
        fs::create_dir_all(mount.join(directory)).unwrap();
    }
    let destination = takio::destinations::authorize(&mount, &volumes).unwrap();
    f.state.update(cx, |state, cx| {
        state.volumes_root = volumes;
        state.refresh_destinations(cx);
    });
    settle(&f.state, cx);
    destination
}

#[gpui::test]
fn reader_shelf_matches_bytes_counts_unknown_and_trash_removes_mark(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    let book = f.state.read_with(cx, |state, _| state.items[0].clone());
    fs::copy(
        &book.source_path,
        reader.path.join("documents/renamed.epub"),
    )
    .unwrap();
    fs::write(reader.path.join("documents/unknown.epub"), "another book").unwrap();
    f.state.update(cx, |state, cx| {
        state.refresh_destinations(cx);
        assert!(!state.busy);
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.on_reader[&book.id], vec![reader.name.clone()]);
        let shelf = state.reader_shelves[0].1.as_ref().unwrap();
        assert_eq!((shelf.in_library, shelf.not_in_library), (1, 1));
    });
    f.state.update(cx, |state, cx| {
        state.select_only(0, cx);
        state.trash_selected(cx);
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.on_reader.is_empty());
        let shelf = state.reader_shelves[0].1.as_ref().unwrap();
        assert_eq!((shelf.in_library, shelf.not_in_library), (0, 2));
    });
    f.state
        .update(cx, |state, cx| state.set_section(Section::Trash, cx));
    settle(&f.state, cx);
    f.state.update(cx, |state, cx| {
        state.select_only(0, cx);
        state.restore_selected(cx);
    });
    settle(&f.state, cx);
    assert!(
        f.state
            .read_with(cx, |state, _| state.on_reader.contains_key(&book.id))
    );
}

#[gpui::test]
fn reader_shelf_send_review_rescans_sent_book(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    let id = f.state.update(cx, |state, cx| {
        state.select_only(0, cx);
        let id = state.selected_ids()[0].clone();
        state.send_selected_to(reader, cx);
        id
    });
    settle(&f.state, cx);
    assert!(f.state.read_with(cx, |state, _| state.on_reader.is_empty()));
    f.state
        .update(cx, |state, cx| state.confirm_send_preview(cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert!(
            state.delivery_report.as_ref().unwrap().entries[0]
                .result
                .is_ok()
        );
        assert!(state.on_reader.contains_key(&id));
    });
}

#[gpui::test]
fn reader_shelf_empty_documents_and_generic_drives_are_not_errors(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    fs::remove_dir(reader.path.join("documents")).unwrap();
    f.state.update(cx, |state, cx| state.scan_readers(cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        let shelf = state.reader_shelves[0].1.as_ref().unwrap();
        assert_eq!((shelf.in_library, shelf.not_in_library), (0, 0));
    });
    let mut generic = reader;
    generic.kind = takio::destinations::DestinationKind::Generic;
    f.state.update(cx, |state, cx| {
        state.destinations = vec![generic.clone()];
        state.scan_readers(cx);
        assert!(!state.scanning_readers);
        assert!(state.reader_shelves.is_empty());
    });
    let shelves = f
        .state
        .read_with(cx, |state, _| {
            state.engine.request(|reply| Request::ReaderShelves {
                destinations: vec![generic],
                reply,
            })
        })
        .recv()
        .unwrap()
        .unwrap();
    assert!(shelves.is_empty());
}

#[gpui::test]
fn reader_shelf_stale_reply_cannot_replace_newer_scan_or_library(cx: &mut TestAppContext) {
    for switched in [false, true] {
        let f = fixture(cx);
        let reader = shelf_reader(&f, cx);
        let book = f.state.read_with(cx, |state, _| state.items[0].clone());
        fs::copy(&book.source_path, reader.path.join("documents/book.epub")).unwrap();
        f.state.update(cx, |state, cx| state.scan_readers(cx));
        settle(&f.state, cx);
        let old_shelf = f.state.read_with(cx, |state, _| {
            state.reader_shelves[0].1.as_ref().unwrap().clone()
        });
        let (_other, root) = switching_candidate("Other catalogue");
        if switched {
            f.state.update(cx, |state, cx| state.open_library(root, cx));
            settle(&f.state, cx);
            assert!(f.state.read_with(cx, |state, _| state.on_reader.is_empty()));
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        sender.send(Ok(vec![(reader, Ok(old_shelf))])).unwrap();
        f.state.update(cx, |state, cx| {
            // Queue a ready reply before invalidation, without polling the UI task.
            state.await_reader_scan(receiver, state.reader_scan_generation, vec![], cx);
            if switched {
                state.library_epoch = state.library_epoch.wrapping_add(1);
            } else {
                state.destinations.clear();
                state.scan_readers(cx);
            }
        });
        cx.run_until_parked();
        f.state.read_with(cx, |state, _| {
            assert!(state.on_reader.is_empty());
            if switched {
                assert_eq!(state.reader_shelves[0].1.as_ref().unwrap().in_library, 0);
            } else {
                assert!(state.reader_shelves.is_empty());
            }
            assert!(!state.scanning_readers);
        });
    }
}

#[gpui::test]
fn reader_shelf_import_matches_preexisting_reader_file(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    let source = epub(f._temp.path(), "Delta");
    fs::copy(&source, reader.path.join("documents/delta.epub")).unwrap();
    f.state.update(cx, |state, cx| {
        state.import(vec![source], ImportMode::Copy, cx)
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        let book = state
            .items
            .iter()
            .find(|book| book.title == "Delta")
            .unwrap();
        assert!(state.on_reader.contains_key(&book.id));
    });
}
