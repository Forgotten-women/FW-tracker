// Foreground Process & Unapproved Anomaly Detection
//
// Identifies the active foreground executable name.
// Matches against the organization's approved_work_processes allowlist.
// If an unapproved process stays active > 15 minutes (900 seconds), flags an anomaly!

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct ProcessAnomalyTracker {
    pub current_process: String,
    pub active_duration_secs: u64,
    pub last_sample_epoch: u64,
}

static TRACKER: Mutex<ProcessAnomalyTracker> = Mutex::new(ProcessAnomalyTracker {
    current_process: String::new(),
    active_duration_secs: 0,
    last_sample_epoch: 0,
});

#[cfg(target_os = "windows")]
pub fn get_foreground_window_info() -> Option<(String, String)> {
    use std::mem;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, GetWindowTextW};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }

        let mut title_buf: [u16; 512] = mem::zeroed();
        let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), 512);
        let title = if title_len > 0 {
            String::from_utf16_lossy(&title_buf[..title_len as usize])
        } else {
            String::new()
        };

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }

        let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process_handle == 0 {
            return None;
        }

        let mut buffer: [u16; 1024] = mem::zeroed();
        let len = GetProcessImageFileNameW(process_handle, buffer.as_mut_ptr(), 1024);
        CloseHandle(process_handle);

        if len > 0 {
            let full_path = String::from_utf16_lossy(&buffer[..len as usize]);
            let filename = full_path
                .rsplit('\\')
                .next()
                .unwrap_or(&full_path)
                .to_lowercase();
            Some((filename, title))
        } else {
            None
        }
    }
}

#[cfg(target_os = "macos")]
pub fn get_foreground_window_info() -> Option<(String, String)> {
    use std::process::Command;

    let apple_script = r#"tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set winTitle to ""
        try
            tell frontApp to set winTitle to name of front window
        end try
        return appName & ":::" & winTitle
    end tell"#;

    if let Ok(output) = Command::new("osascript").args(["-e", apple_script]).output() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Some((app, title)) = text.split_once(":::") {
            return Some((app.trim().to_lowercase(), title.trim().to_string()));
        } else if !text.is_empty() {
            return Some((text.to_lowercase(), String::new()));
        }
    }
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn get_foreground_window_info() -> Option<(String, String)> {
    None
}

pub fn get_foreground_process_name() -> Option<String> {
    get_foreground_window_info().map(|(proc, _)| proc)
}

fn extract_domain_from_url(raw: &str) -> Option<String> {
    let clean = raw.trim();
    let without_proto = if let Some(stripped) = clean.strip_prefix("https://") {
        stripped
    } else if let Some(stripped) = clean.strip_prefix("http://") {
        stripped
    } else {
        clean
    };
    let host = without_proto.split('/').next()?.split(':').next()?.trim().to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host.contains('.') {
        Some(host.to_string())
    } else {
        None
    }
}

