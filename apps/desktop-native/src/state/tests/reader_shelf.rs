use super::library::switching_candidate;
use super::*;
#[gpui::test]
fn reader_scan_failures_retain_typed_error_status(cx: &mut TestAppContext) {
    for whole_request in [false, true] {
        let f = fixture(cx);
        let reader = shelf_reader(&f, cx);
        let error = AppError::with_exit_code("destination-unavailable", 74);
        let result: AppResult<crate::engine::ReaderShelves> = if whole_request {
            Err(error)
        } else {
            Ok(vec![(reader.clone(), Err(error))])
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        sender.send(result).unwrap();
        f.state.update(cx, |state, cx| {
            state.session.scanning_readers = true;
            state.await_reader_scan(receiver, state.reader_scan_generation, vec![reader], cx);
        });
        settle(&f.state, cx);
        f.state.read_with(cx, |state, _| {
            assert_eq!(state.reader_shelves.len(), 1);
            let error = state.reader_shelves[0].1.as_ref().unwrap_err();
            assert_eq!(error.code(), "destination-unavailable");
            assert_eq!(error.exit_code(), 74);
            assert!(!state.session.scanning_readers);
            assert!(state.on_reader.is_empty());
            assert!(state.reading.is_empty());
            let summary = crate::views::sidebar::shelf_summary(Some(&state.reader_shelves[0].1));
            assert!(summary.contains("Reconnect"));
            assert!(!summary.contains("destination-unavailable"));
        });
    }
}

fn check_reader_progress(cx: &mut TestAppContext, koreader: bool, status: &str) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    if !koreader {
        fs::remove_dir(reader.path.join("koreader")).unwrap();
    }
    let book = f.state.read_with(cx, |state, _| state.items[0].clone());
    fs::copy(&book.source_path, reader.path.join("documents/book.epub")).unwrap();
    fs::create_dir(reader.path.join("documents/book.sdr")).unwrap();
    fs::write(
        reader.path.join("documents/book.sdr/metadata.epub.lua"),
        format!("return {{ [\"percent_finished\"] = 0.5, [\"summary\"] = {{ [\"status\"] = \"{status}\" }} }}"),
    )
    .unwrap();
    let before = reader_tree_snapshot(&reader.path);
    f.state
        .update(cx, |state, cx| state.refresh_destinations(cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        let shelf = state.reader_shelves[0].1.as_ref().unwrap();
        assert_eq!(shelf.koreader, koreader);
        if koreader {
            let (label, reading) = &state.reading[&book.id];
            assert_eq!(label, "Kindle (KOReader)");
            assert_eq!(state.on_reader[&book.id], vec!["Kindle (KOReader)"]);
            assert_eq!(
                reading.label().as_deref(),
                Some(if status == "complete" {
                    "finished"
                } else {
                    "50%"
                })
            );
            assert_eq!(
                (shelf.finished, shelf.in_progress),
                if status == "complete" { (1, 0) } else { (0, 1) }
            );
        } else {
            assert!(state.reading.is_empty());
            assert_eq!(state.on_reader[&book.id], vec!["Kindle"]);
            assert_eq!((shelf.finished, shelf.in_progress), (0, 0));
            assert!(shelf.reading_for(&book.id).is_none());
        }
    });
    assert_eq!(reader_tree_snapshot(&reader.path), before);
    f.state.update(cx, |state, cx| {
        state.destinations.clear();
        state.scan_readers(cx);
        assert!(state.reading.is_empty());
        assert!(state.on_reader.is_empty());
    });
}

#[gpui::test]
fn koreader_shelf_progress_labels_matched_book(cx: &mut TestAppContext) {
    check_reader_progress(cx, true, "reading");
}

#[gpui::test]
fn koreader_shelf_complete_counts_as_finished(cx: &mut TestAppContext) {
    check_reader_progress(cx, true, "complete");
}

#[gpui::test]
fn stock_kindle_ignores_reading_sidecar(cx: &mut TestAppContext) {
    check_reader_progress(cx, false, "reading");
}

