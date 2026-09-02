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
