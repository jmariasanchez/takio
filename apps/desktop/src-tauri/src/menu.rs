use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, EventTarget, Runtime,
};

const MENU_EVENT: &str = "takio://menu-action";

const IMPORT_ID: &str = "takio-import";
const OPEN_SELECTED_ID: &str = "takio-open-selected";
const SEND_SELECTED_ID: &str = "takio-send-selected";
const EJECT_SELECTED_ID: &str = "takio-eject-selected";
const FIND_ID: &str = "takio-find";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let import = MenuItemBuilder::with_id(IMPORT_ID, "Import…")
        .accelerator("CmdOrCtrl+Shift+I")
        .build(app)?;
    let open_selected = MenuItemBuilder::with_id(OPEN_SELECTED_ID, "Open Selected")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let send_selected = MenuItemBuilder::with_id(SEND_SELECTED_ID, "Send Selected").build(app)?;
    let eject_selected = MenuItemBuilder::with_id(EJECT_SELECTED_ID, "Eject Selected")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let find = MenuItemBuilder::with_id(FIND_ID, "Find")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, &app.package_info().name)
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&import)
        .item(&open_selected)
        .item(&send_selected)
        .item(&eject_selected)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(action) = action_for_menu_id(id) else {
        return;
    };

    if let Err(error) = app.emit_to(EventTarget::webview_window("main"), MENU_EVENT, action) {
        eprintln!("failed to emit menu action: {error}");
    }
}

fn action_for_menu_id(id: &str) -> Option<&'static str> {
    match id {
        IMPORT_ID => Some("import"),
        OPEN_SELECTED_ID => Some("open-selected"),
        SEND_SELECTED_ID => Some("send-selected"),
        EJECT_SELECTED_ID => Some("eject-selected"),
        FIND_ID => Some("find"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::action_for_menu_id;

    #[test]
    fn maps_only_supported_menu_actions() {
        assert_eq!(action_for_menu_id("takio-import"), Some("import"));
        assert_eq!(
            action_for_menu_id("takio-open-selected"),
            Some("open-selected")
        );
        assert_eq!(
            action_for_menu_id("takio-send-selected"),
            Some("send-selected")
        );
        assert_eq!(
            action_for_menu_id("takio-eject-selected"),
            Some("eject-selected")
        );
        assert_eq!(action_for_menu_id("takio-find"), Some("find"));
        assert_eq!(action_for_menu_id("takio-unknown"), None);
    }
}