fn reader_tree_snapshot(root: &std::path::Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
    fn visit(
        root: &std::path::Path,
        path: &std::path::Path,
        entries: &mut Vec<(PathBuf, Option<Vec<u8>>)>,
    ) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            let directory = path.is_dir();
            entries.push((
                path.strip_prefix(root).unwrap().to_path_buf(),
                if directory {
                    None
                } else {
                    Some(fs::read(&path).unwrap())
                },
            ));
            if directory {
                visit(root, &path, entries);
            }
        }
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries);
    entries.sort();
    entries
}

#[gpui::test]
fn reader_import_copies_unmatched_and_rescans_without_reader_writes(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    let existing = f.state.read_with(cx, |state, _| state.items[0].clone());
    let before_count = f.state.read_with(cx, |state, _| state.items.len());
    fs::copy(
        &existing.source_path,
        reader.path.join("documents/existing.epub"),
    )
    .unwrap();
    fs::write(
        reader.path.join("documents/ReaderOnly.epub"),
        b"unique reader-only EPUB bytes",
    )
    .unwrap();
    fs::write(
        reader.path.join("documents/store.azw"),
        b"store-only format",
    )
    .unwrap();
    fs::create_dir(reader.path.join("documents/store.sdr")).unwrap();
    fs::write(
        reader.path.join("documents/store.sdr/notes"),
        b"reader notes",
    )
    .unwrap();
    let before = reader_tree_snapshot(&reader.path);
    f.state.update(cx, |state, cx| {
        state.import_from_reader(reader.clone(), cx);
        assert!(state.busy());
        assert_eq!(
            state.status.as_ref().unwrap().text,
            "Adding books from Kindle..."
        );
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.items.len(), before_count + 1);
        let status = &state.status.as_ref().unwrap().text;
        assert!(status.contains("Imported 1, skipped 1"), "{status}");
        assert!(status.contains("1 in a format Takio cannot store"));
        assert!(status.contains("failed 0"));
        let imported = state
            .items
            .iter()
            .find(|book| book.title == "ReaderOnly")
            .unwrap();
        assert!(state.on_reader.contains_key(&imported.id));
        let shelf = state.reader_shelves[0].1.as_ref().unwrap();
        assert_eq!((shelf.in_library, shelf.not_in_library), (2, 1));
    });
    assert_eq!(reader_tree_snapshot(&reader.path), before);
}

#[gpui::test]
fn reader_import_respects_mutation_and_section_guards(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    fs::write(
        reader.path.join("documents/only.epub"),
        b"unmatched reader book",
    )
    .unwrap();
    let count = f.state.read_with(cx, |state, _| state.items.len());
    f.state.update(cx, |state, cx| {
        state.select_only(0, cx);
        state.send_selected_to(reader.clone(), cx);
    });
    settle(&f.state, cx);
    f.state.update(cx, |state, cx| {
        assert!(state.send_preview().is_some());
        let status = state.status.clone();
        state.import_from_reader(reader.clone(), cx);
        assert_eq!(state.status, status);
        assert!(!state.busy());
        state.session.activity = Activity::Idle;
        for guard in 0..3 {
            state.session.activity = if guard == 0 {
                Activity::Running(Operation::Mutation)
            } else {
                Activity::Idle
            };
            state.session.metadata_editing = guard == 1;
            state.session.section = if guard == 2 {
                Section::Trash
            } else {
                Section::Library
            };
            state.import_from_reader(reader.clone(), cx);
            assert_eq!(state.status, status);
        }
        state.session.activity = Activity::Idle;
        state.session.metadata_editing = false;
        state.session.section = Section::Library;
        state.reload(cx);
    });
    settle(&f.state, cx);
    assert_eq!(f.state.read_with(cx, |state, _| state.items.len()), count);
}

