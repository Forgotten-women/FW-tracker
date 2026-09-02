// Wi-Fi Network & Router BSSID Detection
//
// Windows: Queries netsh wlan show interfaces / wlanapi to extract the active BSSID.
// macOS: Queries airport -I / CoreWLAN for the active BSSID.

use std::process::Command;

pub fn get_connected_bssid() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Run netsh wlan show interfaces
        let output = Command::new("netsh")
            .args(["wlan", "show", "interfaces"])
            .output()
            .ok()?;

        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("BSSID") {
                if let Some(pos) = trimmed.find(':') {
                    let bssid = trimmed[pos + 1..].trim().to_lowercase();
                    if !bssid.is_empty() {
                        return Some(bssid);
                    }
                }
            }
        }
        None
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport")
            .arg("-I")
            .output()
            .ok()?;

        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("BSSID:") {
                let bssid = trimmed.trim_start_matches("BSSID:").trim().to_lowercase();
                if !bssid.is_empty() {
                    return Some(bssid);
                }
            }
        }
        None
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}
