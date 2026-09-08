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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub today: SessionStats,
    pub policy: PolicySettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub date_key: String,
    pub active_seconds: u64,
    pub idle_seconds: u64,
    pub break_seconds: u64,
    #[serde(default)]
    pub on_break: bool,
    #[serde(default)]
    pub break_already_taken: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PolicySettings {
    pub idle_threshold_minutes: u32,
    pub lock_screen_grace_minutes: u32,
    pub approved_work_processes: String,
}

pub fn config_path() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("OfficeTracker");
    let _ = fs::create_dir_all(&dir);
    dir.push("config.json");
    dir
}

pub fn load_config() -> AppConfig {
    if let Ok(data) = fs::read_to_string(config_path()) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

pub fn save_config(cfg: &AppConfig) {
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(config_path(), json);
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
