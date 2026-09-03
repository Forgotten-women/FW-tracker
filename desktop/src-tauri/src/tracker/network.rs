// Wi-Fi Network & Router BSSID Detection
//
// Windows: Queries netsh wlan show interfaces / wlanapi to extract the active BSSID.
// macOS: Queries airport -I / CoreWLAN for the active BSSID.

use std::net::UdpSocket;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// True if `w` is exactly `xx:xx:xx:xx:xx:xx`.
fn is_mac(w: &[u8]) -> bool {
    w.len() == 17
        && w.iter().enumerate().all(|(i, c)| {
            if (i + 1) % 3 == 0 {
                *c == b':'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// The MAC address on a line that mentions BSSID, whatever the label reads.
///
/// Reading the value by its label is what broke: the wording differs between
/// Windows versions ("BSSID" vs "AP BSSID") and between locales. The MAC's own
/// shape does not, so that is what is matched.
fn extract_mac(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    if !lower.contains("bssid") {
        return None;
    }
    let bytes = lower.as_bytes();
    if bytes.len() < 17 {
        return None;
    }
    for start in 0..=(bytes.len() - 17) {
        let window = &bytes[start..start + 17];
        if is_mac(window) {
            // Every byte is an ASCII hex digit or ':', so this is valid UTF-8.
            return String::from_utf8(window.to_vec()).ok();
        }
    }
    None
}

pub fn get_connected_bssid() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Run netsh wlan show interfaces silently without flashing console window
        let output = Command::new("netsh")
            .args(["wlan", "show", "interfaces"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;

        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            // Windows 10 labels this line "BSSID", Windows 11 labels it
            // "AP BSSID". Matching on the label meant every Windows 11 laptop
            // reported no access point, which the server reads as "not on
            // office Wi-Fi" - so the day was silently recorded as remote.
            // Match the MAC itself instead of the wording around it.
            if let Some(mac) = extract_mac(line) {
                return Some(mac);
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
            if let Some(mac) = extract_mac(line) {
                return Some(mac);
            }
        }
        None
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

/// Resolves the primary local IPv4 address used for outbound network traffic.
/// Queries the OS routing table without generating network packets.
pub fn get_local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local_addr = socket.local_addr().ok()?;
    let ip = local_addr.ip();
    if ip.is_loopback() {
        return None;
    }
    Some(ip.to_string())
}

