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
pub fn get_foreground_process_name() -> Option<String> {
    use std::mem;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }

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
            Some(filename)
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_foreground_process_name() -> Option<String> {
    None
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
