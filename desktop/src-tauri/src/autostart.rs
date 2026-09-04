// Auto-launch on boot for Windows and macOS

#[cfg(target_os = "windows")]
pub fn ensure_autostart_registered() {
    use std::os::windows::process::CommandExt;
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_str = exe_path.to_string_lossy().to_string();
        // Do not register debug test builds in cargo target directory
        if exe_str.contains("target\\debug") {
            return;
        }
        let formatted_val = format!("\"{}\"", exe_str);
        // CREATE_NO_WINDOW = 0x08000000 so no command prompt pops up
        let _ = std::process::Command::new("reg")
            .args([
                "add",
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                "/v",
                "OfficeTracker",
                "/t",
                "REG_SZ",
                "/d",
                &formatted_val,
                "/f",
            ])
            .creation_flags(0x08000000)
            .output();
    }
}

#[cfg(target_os = "macos")]
pub fn ensure_autostart_registered() {
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_str = exe_path.to_string_lossy().to_string();
        if exe_str.contains("target/debug") {
            return;
        }
        if let Some(home) = dirs::home_dir() {
            let launch_agents = home.join("Library/LaunchAgents");
            let _ = std::fs::create_dir_all(&launch_agents);
            let plist_path = launch_agents.join("com.officetracker.desktop.plist");
            let plist_content = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.officetracker.desktop</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>"#,
                exe_str
            );
            let _ = std::fs::write(plist_path, plist_content);
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn ensure_autostart_registered() {}
