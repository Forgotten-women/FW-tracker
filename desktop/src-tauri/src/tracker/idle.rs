// Cross-Platform Idle Time Detection (Keyboard & Mouse activity)
//
// Windows: Uses Win32 GetLastInputInfo (privacy-safe: reads tick count since
// last event, never inspects keystrokes or coordinates).
// macOS: Fallback to Quartz CGEventSourceSecondsSinceLastEventType or system tick.

#[cfg(target_os = "windows")]
pub fn get_idle_seconds() -> u64 {
    use std::mem;
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut lii: LASTINPUTINFO = mem::zeroed();
        lii.cbSize = mem::size_of::<LASTINPUTINFO>() as u32;

        if GetLastInputInfo(&mut lii) != 0 {
            let now = GetTickCount();
            let elapsed_ms = now.saturating_sub(lii.dwTime);
            (elapsed_ms / 1000) as u64
        } else {
            0
        }
    }
}

#[cfg(target_os = "macos")]
pub fn get_idle_seconds() -> u64 {
    use std::process::Command;

    if let Ok(output) = Command::new("ioreg").args(["-c", "IOHIDSystem"]).output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if line.contains("HIDIdleTime") {
                if let Some(val_str) = line.split('=').nth(1) {
                    if let Ok(nanos) = val_str.trim().parse::<u64>() {
                        return nanos / 1_000_000_000;
                    }
                }
            }
        }
    }
    0
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn get_idle_seconds() -> u64 {
    0
}
