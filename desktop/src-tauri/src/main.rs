// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autostart;
mod client;
mod db;
mod single_instance;
mod tracker {
    pub mod idle;
    pub mod network;
    pub mod process;
    pub mod session;
}
mod tray;

use client::{AppConfig, HeartbeatPayload, HeartbeatResponse};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Manager, State};
use tokio::time::{sleep, Duration};

static IS_MANUAL_BREAK: AtomicBool = AtomicBool::new(false);

struct AppState {
    config: Mutex<AppConfig>,
    latest_response: Mutex<Option<HeartbeatResponse>>,
}

#[tauri::command]
async fn get_app_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap().clone();
    let resp = state.latest_response.lock().unwrap().clone();
    let server_on_break = resp.as_ref().map(|r| r.today.on_break).unwrap_or(false);
    let is_break = IS_MANUAL_BREAK.load(Ordering::SeqCst) || server_on_break;
    let (lock_state, _) = tracker::session::get_lock_state();
    let idle_secs = tracker::idle::get_idle_seconds();

    Ok(serde_json::json!({
        "enrolled": !cfg.token.is_empty(),
        "employeeName": cfg.employee_name,
        "employeeRole": cfg.employee_role,
        "serverUrl": cfg.server_url,
        "isManualBreak": is_break,
        "lockState": lock_state,
        "idleSeconds": idle_secs,
        "latest": resp,
    }))
}

#[tauri::command]
async fn enroll_device(
    server_url: String,
    code: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = client::enroll(&server_url, &code).await?;
    *state.config.lock().unwrap() = cfg.clone();
    Ok(serde_json::json!({ "success": true, "name": cfg.employee_name }))
}

#[tauri::command]
async fn toggle_manual_break(state: State<'_, AppState>) -> Result<bool, String> {
    let cfg = state.config.lock().unwrap().clone();
    let resp = state.latest_response.lock().unwrap().clone();
    let server_on_break = resp.as_ref().map(|r| r.today.on_break).unwrap_or(false);
    let is_break = IS_MANUAL_BREAK.load(Ordering::SeqCst) || server_on_break;
    let target = !is_break;

    if !cfg.token.is_empty() {
        client::send_break(&cfg, target).await?;
    }

    IS_MANUAL_BREAK.store(target, Ordering::SeqCst);
    Ok(target)
}

