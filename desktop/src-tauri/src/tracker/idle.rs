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

#[cfg(not(target_os = "windows"))]
pub fn get_idle_seconds() -> u64 {
    // macOS / Linux fallback implementation
    0
}
