// System Tray Menu & Event Handlers
use tauri::{AppHandle, CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem};

pub fn create_tray() -> SystemTray {
    let status_item = CustomMenuItem::new("status".to_string(), "🟢 Status: Active (In Office)").disabled();
    let toggle_break = CustomMenuItem::new("toggle_break".to_string(), "☕ Take Break");
    let show_widget = CustomMenuItem::new("show_widget".to_string(), "📊 Open Status Widget");
    let check_updates = CustomMenuItem::new("check_updates".to_string(), "🔄 Check for Updates");
    let quit = CustomMenuItem::new("quit".to_string(), "❌ Exit");

    let tray_menu = SystemTrayMenu::new()
        .add_item(status_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(show_widget)
        .add_item(toggle_break)
        .add_item(check_updates)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    SystemTray::new().with_menu(tray_menu)
}

pub fn handle_tray_event(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::LeftClick { .. } => {
            if let Some(window) = app.get_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "show_widget" => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "toggle_break" => {
                let _ = app.emit_all("toggle-break", ());
            }
            "check_updates" => {
                crate::trigger_update_check(app.clone());
            }
            "quit" => {
                // Not std::process::exit: that killed the process mid-write
                // of config.json and could wipe the device's pairing.
                crate::request_exit(app.clone());
            }
            _ => {}
        },
        _ => {}
    }
}
