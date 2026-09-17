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

const CAPTURE_SCRIPT: &str = include_str!("../../capture-screen.ps1");

fn capture_screen_frame() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::path::PathBuf;

        let script_path = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("capture-screen.ps1")))
            .filter(|p| p.exists())
            .or_else(|| {
                let cwd = PathBuf::from("capture-screen.ps1");
                if cwd.exists() {
                    Some(cwd)
                } else {
                    None
                }
            })
            .unwrap_or_else(|| {
                let temp_script = std::env::temp_dir().join("ot_capture_screen.ps1");
                let _ = std::fs::write(&temp_script, CAPTURE_SCRIPT);
                temp_script
            });

        if let Ok(out) = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NoLogo",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script_path.to_str().unwrap_or("capture-screen.ps1"),
            ])
            .creation_flags(0x08000000)
            .output()
        {
            let frame = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if (frame.starts_with("/9j/") || frame.starts_with("iVBOR")) && frame.len() > 100 {
                return Some(frame);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let tmp_file = std::env::temp_dir().join(format!("ot_stream_{}.jpg", std::process::id()));
        let tmp_str = tmp_file.to_str().unwrap_or("/tmp/ot_stream.jpg");
        let _ = std::process::Command::new("/usr/sbin/screencapture")
            .args(["-x", "-t", "jpg", tmp_str])
            .output();
        if tmp_file.exists() {
            if let Ok(out) = std::process::Command::new("/usr/bin/base64")
                .args(["-i", tmp_str])
                .output()
            {
                let _ = std::fs::remove_file(&tmp_file);
                let frame = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if (frame.starts_with("/9j/") || frame.starts_with("iVBOR")) && frame.len() > 100 {
                    return Some(frame);
                }
            }
            let _ = std::fs::remove_file(&tmp_file);
        }
    }

    None
}

struct AppState {
    config: Mutex<AppConfig>,
    latest_response: Mutex<Option<HeartbeatResponse>>,
}

#[tauri::command]
async fn get_app_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap().clone();
    let resp = state.latest_response.lock().unwrap().clone();
    let server_on_break = resp.as_ref().map(|r| r.today.on_break).unwrap_or(false);
    let server_break_taken = resp.as_ref().map(|r| r.today.break_already_taken).unwrap_or(false);

    // If server reports break was already taken and no break is running, reconcile local state to false
    let is_break = if server_break_taken && !server_on_break {
        IS_MANUAL_BREAK.store(false, Ordering::SeqCst);
        false
    } else {
        IS_MANUAL_BREAK.load(Ordering::SeqCst) || server_on_break
    };
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
async fn set_manual_break(on_break: bool, state: State<'_, AppState>) -> Result<bool, String> {
    let cfg = state.config.lock().unwrap().clone();
    let target = on_break;

    if !cfg.token.is_empty() {
        if let Err(err) = client::send_break(&cfg, target).await {
            let err_lower = err.to_lowercase();
            // If trying to end break, but server reports no break is currently active,
            // recover cleanly by reconciling local break flag to false
            if !target && (err_lower.contains("no break") || err_lower.contains("not_on_break")) {
                IS_MANUAL_BREAK.store(false, Ordering::SeqCst);
                if let Ok(mut resp_guard) = state.latest_response.lock() {
                    if let Some(ref mut r) = *resp_guard {
                        r.today.on_break = false;
                        r.today.break_already_taken = true;
                    }
                }
                return Ok(false);
            }
            return Err(err);
        }
    }

    IS_MANUAL_BREAK.store(target, Ordering::SeqCst);

    if let Ok(mut resp_guard) = state.latest_response.lock() {
        if let Some(ref mut r) = *resp_guard {
            r.today.on_break = target;
            if !target {
                r.today.break_already_taken = true;
            }
        }
    }

    Ok(target)
}

#[tauri::command]
async fn toggle_manual_break(state: State<'_, AppState>) -> Result<bool, String> {
    let is_break = IS_MANUAL_BREAK.load(Ordering::SeqCst);
    set_manual_break(!is_break, state).await
}

#[tauri::command]
async fn connect_office_wifi() -> Result<(), String> {
    tracker::network::auto_connect_office_wifi();
    Ok(())
}

