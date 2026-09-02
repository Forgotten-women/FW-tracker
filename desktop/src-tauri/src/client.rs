// Desktop HTTP Client & Config Store
//
// Communicates with the Vercel backend /api/desktop endpoints.
// Persists server URL, device token, and employee details in local app config.

use serde::{Deserialize, Serialize};
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
pub struct HeartbeatPayload {
    pub activeSeconds: u64,
    pub idleSeconds: u64,
    pub lockState: String,
    pub lockDurationSeconds: u64,
    pub connectedBssid: Option<String>,
    pub currentWifiMac: Option<String>,
    pub isManualBreak: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatResponse {
    pub status: String,
    pub workstationStatus: String,
    pub inOffice: bool,
    pub locationVerdict: Option<String>,
    pub today: SessionStats,
    pub policy: PolicySettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionStats {
    pub dateKey: String,
    pub activeSeconds: u64,
    pub idleSeconds: u64,
    pub breakSeconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PolicySettings {
    pub idleThresholdMinutes: u32,
    pub lockScreenGraceMinutes: u32,
    pub approvedWorkProcesses: String,
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
