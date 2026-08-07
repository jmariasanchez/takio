mod library_engine;
mod menu;

const LIBRARY_USABLE_MARKER: &str = "TAKIO_LIBRARY_USABLE";

fn startup_benchmark_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

#[tauri::command]
fn app_report_library_usable() {
    if startup_benchmark_enabled(std::env::var("TAKIO_STARTUP_BENCHMARK").ok().as_deref()) {
        eprintln!("{LIBRARY_USABLE_MARKER}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            app_report_library_usable,
            library_engine::library_list,
            library_engine::library_get,
            library_engine::library_import,
            library_engine::library_import_many,
            library_engine::library_export_many,
            library_engine::library_attach_format,
            library_engine::library_remove_format,
            library_engine::library_replace_format,
            library_engine::library_update,
            library_engine::library_query,
            library_engine::library_duplicates_list,
            library_engine::library_duplicates_keep,
            library_engine::library_duplicates_reopen,
            library_engine::library_duplicates_merge,
            library_engine::library_trash_list,
            library_engine::library_trash,
            library_engine::library_restore,
            library_engine::library_purge,
            library_engine::library_saved_views_list,
            library_engine::library_saved_view_save,
            library_engine::library_saved_view_remove,
            library_engine::library_search,
            library_engine::library_cover_set,
            library_engine::library_cover_remove,
            library_engine::library_remove,
            library_engine::library_open,
            library_engine::destination_list,
            library_engine::destination_send,
            library_engine::destination_eject,
            library_engine::jobs_list,
            library_engine::jobs_enqueue,
            library_engine::jobs_run_next,
            library_engine::jobs_cancel,
            library_engine::jobs_retry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Takio");
}

#[cfg(test)]
mod tests {
    use super::startup_benchmark_enabled;

    #[test]
    fn startup_marker_requires_an_explicit_benchmark_opt_in() {
        assert!(startup_benchmark_enabled(Some("1")));
        assert!(!startup_benchmark_enabled(None));
        assert!(!startup_benchmark_enabled(Some("0")));
        assert!(!startup_benchmark_enabled(Some("true")));
    }
}
