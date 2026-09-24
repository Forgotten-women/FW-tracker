// Desktop HTTP Client & Config Store
//
// Communicates with the Vercel backend /api/desktop endpoints.
// Persists server URL, device token, and employee details in local app config.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub server_url: String,
    pub token: String,
    pub device_id: String,
    pub employee_name: String,
    pub employee_role: String,
    #[serde(default)]
    pub cached_active_seconds: u64,
    #[serde(default)]
    pub cached_date_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    // Generated once per 60s accumulation interval (main.rs) and carried
    // through unchanged if this exact payload has to be queued to the
    // offline store and replayed later -- lets the backend's existing
    // idempotency check (desktop.js's /heartbeat, desktop_heartbeat_dedupe
    // table) recognise a retried delivery and skip re-applying its
    // active/idle seconds. Without this, a heartbeat whose response was
    // lost after the server had already processed it (a real possibility:
    // the client can't tell "never reached the server" apart from "reached
    // the server, response got lost") got queued and replayed anyway, and
    // the server -- having no way to tell it was a repeat -- added the same
    // interval's seconds again. Optional only for backward JSON
    // compatibility with any already-queued local_events rows from before
    // this field existed.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub event_id: Option<String>,
    pub active_seconds: u64,
    pub idle_seconds: u64,
    pub lock_state: String,
    pub lock_duration_seconds: u64,
    pub connected_bssid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_ssid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_office_bssids: Option<Vec<String>>,
    pub current_wifi_mac: Option<String>,
    pub local_ip: Option<String>,
    pub is_manual_break: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_breakdown: Option<HashMap<String, u64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    pub status: String,
    pub workstation_status: String,
    pub in_office: bool,
    pub location_verdict: Option<String>,
    #[serde(default)]
    pub app_tracking_enabled: Option<bool>,
    #[serde(default)]
    pub outside_working_hours: Option<bool>,
    #[serde(default)]
    pub live_stream_requested: Option<bool>,
    // COUNTED | UNVERIFIED | OUTSIDE_HOURS | ON_BREAK | IDLE | AWAY (older
    // backends omit it). Passed through to the widget as-is.
    #[serde(default)]
    pub credit_state: Option<String>,
    // Instant live-view doorbell subscription (backend lib/liveDoorbell.js).
    // Absent from older backends, null when the server hasn't configured it.
    #[serde(default)]
    pub live_view: Option<LiveViewConfig>,
    pub today: SessionStats,
    pub policy: PolicySettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeConfig {
    pub url: String,
    pub api_key: String,
    pub topic: String,
    #[serde(default)]
    pub event: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveViewConfig {
    #[serde(default)]
    pub protocol: u32,
    #[serde(default)]
    pub realtime: Option<RealtimeConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub date_key: String,
    #[serde(default)]
    pub check_in_time: Option<String>,
    pub active_seconds: u64,
    pub idle_seconds: u64,
    pub break_seconds: u64,
    #[serde(default)]
    pub on_break: bool,
    #[serde(default)]
    pub break_already_taken: bool,
    #[serde(default)]
    pub break_permitted_minutes: Option<u32>,
    #[serde(default)]
    pub break_started_at: Option<u64>,
    #[serde(default)]
    pub break_remaining_seconds: Option<i64>,
    // Office presence (phone app + Wi-Fi/BSSID verification), independent of
    // this agent's own active_seconds -- the same figure the HR dashboard
    // and payroll use. #[serde(default)] so an older backend or a request
    // that hit the try/catch fallback (see backend/src/routes/desktop.js)
    // and omitted/nulled these fields doesn't fail deserialization.
    #[serde(default)]
    pub office_presence_minutes: Option<i64>,
    #[serde(default)]
    pub office_presence_formatted: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotPolicy {
    pub enabled: bool,
    pub interval_minutes: u32,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PolicySettings {
    pub idle_threshold_minutes: u32,
    pub lock_screen_grace_minutes: u32,
    pub approved_work_processes: String,
    pub screenshot_policy: Option<ScreenshotPolicy>,
}

pub fn config_path() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("OfficeTracker");
    let _ = fs::create_dir_all(&dir);
    dir.push("config.json");
    dir
}

/// Local SQLite store for heartbeats that couldn't be delivered (backend
/// outage, no network). See `db::OfflineStore`.
pub fn offline_db_path() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("OfficeTracker");
    let _ = fs::create_dir_all(&dir);
    dir.push("offline_events.db");
    dir
}

fn backup_config_path() -> PathBuf {
    config_path().with_file_name("config.backup.json")
}

fn read_config(path: &PathBuf) -> Option<AppConfig> {
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// The device's pairing lives here. Losing it means the employee has to be
/// given a new enrolment code, so a damaged main file falls back to the
/// backup copy -- the pairing only goes when the app's data folder does.
pub fn load_config() -> AppConfig {
    let main = read_config(&config_path());
    if let Some(cfg) = main.as_ref().filter(|c| !c.token.is_empty()) {
        return cfg.clone();
    }
    if let Some(backup) = read_config(&backup_config_path()).filter(|c| !c.token.is_empty()) {
        eprintln!("[config] main config unreadable or unpaired; restored pairing from backup");
        save_config(&backup);
        return backup;
    }
    main.unwrap_or_default()
}

// Written after every heartbeat. A plain fs::write truncates the file first,
// so an exit (or crash, or power cut) landing mid-write left an empty or
// half-written config.json -- which read back as "not paired" and sent the
// employee back to the enrolment screen. Write a temp file and rename it into
// place instead (the rename replaces the file in one step), and keep a copy.
pub fn save_config(cfg: &AppConfig) {
    let Ok(json) = serde_json::to_string_pretty(cfg) else { return };
    let path = config_path();
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, &json).is_ok() && fs::rename(&tmp, &path).is_ok() {
        if !cfg.token.is_empty() {
            let backup = backup_config_path();
            let backup_tmp = backup.with_extension("json.tmp");
            if fs::write(&backup_tmp, &json).is_ok() {
                let _ = fs::rename(&backup_tmp, &backup);
            }
        }
    } else {
        let _ = fs::remove_file(&tmp);
    }
}

pub async fn enroll(server_url: &str, code: &str) -> Result<AppConfig, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/enroll", server_url.trim_end_matches('/'));

    let os_name = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };

    let body = serde_json::json!({
        "code": code,
        "platform": os_name,
        "model": "Workstation Agent",
        "label": "Work Laptop",
    });

    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Enrollment failed: {}", err_text));
    }

    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

    let cfg = AppConfig {
        server_url: server_url.to_string(),
        token: data["token"].as_str().unwrap_or_default().to_string(),
        device_id: data["deviceId"].as_str().unwrap_or_default().to_string(),
        employee_name: data["employee"]["name"].as_str().unwrap_or("Employee").to_string(),
        employee_role: data["employee"]["role"].as_str().unwrap_or("Team Member").to_string(),
        cached_active_seconds: 0,
        cached_date_key: String::new(),
    };

    save_config(&cfg);
    Ok(cfg)
}

