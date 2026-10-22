fn preparation_channel(f: &Fixture, cx: &mut TestAppContext) -> Receiver<Request> {
    let (engine, requests) = Engine::test_channel();
    f.state.update(cx, |s, _| s.engine = engine);
    requests
}

fn preparation_review(item: &LibraryItem, available: bool) -> PreparationPreview {
    PreparationPreview {
        item_id: item.id.clone(),
        title: item.title.clone(),
        source_path: item.source_path.clone(),
        source_bytes: fs::metadata(&item.source_path).unwrap().len(),
        source_sha256: "reviewed-test-fingerprint".into(),
        backend: takio::conversion::BackendDiscovery {
            available,
            path: available.then(|| PathBuf::from("/unused-test-converter")),
            source: "test",
        },
    }
}

fn reply_preparation_preview(requests: &Receiver<Request>, item: &LibraryItem, available: bool) {
    match requests.try_recv().unwrap() {
        Request::PreviewPrepare { item_id, reply } => {
            assert_eq!(item_id, item.id);
            reply.send(Ok(preparation_review(item, available))).unwrap();
        }
        _ => panic!("expected preparation preview only"),
    }
}

#[gpui::test]
fn preparation_cancel_pending_and_ready_never_converts(cx: &mut TestAppContext) {
    for ready in [false, true] {
        let f = fixture(cx);
        let requests = preparation_channel(&f, cx);
        let item = f.state.read_with(cx, |s, _| s.items[0].clone());
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            s.prepare_selected(cx);
        });
        if ready {
            reply_preparation_preview(&requests, &item, true);
            settle(&f.state, cx);
        }
        f.state.update(cx, |s, cx| {
            s.cancel_preparation(cx);
            s.confirm_preparation(cx);
        });
        if !ready {
            reply_preparation_preview(&requests, &item, true);
            settle(&f.state, cx);
        }
        f.state.read_with(cx, |s, _| {
            assert!(s.preparation_preview.is_none());
            assert!(s.can_mutate());
            assert!(s.status.as_ref().unwrap().text.contains("cancelled"));
        });
        assert!(requests.try_recv().is_err());
        assert_eq!(fs::read(&item.source_path).unwrap(), b"book Alpha");
    }
}

#[gpui::test]
fn preparation_section_round_trip_invalidates_pending_preview(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let requests = preparation_channel(&f, cx);
    let item = f.state.read_with(cx, |s, _| s.items[0].clone());
    f.state.update(cx, |s, cx| {
        s.prepare_item(item.id.clone(), cx);
        s.set_section(Section::Trash, cx);
        s.set_section(Section::Library, cx);
    });
    reply_preparation_preview(&requests, &item, true);
    match requests.try_recv().unwrap() {
        Request::ListTrash { reply } => reply.send(Ok(Vec::new())).unwrap(),
        _ => panic!("expected trash query"),
    }
    match requests.try_recv().unwrap() {
        Request::Query { reply, .. } => reply.send(Ok(vec![(*item).clone()])).unwrap(),
        _ => panic!("expected library query"),
    }
    settle(&f.state, cx);
    f.state.read_with(cx, |s, _| {
        assert!(s.preparation_preview.is_none());
        assert!(s.can_mutate());
    });
    assert!(requests.try_recv().is_err());
}

#[gpui::test]
fn preparation_confirmation_captures_id_and_success_reloads_without_sending(
    cx: &mut TestAppContext,
) {
    let f = fixture(cx);
    let requests = preparation_channel(&f, cx);
    let item = f.state.read_with(cx, |s, _| s.items[0].clone());
    f.state.update(cx, |s, cx| {
        s.delivery_report = Some(SendReport::default());
        s.delivery_exclusions.push(SendPreviewEntry {
            item_id: item.id.clone(),
            title: item.title.clone(),
            result: Err("no-compatible-format".into()),
        });
        s.select_only(0, cx);
        s.prepare_selected(cx);
        assert!(s.delivery_report.is_none());
        assert!(s.delivery_exclusions.is_empty());
        s.select_only(1, cx);
    });
    reply_preparation_preview(&requests, &item, true);
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| {
        s.confirm_preparation(cx);
        s.confirm_preparation(cx);
        assert!(s.busy);
        assert!(!s.can_close(cx));
        s.cancel_preparation(cx);
        assert!(s.busy);
    });
    match requests.try_recv().unwrap() {
        Request::PrepareReviewed { preview, reply } => {
            assert_eq!(preview.item_id, item.id);
            assert_eq!(preview.source_sha256, "reviewed-test-fingerprint");
            reply.send(Ok((*item).clone())).unwrap();
        }
        _ => panic!("expected explicit preparation"),
    }
    let query_reply = std::thread::spawn(move || {
        match requests.recv_timeout(Duration::from_secs(2)).unwrap() {
            Request::Query { reply, .. } => reply.send(Ok(vec![(*item).clone()])).unwrap(),
            _ => panic!("success must reload, not send"),
        }
        requests
    });
    settle(&f.state, cx);
    let requests = query_reply.join().unwrap();
    f.state.read_with(cx, |s, _| {
        assert_eq!(s.items.len(), 1);
        assert_eq!(
            s.status.as_ref().unwrap().text,
            "AZW3 prepared. EPUB kept. Review send when ready."
        );
        assert!(!s.status.as_ref().unwrap().is_error);
        assert!(s.delivery_report.is_none());
    });
    assert!(requests.try_recv().is_err());
}