#[gpui::test]
fn reader_import_unplugged_reader_reports_reconnect_without_import(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    let count = f.state.read_with(cx, |state, _| state.items.len());
    fs::remove_dir_all(&reader.path).unwrap();
    f.state
        .update(cx, |state, cx| state.import_from_reader(reader, cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.items.len(), count);
        let status = state.status.as_ref().unwrap();
        assert!(status.text.contains("Reconnect"));
        assert!(status.text.contains("Refresh readers"));
        assert!(!state.busy());
    });
}

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
        assert!(!state.busy());
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(state.on_reader[&book.id], vec![reader.label()]);
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
fn delivered_book_with_broken_history_is_reported_as_delivered(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    fs::create_dir(reader.path.join(".takio")).unwrap();
    fs::write(reader.path.join(".takio/deliveries.json"), b"broken").unwrap();
    f.state.update(cx, |state, cx| {
        state.select_only(0, cx);
        state.send_selected_to(reader, cx);
    });
    settle(&f.state, cx);
    f.state
        .update(cx, |state, cx| state.confirm_send_preview(cx));
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        let delivery = state.delivery_report.as_ref().unwrap().entries[0]
            .result
            .as_ref()
            .unwrap();
        assert!(delivery.path.is_file());
        assert!(delivery.record_error.is_some());
        let status = state.status.as_ref().unwrap();
        assert!(status.is_error);
        assert!(status.text.contains("Sent 1"));
        assert!(status.text.contains("0 failed"));
        assert!(
            status
                .text
                .contains("delivered, but history was not updated")
        );
    });
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
        assert!(!state.session.scanning_readers);
        assert!(state.reader_shelves.is_empty());
    });
    let shelves = f
        .state
        .read_with(cx, |state, _| {
            state.engine.request(|reply| Request::ScanReaderShelves {
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
            assert!(!state.session.scanning_readers);
        });
    }
}

#[gpui::test]
fn reader_marks_after_restart_reuse_saved_fingerprints(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    let book = f.state.read_with(cx, |state, _| state.items[0].clone());
    fs::copy(&book.source_path, reader.path.join("documents/book.epub")).unwrap();
    fs::write(
        reader.path.join("documents/reader only.epub"),
        "only on the reader",
    )
    .unwrap();
    f.state.update(cx, |state, cx| state.scan_readers(cx));
    settle(&f.state, cx);
    let root = f._temp.path();
    let cache = root.join(takio::reader_shelf::HASH_CACHE_FILE);
    let saved = fs::read(&cache).expect("the scan saved the reader's fingerprints");

    // Import updates the cache with what it read, so the next launch needs no reading.
    f.state
        .update(cx, |state, cx| state.import_from_reader(reader.clone(), cx));
    settle(&f.state, cx);
    let after_import = fs::read(&cache).unwrap();
    assert_ne!(
        after_import, saved,
        "the imported file's fingerprint is remembered"
    );
    let before = reader_tree_snapshot(&reader.path);
    // Saving replaces the file, so an unchanged identity means nothing was re-read.
    let identity = || {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(&cache).unwrap();
        (metadata.ino(), metadata.mtime(), metadata.mtime_nsec())
    };
    let saved_identity = identity();
    std::thread::sleep(Duration::from_millis(20));

    // A new engine for the same library, as after quitting and reopening the app.
    let restarted = Engine::open_existing(root.to_path_buf()).unwrap();
    let state = cx.new(|cx| LibraryState::new(restarted, cx));
    settle(&state, cx);
    state.update(cx, |state, cx| {
        state.volumes_root = reader.path.parent().unwrap().to_path_buf();
        state.refresh_destinations(cx);
    });
    settle(&state, cx);
    state.read_with(cx, |state, _| {
        let shelf = state.reader_shelves[0].1.as_ref().unwrap();
        assert_eq!((shelf.in_library, shelf.not_in_library), (2, 0));
        assert!(state.on_reader.contains_key(&book.id));
    });
    assert_eq!(
        fs::read(&cache).unwrap(),
        after_import,
        "nothing new had to be read"
    );
    assert_eq!(
        identity(),
        saved_identity,
        "the restarted app re-read nothing"
    );
    assert_eq!(
        reader_tree_snapshot(&reader.path),
        before,
        "the reader is not modified"
    );
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

fn kindle_at(volumes: &Path, name: &str) -> PathBuf {
    let mount = volumes.join(name);
    for directory in ["documents", "system"] {
        fs::create_dir_all(mount.join(directory)).unwrap();
    }
    mount
}

/// Let the volume poll run once, then wait for any refresh and scan it started.
fn poll_volumes(f: &Fixture, cx: &mut TestAppContext) {
    cx.executor()
        .advance_clock(VOLUME_POLL + Duration::from_millis(50));
    settle(&f.state, cx);
}

#[gpui::test]
fn plugging_in_a_reader_is_noticed_without_refresh(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let volumes = f._temp.path().join("auto-volumes");
    fs::create_dir_all(&volumes).unwrap();
    f.state.update(cx, |state, cx| {
        state.volumes_root = volumes.clone();
        state.refresh_destinations(cx);
    });
    settle(&f.state, cx);
    assert!(
        f.state
            .read_with(cx, |state, _| state.destinations.is_empty())
    );

    let book = f.state.read_with(cx, |state, _| state.items[0].clone());
    let mount = kindle_at(&volumes, "Kindle");
    fs::copy(&book.source_path, mount.join("documents/book.epub")).unwrap();
    poll_volumes(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(
            state.destinations.len(),
            1,
            "reader noticed without Refresh"
        );
        assert_eq!(state.on_reader[&book.id], vec!["Kindle".to_owned()]);
    });

    fs::remove_dir_all(&mount).unwrap();
    poll_volumes(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.destinations.is_empty(), "unplugged reader removed");
        assert!(state.on_reader.is_empty(), "stale markers cleared");
        assert!(state.reader_shelves.is_empty());
    });
}