pub async fn send_heartbeat(cfg: &AppConfig, payload: HeartbeatPayload) -> Result<HeartbeatResponse, String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }

    let client = reqwest::Client::new();
    let url = format!("{}/api/desktop/heartbeat", cfg.server_url.trim_end_matches('/'));

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Heartbeat error: {}", res.status()));
    }

    res.json::<HeartbeatResponse>().await.map_err(|e| e.to_string())
}

pub async fn report_anomaly(cfg: &AppConfig, process_name: &str, duration_secs: u64) -> Result<(), String> {
    if cfg.token.is_empty() {
        return Ok(());
    }

    let client = reqwest::Client::new();
    let url = format!("{}/api/desktop/anomaly", cfg.server_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "processName": process_name,
        "durationSeconds": duration_secs,
    });

    let _ = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .json(&body)
        .send()
        .await;

    Ok(())
}

pub async fn send_break(cfg: &AppConfig, on_break: bool) -> Result<serde_json::Value, String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }

    let client = reqwest::Client::new();
    let url = format!("{}/api/desktop/break", cfg.server_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "onBreak": on_break,
        "reason": if on_break { "Desktop Break Started" } else { "Desktop Break Resumed" },
    });

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let err_json: serde_json::Value = res.json().await.unwrap_or_default();
        let msg = err_json["message"].as_str().unwrap_or("Failed to update break state");
        return Err(msg.to_string());
    }

    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

// Set once at start-up from tauri.conf.json's version (Cargo.toml's package
// version is not kept in step with releases), and sent with the live-view
// calls so the dashboard can tell an old agent's slow start from a fault.
static AGENT_VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn set_agent_version(version: String) {
    let _ = AGENT_VERSION.set(version);
}

pub fn agent_version() -> &'static str {
    AGENT_VERSION.get().map(|s| s.as_str()).unwrap_or("unknown")
}

// One client (and so one pooled TLS connection) for the live-view calls:
// at ~1 request a second a fresh reqwest::Client per call meant a fresh TLS
// handshake per frame.
fn live_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct FrameReply {
    #[serde(default)]
    pub status: String,
    /// Whether anyone is still watching. None from a backend older than this
    /// agent, in which case the caller falls back to stream-status checks.
    #[serde(default, rename = "continue")]
    pub keep_going: Option<bool>,
}