#[gpui::test]
fn preparation_review_and_running_conversion_block_overlapping_actions(cx: &mut TestAppContext) {
    for running in [false, true] {
        let f = fixture(cx);
        let requests = preparation_channel(&f, cx);
        let item = f.state.read_with(cx, |s, _| s.items[0].clone());
        let volumes = f._temp.path().join("volumes");
        let mount = volumes.join("Kindle");
        fs::create_dir_all(mount.join("documents")).unwrap();
        fs::create_dir_all(mount.join("system")).unwrap();
        let destination = takio::destinations::authorize(&mount, &volumes).unwrap();
        f.state.update(cx, |s, cx| {
            s.select_only(0, cx);
            s.preparation_preview = Some(preparation_review(&item, true));
            if running {
                s.confirm_preparation(cx);
            }
            assert!(!s.can_mutate());
            s.import(vec![item.source_path.clone()], ImportMode::Copy, cx);
            s.trash_selected(cx);
            s.update_metadata(item.id.clone(), LibraryPatch::default(), cx);
            s.send_selected_to(destination.clone(), cx);
            s.confirm_send_preview(cx);
            s.eject(destination, cx);
            s.prepare_selected(cx);
            s.section = Section::Trash;
            s.restore_selected(cx);
            s.purge_confirmed(vec![item.id.clone()], cx);
            s.section = Section::Library;
        });
        if running {
            match requests.try_recv().unwrap() {
                Request::PrepareReviewed { reply, .. } => {
                    reply.send(Err(AppError::new("conversion-failed"))).unwrap();
                }
                _ => panic!("expected conversion only"),
            }
            settle(&f.state, cx);
        }
        assert!(requests.try_recv().is_err());
        assert_eq!(fs::read(&item.source_path).unwrap(), b"book Alpha");
        assert_eq!(fs::read_dir(mount.join("documents")).unwrap().count(), 0);
    }
}

#[gpui::test]
fn preparation_unavailable_backend_and_invalid_selection_never_execute(cx: &mut TestAppContext) {
    let f = fixture(cx);
    let requests = preparation_channel(&f, cx);
    f.state.update(cx, |s, cx| {
        s.prepare_selected(cx);
        s.select_all(cx);
        s.prepare_selected(cx);
    });
    assert!(requests.try_recv().is_err());
    let item = f.state.read_with(cx, |s, _| s.items[0].clone());
    f.state
        .update(cx, |s, cx| s.prepare_item(item.id.clone(), cx));
    reply_preparation_preview(&requests, &item, false);
    settle(&f.state, cx);
    f.state.update(cx, |s, cx| {
        s.confirm_preparation(cx);
        s.confirm_preparation(cx);
        assert!(!s.busy);
        assert!(s.preparation_preview.is_some());
        assert!(s.status.as_ref().unwrap().text.contains("Install Calibre"));
    });
    assert!(requests.try_recv().is_err());
}

#[gpui::test]
fn preparation_failure_preserves_sources_and_never_claims_success(cx: &mut TestAppContext) {
    for code in [
        "prepare-source-unavailable",
        "prepare-source-changed",
        "prepare-backend-changed",
        "no-epub-source",
        "format-exists",
        "destination-exists",
        "item-trashed",
        "backend-unavailable",
        "conversion-failed",
        "conversion-timeout",
        "artifact-invalid",
    ] {
        let f = fixture(cx);
        let requests = preparation_channel(&f, cx);
        let item = f.state.read_with(cx, |s, _| s.items[0].clone());
        f.state.update(cx, |s, cx| {
            s.preparation_preview = Some(preparation_review(&item, true));
            s.confirm_preparation(cx);
        });
        match requests.try_recv().unwrap() {
            Request::PrepareReviewed { reply, .. } => reply.send(Err(AppError::new(code))).unwrap(),
            _ => panic!("expected preparation"),
        }
        settle(&f.state, cx);
        f.state.read_with(cx, |s, _| {
            let status = s.status.as_ref().unwrap();
            assert!(status.is_error);
            assert!(!status.text.contains("AZW3 prepared."));
            assert!(!status.text.contains(code));
            if code == "destination-exists" {
                assert!(status.text.contains("managed destination"));
                assert!(status.text.contains("not overwritten"));
                assert!(status.text.contains("existing bytes were kept"));
                assert!(status.text.contains("before retrying"));
            }
            if code == "item-trashed" {
                assert!(status.text.contains("Restore it to the library"));
                assert!(status.text.contains("review the operation again"));
            }
            if code == "artifact-invalid" {
                assert!(
                    status
                        .text
                        .starts_with("The converted file could not be verified.")
                );
            }
            assert!(s.can_mutate());
            assert_eq!(s.items.len(), 3);
            assert!(s.delivery_report.is_none());
        });
        assert_eq!(fs::read(&item.source_path).unwrap(), b"book Alpha");
        assert_eq!(
            fs::read(f._temp.path().join("Alpha.epub")).unwrap(),
            b"book Alpha"
        );
        assert!(requests.try_recv().is_err());
    }
}