fn main() {
    let instance_role = single_instance::check_single_instance();
    let single_instance_listener = match instance_role {
        single_instance::InstanceRole::Primary(listener) => listener,
        single_instance::InstanceRole::Secondary => {
            // Another instance is already running and has been instructed to show window.
            return;
        }
    };

    autostart::ensure_autostart_registered();
    let initial_config = client::load_config();

    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(initial_config.clone()),
            latest_response: Mutex::new(None),
        })
        .system_tray(tray::create_tray())
        .on_system_tray_event(tray::handle_tray_event)
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            enroll_device,
            toggle_manual_break
        ])
        .setup(move |app| {
            let app_handle = app.handle();
            single_instance::start_listener(single_instance_listener, app_handle.clone());

            // On macOS: always show window on launch! On Windows: show if not enrolled
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            if initial_config.token.is_empty() {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            // Background Monitoring & Heartbeat Task
            tauri::async_runtime::spawn(async move {
                let mut sample_count = 0;
                let mut accumulated_active = 0;
                let mut accumulated_idle = 0;
                let mut app_breakdown: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
                let mut latest_app: Option<String> = None;
                let mut first_run = true;

                loop {
                    let state = app_handle.state::<AppState>();
                    let cfg = state.config.lock().unwrap().clone();

                    // On app launch, query initial status immediately without waiting 60s
                    if !cfg.token.is_empty() && first_run {
                        first_run = false;
                        let bssid = tracker::network::get_connected_bssid();
                        let ssid = tracker::network::get_connected_ssid();
                        let visible = tracker::network::get_visible_office_bssids();
                        let local_ip = tracker::network::get_local_ip();
                        let payload = HeartbeatPayload {
                            active_seconds: 0,
                            idle_seconds: 0,
                            lock_state: "UNLOCKED".to_string(),
                            lock_duration_seconds: 0,
                            connected_bssid: bssid,
                            connected_ssid: ssid,
                            visible_office_bssids: if visible.is_empty() { None } else { Some(visible) },
                            current_wifi_mac: None,
                            local_ip,
                            is_manual_break: false,
                            current_app: None,
                            app_breakdown: None,
                        };
                        if let Ok(resp) = client::send_heartbeat(&cfg, payload).await {
                            *state.latest_response.lock().unwrap() = Some(resp.clone());
                            let _ = app_handle.emit_all("heartbeat-updated", resp);
                        }
                    }

                    sleep(Duration::from_secs(10)).await;
                    sample_count += 1;

                    if cfg.token.is_empty() {
                        continue;
                    }

                    let idle_secs = tracker::idle::get_idle_seconds();
                    let (lock_state, lock_duration) = tracker::session::get_lock_state();
                    let bssid = tracker::network::get_connected_bssid();
                    let is_break = IS_MANUAL_BREAK.load(Ordering::SeqCst);

                    let app_tracking_allowed = {
                        let resp = state.latest_response.lock().unwrap();
                        resp.as_ref()
                            .and_then(|r| r.app_tracking_enabled)
                            .unwrap_or(true)
                    };

                    // Track active vs idle seconds in 10s slice
                    if is_break || lock_duration > 300 || idle_secs >= 300 {
                        accumulated_idle += 10;
                    } else {
                        accumulated_active += 10;
                        if app_tracking_allowed {
                            if let Some((proc_name, title)) = tracker::process::get_foreground_window_info() {
                                let app_name = tracker::process::parse_active_application(&proc_name, &title);
                                latest_app = Some(app_name.clone());
                                *app_breakdown.entry(app_name).or_insert(0) += 10;
                            } else {
                                *app_breakdown.entry("Desktop Active".to_string()).or_insert(0) += 10;
                            }
                        } else {
                            latest_app = Some("Active Workstation".to_string());
                            app_breakdown.clear();
                        }
                    }

                    // Check for unapproved process anomalies (e.g. mouse jigglers / unknown apps)
                    let approved_csv = {
                        let resp = state.latest_response.lock().unwrap();
                        resp.as_ref()
                            .map(|r| r.policy.approved_work_processes.clone())
                            .unwrap_or_default()
                    };
                    if let Some((proc_name, dur)) = tracker::process::inspect_and_track_anomaly(&approved_csv) {
                        let _ = client::report_anomaly(&cfg, &proc_name, dur).await;
                    }

                    // Send heartbeat every 60 seconds (6 samples x 10s)
                    if sample_count >= 6 {
                        sample_count = 0;
                        let local_ip = tracker::network::get_local_ip();
                        let ssid = tracker::network::get_connected_ssid();
                        let visible = tracker::network::get_visible_office_bssids();
                        let payload = HeartbeatPayload {
                            active_seconds: accumulated_active,
                            idle_seconds: accumulated_idle,
                            lock_state,
                            lock_duration_seconds: lock_duration,
                            connected_bssid: bssid,
                            connected_ssid: ssid,
                            visible_office_bssids: if visible.is_empty() { None } else { Some(visible.clone()) },
                            current_wifi_mac: None,
                            local_ip,
                            is_manual_break: is_break,
                            current_app: latest_app.clone(),
                            app_breakdown: if app_breakdown.is_empty() { None } else { Some(app_breakdown.clone()) },
                        };
                        match client::send_heartbeat(&cfg, payload).await {
                            Ok(resp) => {
                                accumulated_active = 0;
                                accumulated_idle = 0;
                                app_breakdown.clear();
                                IS_MANUAL_BREAK.store(resp.today.on_break, Ordering::SeqCst);
                                *state.latest_response.lock().unwrap() = Some(resp.clone());
                                let _ = app_handle.emit_all("heartbeat-updated", resp.clone());

                                // If server determined we are outside office, but office Wi-Fi is visible in the air, auto-connect
                                if !resp.in_office && !visible.is_empty() {
                                    tracker::network::auto_connect_office_wifi();
                                }
                            }
                            Err(e) => {
                                eprintln!("[tracker] Heartbeat delivery failed (internet outage?): {e}. Preserving accumulated work time for automatic catch-up on reconnect.");
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(window) = app_handle.get_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    });
}