/// Sends a frame, or a keepalive when `frame_base64` is None (screen unchanged).
pub async fn send_stream_frame(cfg: &AppConfig, frame_base64: Option<&str>) -> Result<FrameReply, String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }

    let url = format!("{}/api/desktop/stream-frame", cfg.server_url.trim_end_matches('/'));
    let body = match frame_base64 {
        Some(frame) => serde_json::json!({ "frameBase64": frame }),
        None => serde_json::json!({ "keepalive": true }),
    };

    let res = live_http()
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("X-Device-Id", &cfg.device_id)
        .header("X-Agent-Version", agent_version())
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // 413 = frame too big; still a well-formed reply saying whether to go on.
    res.json::<FrameReply>().await.map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BreakState {
    #[serde(default)]
    pub on_break: bool,
    #[serde(default)]
    pub break_already_taken: bool,
    #[serde(default)]
    pub break_started_at: Option<u64>,
    #[serde(default)]
    pub break_permitted_minutes: Option<u32>,
    #[serde(default)]
    pub break_remaining_seconds: Option<i64>,
}

/// Read-only break state, fetched when the phone changes the break (live.rs).
pub async fn fetch_break_state(cfg: &AppConfig) -> Result<BreakState, String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }
    let url = format!("{}/api/desktop/break-state", cfg.server_url.trim_end_matches('/'));
    let res = live_http()
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("X-Device-Id", &cfg.device_id)
        .header("X-Agent-Version", agent_version())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("break-state HTTP {}", res.status()));
    }
    res.json::<BreakState>().await.map_err(|e| e.to_string())
}

/// Puts an Exit on the record before the agent closes (see tray.rs).
pub async fn send_agent_stopped(cfg: &AppConfig, reason: &str) -> Result<(), String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }
    let url = format!("{}/api/desktop/agent-stopped", cfg.server_url.trim_end_matches('/'));
    live_http()
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("X-Device-Id", &cfg.device_id)
        .header("X-Agent-Version", agent_version())
        .json(&serde_json::json!({ "reason": reason }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Tells the backend this agent listens on the doorbell (see live.rs).
pub async fn send_live_hello(cfg: &AppConfig, doorbell: bool, capture: &str) -> Result<(), String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }
    let url = format!("{}/api/desktop/live-hello", cfg.server_url.trim_end_matches('/'));
    live_http()
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("X-Device-Id", &cfg.device_id)
        .header("X-Agent-Version", agent_version())
        .json(&serde_json::json!({ "doorbell": doorbell, "capture": capture }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn send_screenshot(
    cfg: &AppConfig,
    frame_base64: &str,
    active_app: Option<&str>,
    window_title: Option<&str>,
    capture_status: &str,
) -> Result<serde_json::Value, String> {
    if cfg.token.is_empty() || frame_base64.is_empty() {
        return Err("Not enrolled or empty frame".to_string());
    }

    let client = reqwest::Client::new();
    let url = format!("{}/api/desktop/screenshot", cfg.server_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "frameBase64": frame_base64,
        "activeApp": active_app,
        "windowTitle": window_title,
        "captureStatus": capture_status,
    });

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("X-Device-Id", &cfg.device_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Screenshot upload failed: {}", err_text));
    }

    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatusResponse {
    pub status: String,
    #[serde(default)]
    pub live_stream_requested: bool,
    #[serde(default)]
    pub is_permitted: bool,
    #[serde(default)]
    pub on_break: bool,
    #[serde(default)]
    pub outside_working_hours: bool,
}

pub async fn check_stream_status(cfg: &AppConfig) -> Result<StreamStatusResponse, String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }

    let url = format!("{}/api/desktop/stream-status", cfg.server_url.trim_end_matches('/'));

    let res = live_http()
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("X-Device-Id", &cfg.device_id)
        .header("X-Agent-Version", agent_version())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    res.json::<StreamStatusResponse>().await.map_err(|e| e.to_string())
}

pub async fn send_checkout(cfg: &AppConfig) -> Result<serde_json::Value, String> {
    if cfg.token.is_empty() {
        return Err("Not enrolled".to_string());
    }

    let client = reqwest::Client::new();
    let url = format!("{}/api/desktop/checkout", cfg.server_url.trim_end_matches('/'));

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let err_json: serde_json::Value = res.json().await.unwrap_or_default();
        let msg = err_json["message"].as_str().unwrap_or("Failed to checkout shift");
        return Err(msg.to_string());
    }

    res.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}