#[gpui::test]
fn unchanged_volumes_do_not_rescan_and_changes_wait_for_open_reviews(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let volumes = f._temp.path().join("auto-volumes");
    let first = kindle_at(&volumes, "Kindle");
    let first = takio::destinations::authorize(&first, &volumes).unwrap();
    f.state.update(cx, |state, cx| {
        state.volumes_root = volumes.clone();
        state.refresh_destinations(cx);
    });
    settle(&f.state, cx);
    let generation = f
        .state
        .read_with(cx, |state, _| state.reader_scan_generation);
    for _ in 0..3 {
        poll_volumes(&f, cx);
    }
    assert_eq!(
        f.state
            .read_with(cx, |state, _| state.reader_scan_generation),
        generation,
        "an unchanged volume list does not rescan the reader"
    );

    // A send review is open: a newly connected reader must not cancel or race it.
    f.state.update(cx, |state, cx| {
        state.select_only(0, cx);
        state.send_selected_to(first, cx);
    });
    settle(&f.state, cx);
    kindle_at(&volumes, "Second");
    poll_volumes(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.send_preview().is_some(), "review left intact");
        assert_eq!(
            state.destinations.len(),
            1,
            "refresh deferred during review"
        );
    });
    f.state
        .update(cx, |state, cx| state.cancel_send_preview(cx));
    poll_volumes(&f, cx);
    f.state.read_with(cx, |state, _| {
        assert_eq!(
            state.destinations.len(),
            2,
            "deferred change applied next tick"
        );
    });
}

#[gpui::test]
fn failed_volume_listing_clears_stale_reader_marks(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let reader = shelf_reader(&f, cx);
    let book = f.state.read_with(cx, |state, _| state.items[0].clone());
    fs::copy(&book.source_path, reader.path.join("documents/book.epub")).unwrap();
    f.state
        .update(cx, |state, cx| state.refresh_destinations(cx));
    settle(&f.state, cx);
    assert!(
        f.state
            .read_with(cx, |state, _| state.on_reader.contains_key(&book.id))
    );

    // The volumes root itself becomes unreadable: listing fails, so nothing can be
    // claimed about which books are on a reader any more.
    f.state.update(cx, |state, cx| {
        state.volumes_root = f._temp.path().join("no-such-volumes-root");
        state.refresh_destinations(cx);
    });
    settle(&f.state, cx);
    f.state.read_with(cx, |state, _| {
        assert!(state.device_error.is_some());
        assert!(state.destinations.is_empty());
        assert!(
            state.on_reader.is_empty(),
            "no stale markers after a failed listing"
        );
        assert!(state.reader_shelves.is_empty());
    });
}
