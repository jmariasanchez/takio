mod library_engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            library_engine::library_list,
            library_engine::library_import,
            library_engine::library_update,
            library_engine::library_search,
            library_engine::library_cover_set,
            library_engine::library_cover_remove,
            library_engine::library_remove,
            library_engine::library_open,
            library_engine::destination_list,
            library_engine::destination_send,
            library_engine::destination_eject,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Takio");
}