#[tauri::command]
async fn checkout_shift(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state.config.lock().unwrap().clone();
    if !cfg.token.is_empty() {
        client::send_checkout(&cfg).await
    } else {
        Err("Not enrolled".to_string())
    }
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

    let now_date_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    let initial_latest_response = if !initial_config.cached_date_key.is_empty()
        && initial_config.cached_date_key == now_date_key
        && initial_config.cached_active_seconds > 0
    {
        Some(client::HeartbeatResponse {
            status: "SUCCESS".to_string(),
            workstation_status: "ACTIVE".to_string(),
            in_office: true,
            location_verdict: Some("OFFICE".to_string()),
            app_tracking_enabled: Some(true),
            outside_working_hours: Some(false),
            live_stream_requested: Some(false),
            today: client::SessionStats {
                date_key: initial_config.cached_date_key.clone(),
                check_in_time: None,
                active_seconds: initial_config.cached_active_seconds,
                idle_seconds: 0,
                break_seconds: 0,
                on_break: false,
                break_already_taken: false,
                break_permitted_minutes: Some(30),
                break_started_at: None,
                break_remaining_seconds: None,
            },
            policy: client::PolicySettings::default(),
        })
    } else {
        None
    };

    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(initial_config.clone()),
            latest_response: Mutex::new(initial_latest_response),
        })
        .system_tray(tray::create_tray())
        .on_system_tray_event(tray::handle_tray_event)
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            enroll_device,
            set_manual_break,
            toggle_manual_break,
            connect_office_wifi,
            checkout_shift
        ])
        .setup(move |app| {
            let app_handle = app.handle();
            single_instance::start_listener(single_instance_listener, app_handle.clone());

            // On macOS: always show window on launch! On Windows: show if not enrolled
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.center();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            if initial_config.token.is_empty() {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.center();
                    let _ = window.set_focus();
                }
            }

            // Dedicated Fast Live Screen Stream Worker (sub-second 3-4 FPS real-time streaming)
            let app_handle_stream = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut is_streaming = false;
                let mut last_status_check = std::time::Instant::now() - Duration::from_secs(10);

                #[cfg(target_os = "windows")]
                let mut ps_child: Option<(std::process::Child, std::io::BufReader<std::process::ChildStdout>, std::io::LineWriter<std::process::ChildStdin>)> = None;

                loop {
                    let state = app_handle_stream.state::<AppState>();
                    let cfg = state.config.lock().unwrap().clone();

                    if cfg.token.is_empty() {
                        sleep(Duration::from_secs(3)).await;
                        continue;
                    }

                    let check_interval = if is_streaming { Duration::from_secs(2) } else { Duration::from_secs(1) };
                    if last_status_check.elapsed() >= check_interval {
                        last_status_check = std::time::Instant::now();
                        if let Ok(status) = client::check_stream_status(&cfg).await {
                            is_streaming = status.live_stream_requested && status.is_permitted && !status.on_break && !status.outside_working_hours;
                        }
                    }

                    if is_streaming {
                        let is_break = IS_MANUAL_BREAK.load(Ordering::SeqCst);
                        if !is_break {
                            let mut frame_opt = None;

                            #[cfg(target_os = "windows")]
                            {
                                use std::io::{BufRead, Write};
                                use std::os::windows::process::CommandExt;

                                if ps_child.is_none() {
                                    let script_path = std::env::current_exe()
                                        .ok()
                                        .and_then(|p| p.parent().map(|d| d.join("capture-screen.ps1")))
                                        .filter(|p| p.exists())
                                        .unwrap_or_else(|| {
                                            let temp_script = std::env::temp_dir().join("ot_capture_screen.ps1");
                                            let _ = std::fs::write(&temp_script, CAPTURE_SCRIPT);
                                            temp_script
                                        });

                                    if let Ok(mut cmd) = std::process::Command::new("powershell")
                                        .args([
                                            "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                            "-File", script_path.to_str().unwrap_or("capture-screen.ps1"),
                                            "-Loop"
                                        ])
                                        .stdin(std::process::Stdio::piped())
                                        .stdout(std::process::Stdio::piped())
                                        .creation_flags(0x08000000)
                                        .spawn()
                                    {
                                        let stdin = cmd.stdin.take().map(std::io::LineWriter::new);
                                        let stdout = cmd.stdout.take().map(std::io::BufReader::new);
                                        if let (Some(in_writer), Some(out_reader)) = (stdin, stdout) {
                                            ps_child = Some((cmd, out_reader, in_writer));
                                        }
                                    }
                                }

                                if let Some((_, ref mut reader, ref mut writer)) = ps_child {
                                    if writeln!(writer, "CAPTURE").is_ok() && writer.flush().is_ok() {
                                        let mut line = String::new();
                                        if reader.read_line(&mut line).is_ok() {
                                            let trimmed = line.trim().to_string();
                                            if (trimmed.starts_with("/9j/") || trimmed.starts_with("iVBOR")) && trimmed.len() > 100 {
                                                frame_opt = Some(trimmed);
                                            }
                                        }
                                    } else {
                                        ps_child = None;
                                    }
                                }
                            }

                            if frame_opt.is_none() {
                                frame_opt = capture_screen_frame();
                            }

                            if let Some(frame) = frame_opt {
                                let _ = client::send_stream_frame(&cfg, &frame).await;
                            }
                        }
                        sleep(Duration::from_millis(250)).await;
                    } else {
                        #[cfg(target_os = "windows")]
                        {
                            if let Some((mut child, _, mut writer)) = ps_child.take() {
                                use std::io::Write;
                                let _ = writeln!(writer, "QUIT");
                                let _ = writer.flush();
                                let _ = child.kill();
                            }
                        }
                        sleep(Duration::from_millis(1000)).await;
                    }
                }
            });

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
                            let mut cfg_to_save = cfg.clone();
                            cfg_to_save.cached_active_seconds = resp.today.active_seconds;
                            cfg_to_save.cached_date_key = resp.today.date_key.clone();
                            client::save_config(&cfg_to_save);
                            *state.config.lock().unwrap() = cfg_to_save;
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

                                let local_is_break = IS_MANUAL_BREAK.load(Ordering::SeqCst);
                                let mut final_resp = resp.clone();

                                // If break was ended locally, do NOT let an in-flight delayed heartbeat resurrect on_break = true
                                if !local_is_break {
                                    final_resp.today.on_break = false;
                                    if resp.today.break_seconds > 0 || resp.today.break_already_taken {
                                        final_resp.today.break_already_taken = true;
                                    }
                                } else {
                                    IS_MANUAL_BREAK.store(final_resp.today.on_break, Ordering::SeqCst);
                                }

                                *state.latest_response.lock().unwrap() = Some(final_resp.clone());
                                let mut cfg_to_save = cfg.clone();
                                cfg_to_save.cached_active_seconds = final_resp.today.active_seconds;
                                cfg_to_save.cached_date_key = final_resp.today.date_key.clone();
                                client::save_config(&cfg_to_save);
                                *state.config.lock().unwrap() = cfg_to_save;
                                let _ = app_handle.emit_all("heartbeat-updated", final_resp.clone());

                                // If server determined we are outside office, but office Wi-Fi is visible in the air, auto-connect
                                if !final_resp.in_office && !visible.is_empty() {
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
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                let _ = event.window().hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