pub fn parse_active_application(proc_name: &str, title: &str) -> String {
    let p = proc_name.to_lowercase();
    let p_clean = p.trim_end_matches(".exe");
    let t = title.trim();

    let is_browser = ["chrome", "msedge", "edge", "firefox", "brave", "opera", "safari"].iter().any(|&b| p_clean == b);
    if is_browser {
        let b = if p_clean == "chrome" {
            "Chrome"
        } else if p_clean.contains("edge") {
            "Edge"
        } else if p_clean == "firefox" {
            "Firefox"
        } else {
            "Browser"
        };

        // Check if title has URL embedded from macOS AppleScript or Windows inspector
        if let Some(idx) = t.find("[URL:") {
            if let Some(end_idx) = t[idx..].find(']') {
                let raw_url = &t[idx + 5..idx + end_idx];
                if let Some(domain) = extract_domain_from_url(raw_url) {
                    return format!("{} ({})", domain, b);
                }
            }
        }

        if !t.is_empty() {
            let lower = t.to_lowercase();
            if lower.contains("youtube") { return format!("youtube.com ({})", b); }
            if lower.contains("figma") { return format!("figma.com ({})", b); }
            if lower.contains("github") { return format!("github.com ({})", b); }
            if lower.contains("gitlab") { return format!("gitlab.com ({})", b); }
            if lower.contains("jira") || lower.contains("atlassian") { return format!("atlassian.net ({})", b); }
            if lower.contains("chatgpt") || lower.contains("openai") { return format!("chatgpt.com ({})", b); }
            if lower.contains("claude") { return format!("claude.ai ({})", b); }
            if lower.contains("google meet") || lower.contains("meet.google") { return format!("meet.google.com ({})", b); }
            if lower.contains("google docs") { return format!("docs.google.com ({})", b); }
            if lower.contains("google sheets") { return format!("sheets.google.com ({})", b); }
            if lower.contains("google slides") { return format!("slides.google.com ({})", b); }
            if lower.contains("google drive") { return format!("drive.google.com ({})", b); }
            if lower.contains("notion") { return format!("notion.so ({})", b); }
            if lower.contains("canva") { return format!("canva.com ({})", b); }
            if lower.contains("stack overflow") { return format!("stackoverflow.com ({})", b); }
            if lower.contains("linkedin") { return format!("linkedin.com ({})", b); }
            if lower.contains("whatsapp") { return format!("web.whatsapp.com ({})", b); }
            if lower.contains("netflix") { return format!("netflix.com ({})", b); }
            if lower.contains("reddit") { return format!("reddit.com ({})", b); }
            if lower.contains("twitter") || lower.contains("x.com") { return format!("x.com ({})", b); }
            if lower.contains("facebook") { return format!("facebook.com ({})", b); }
            if lower.contains("instagram") { return format!("instagram.com ({})", b); }

            let parts: Vec<&str> = t.split(" - ").collect();
            if parts.len() >= 2 {
                let site = parts[parts.len() - 2].trim();
                if !site.is_empty() && site.len() < 28 && !site.to_lowercase().contains("google") && !site.to_lowercase().contains("microsoft") {
                    let clean = site.to_lowercase().replace(' ', "");
                    return format!("{} ({})", clean, b);
                }
            }
            return format!("Web Browsing ({})", b);
        }
        return format!("Web Browsing ({})", b);
    }

    match p_clean {
        "antigravity ide" | "antigravity" => "Antigravity IDE".to_string(),
        "code" => "VS Code".to_string(),
        "cursor" => "Cursor Editor".to_string(),
        "webstorm64" | "webstorm" => "WebStorm".to_string(),
        "idea64" | "idea" => "IntelliJ IDEA".to_string(),
        "pycharm64" | "pycharm" => "PyCharm".to_string(),
        "slack" => "Slack".to_string(),
        "teams" | "ms-teams" => "Microsoft Teams".to_string(),
        "zoom" => "Zoom Meetings".to_string(),
        "excel" => "Microsoft Excel".to_string(),
        "winword" => "Microsoft Word".to_string(),
        "powerpnt" => "Microsoft PowerPoint".to_string(),
        "outlook" => "Microsoft Outlook".to_string(),
        "onenote" => "OneNote".to_string(),
        "notepad" => "Notepad".to_string(),
        "notepad++" => "Notepad++".to_string(),
        "spotify" => "Spotify".to_string(),
        "discord" => "Discord".to_string(),
        "postman" => "Postman".to_string(),
        "dbeaver" => "DBeaver".to_string(),
        "terminal" | "windowsterminal" => "Windows Terminal".to_string(),
        "powershell" => "PowerShell".to_string(),
        "cmd" => "Command Prompt".to_string(),
        "explorer" => "File Explorer".to_string(),
        other => {
            if other.is_empty() || other == "unknown" {
                "Desktop Active".to_string()
            } else {
                let mut chars = other.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => "Desktop Active".to_string(),
                }
            }
        }
    }
}

/// Checks the current process against the approved allowlist.
/// Returns Some((process_name, duration_secs)) if an unapproved process has been active > 15m.
pub fn inspect_and_track_anomaly(approved_csv: &str) -> Option<(String, u64)> {
    let proc = get_foreground_process_name().unwrap_or_else(|| "unknown".to_string());
    if proc == "unknown" || proc.is_empty() {
        return None;
    }

    // Standard baseline system processes that are always allowed
    let is_approved = proc.contains("explorer.exe")
        || proc.contains("officetracker")
        || proc.contains("taskmgr.exe")
        || approved_csv
            .split(',')
            .any(|item| item.trim().eq_ignore_ascii_case(&proc));

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut guard = TRACKER.lock().ok()?;
    let elapsed = if guard.last_sample_epoch > 0 {
        now.saturating_sub(guard.last_sample_epoch).min(30)
    } else {
        10
    };
    guard.last_sample_epoch = now;

    if is_approved {
        // Reset anomaly counter when working in approved tools
        guard.current_process = proc;
        guard.active_duration_secs = 0;
        None
    } else {
        if guard.current_process == proc {
            guard.active_duration_secs += elapsed;
        } else {
            guard.current_process = proc.clone();
            guard.active_duration_secs = elapsed;
        }

        // Anomaly threshold: 15 minutes (900 seconds)
        if guard.active_duration_secs >= 900 {
            let dur = guard.active_duration_secs;
            guard.active_duration_secs = 0; // reset after alerting
            Some((proc, dur))
        } else {
            None
        }
    }
}
