// Workstation Session & Screen Lock State Tracker
//
// Monitors screen lock/unlock/sleep events and computes continuous lock duration.
// The 5-minute grace period is evaluated server-side and client-side.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub static IS_LOCKED: AtomicBool = AtomicBool::new(false);
pub static LOCKED_SINCE: AtomicU64 = AtomicU64::new(0);

pub fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Polls whether the workstation is currently locked (or showing the
/// Winlogon/secure desktop -- a UAC prompt, the login screen after a sleep,
/// etc.), so callers can feed it into set_screen_locked() below.
///
/// Uses OpenInputDesktop rather than registering for WM_WTSSESSION_CHANGE
/// notifications: that requires owning a window and subclassing its message
/// procedure, which risks interfering with Tauri's own event loop in ways
/// that are hard to verify without a full GUI test pass. OpenInputDesktop is
/// the same polling shape this file already uses for idle detection --
/// while the session is locked, the interactive desktop is owned by
/// Winlogon's secure desktop instead of the normal one, so opening the
/// current *input* desktop fails; it succeeds again the moment the user
/// unlocks. This is a standard, widely-used technique for exactly this
/// check (screensaver/lock-state utilities have used it for decades).
#[cfg(target_os = "windows")]
pub fn poll_is_locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_SWITCHDESKTOP};

    unsafe {
        let hdesk = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if hdesk == 0 {
            // Could not open the input desktop -- something else (Winlogon's
            // secure desktop) owns it, which only happens while locked.
            true
        } else {
            CloseDesktop(hdesk);
            false
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn poll_is_locked() -> bool {
    false
}

pub fn set_screen_locked(locked: bool) {
    let prev = IS_LOCKED.swap(locked, Ordering::SeqCst);
    if locked && !prev {
        // Just transitioned to LOCKED -> record start timestamp
        LOCKED_SINCE.store(now_epoch_secs(), Ordering::SeqCst);
    } else if !locked {
        // UNLOCKED -> clear lock timestamp
        LOCKED_SINCE.store(0, Ordering::SeqCst);
    }
}

pub fn get_lock_state() -> (String, u64) {
    let locked = IS_LOCKED.load(Ordering::SeqCst);
    if locked {
        let since = LOCKED_SINCE.load(Ordering::SeqCst);
        let now = now_epoch_secs();
        let duration = now.saturating_sub(since);
        ("LOCKED".to_string(), duration)
    } else {
        ("UNLOCKED".to_string(), 0)
    }
}
