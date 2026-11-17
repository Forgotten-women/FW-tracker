// IT Administration & Fleet Management Relay Client
// Connects silently to the central IT Relay over WebSocket.
// Executes user-level maintenance commands with CREATE_NO_WINDOW (zero popups on employee screen).

use crate::client::AppConfig;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

fn current_config(app: &AppHandle) -> AppConfig {
    app.state::<crate::AppState>().config.lock().unwrap().clone()
}

pub async fn run(app: AppHandle) {
    let mut backoff_secs = 5u64;

    loop {
        let cfg = current_config(&app);
        if cfg.token.is_empty() || cfg.server_url.is_empty() || cfg.device_id.is_empty() {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        }

        let base = cfg.server_url.trim_end_matches('/');
        let (proto, host) = if let Some(h) = base.strip_prefix("https://") {
            ("wss", h)
        } else if let Some(h) = base.strip_prefix("http://") {
            ("ws", h)
        } else {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        };

        let ws_url = format!(
            "{}://{}/api/it/relay?role=agent&deviceId={}&token={}",
            proto, host, cfg.device_id, cfg.token
        );

        match tokio_tungstenite::connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                backoff_secs = 5;
                if let Err(e) = handle_session(ws_stream, &cfg).await {
                    eprintln!("[it_relay] Session ended: {e}");
                }
            }
            Err(e) => {
                eprintln!("[it_relay] Connect failed: {e}. Reconnecting in {backoff_secs}s...");
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        }
    }
}

async fn handle_session<S>(ws_stream: S, cfg: &AppConfig) -> Result<(), String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin
        + Send
        + 'static,
{
    let (ws_sink, mut ws_stream) = ws_stream.split();
    let ws_sink = Arc::new(Mutex::new(ws_sink));

    // Shared state for interactive shell session
    let active_shell_stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>> = Arc::new(Mutex::new(None));
    let active_shell_child: Arc<Mutex<Option<tokio::process::Child>>> = Arc::new(Mutex::new(None));

    while let Some(msg_res) = ws_stream.next().await {
        let msg = match msg_res {
            Ok(m) => m,
            Err(e) => return Err(e.to_string()),
        };

        match msg {
            Message::Ping(payload) => {
                let mut sink = ws_sink.lock().await;
                let _ = sink.send(Message::Pong(payload)).await;
            }
            Message::Text(raw) => {
                let v: serde_json::Value = match serde_json::from_str(&raw) {
                    Ok(parsed) => parsed,
                    Err(_) => continue,
                };

                let target = v["target"].as_str().unwrap_or("");
                if !target.is_empty() && target != cfg.device_id {
                    // Not intended for this device
                    continue;
                }

                let msg_type = v["type"].as_str().unwrap_or("");
                let req_id = v["reqId"].as_str().unwrap_or("").to_string();

                match msg_type {
                    "diag" => {
                        let res = handle_diag(cfg, &req_id);
                        let mut sink = ws_sink.lock().await;
                        let _ = sink.send(Message::Text(res.to_string())).await;
                    }
                    "exec" => {
                        let cmd_str = v["command"].as_str().unwrap_or("").to_string();
                        let sink_clone = ws_sink.clone();
                        tokio::spawn(async move {
                            execute_command(cmd_str, req_id, sink_clone).await;
                        });
                    }
                    "push" => {
                        let dest_path = v["destPath"].as_str().unwrap_or("").to_string();
                        let content = v["content"].as_str().unwrap_or("").to_string();
                        let res = handle_push(&dest_path, &content, &req_id);
                        let mut sink = ws_sink.lock().await;
                        let _ = sink.send(Message::Text(res.to_string())).await;
                    }
                    "pull" => {
                        let src_path = v["srcPath"].as_str().unwrap_or("").to_string();
                        let res = handle_pull(&src_path, &req_id);
                        let mut sink = ws_sink.lock().await;
                        let _ = sink.send(Message::Text(res.to_string())).await;
                    }
                    "shell_start" => {
                        start_shell(
                            active_shell_stdin.clone(),
                            active_shell_child.clone(),
                            ws_sink.clone(),
                        )
                        .await;
                    }
                    "shell_input" => {
                        let data = v["data"].as_str().unwrap_or("");
                        let mut stdin_guard = active_shell_stdin.lock().await;
                        if let Some(ref mut stdin) = *stdin_guard {
                            let _ = stdin.write_all(data.as_bytes()).await;
                        }
                    }
                    "shell_kill" => {
                        let mut child_guard = active_shell_child.lock().await;
                        if let Some(ref mut child) = *child_guard {
                            let _ = child.kill().await;
                        }
                        *child_guard = None;
                        let mut stdin_guard = active_shell_stdin.lock().await;
                        *stdin_guard = None;
                    }
                    _ => {}
                }
            }
            Message::Close(_) => return Ok(()),
            _ => {}
        }
    }

    Ok(())
}

fn handle_diag(cfg: &AppConfig, req_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "diag_res",
        "reqId": req_id,
        "deviceId": cfg.device_id,
        "employeeName": cfg.employee_name,
        "hostname": get_hostname(),
        "user": get_username(),
        "os": format!("{} ({})", std::env::consts::OS, std::env::consts::ARCH),
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "status": "ONLINE"
    })
}

fn get_hostname() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows-PC".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOSTNAME").unwrap_or_else(|_| "MacBook".to_string())
    }
}

fn get_username() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERNAME").unwrap_or_else(|_| "User".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("USER").unwrap_or_else(|_| "User".to_string())
    }
}

async fn execute_command<S>(cmd_str: String, req_id: String, ws_sink: Arc<Mutex<S>>)
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin + Send + 'static,
{
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("powershell.exe");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW (zero popups on employee screen)
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &cmd_str]);
    }

    #[cfg(not(target_os = "windows"))]
    let mut cmd = std::process::Command::new("/bin/zsh");
    #[cfg(not(target_os = "windows"))]
    cmd.args(["-c", &cmd_str]);

    let (code, stdout, stderr) = match cmd.output() {
        Ok(out) => (
            out.status.code().unwrap_or(0),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        ),
        Err(e) => (-1, String::new(), e.to_string()),
    };

    let mut sink = ws_sink.lock().await;

    if !stdout.is_empty() {
        let _ = sink
            .send(Message::Text(
                serde_json::json!({
                    "type": "exec_out",
                    "reqId": req_id,
                    "data": stdout
                })
                .to_string(),
            ))
            .await;
    }

    if !stderr.is_empty() {
        let _ = sink
            .send(Message::Text(
                serde_json::json!({
                    "type": "exec_err",
                    "reqId": req_id,
                    "data": stderr
                })
                .to_string(),
            ))
            .await;
    }

    let _ = sink
        .send(Message::Text(
            serde_json::json!({
                "type": "exec_done",
                "reqId": req_id,
                "code": code
            })
            .to_string(),
        ))
        .await;
}

fn handle_push(dest_path: &str, content_b64: &str, req_id: &str) -> serde_json::Value {
    match STANDARD.decode(content_b64) {
        Ok(bytes) => {
            let path = Path::new(dest_path);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::write(path, &bytes) {
                Ok(_) => serde_json::json!({
                    "type": "push_res",
                    "reqId": req_id,
                    "success": true,
                    "path": dest_path,
                    "size": bytes.len()
                }),
                Err(e) => serde_json::json!({
                    "type": "push_res",
                    "reqId": req_id,
                    "success": false,
                    "error": e.to_string()
                }),
            }
        }
        Err(e) => serde_json::json!({
            "type": "push_res",
            "reqId": req_id,
            "success": false,
            "error": format!("Invalid base64: {e}")
        }),
    }
}

fn handle_pull(src_path: &str, req_id: &str) -> serde_json::Value {
    let path = Path::new(src_path);
    if !path.exists() {
        return serde_json::json!({
            "type": "pull_res",
            "reqId": req_id,
            "success": false,
            "error": "File not found"
        });
    }

    match std::fs::read(path) {
        Ok(bytes) => serde_json::json!({
            "type": "pull_res",
            "reqId": req_id,
            "success": true,
            "path": src_path,
            "content": STANDARD.encode(&bytes)
        }),
        Err(e) => serde_json::json!({
            "type": "pull_res",
            "reqId": req_id,
            "success": false,
            "error": e.to_string()
        }),
    }
}

async fn start_shell<S>(
    stdin_holder: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    child_holder: Arc<Mutex<Option<tokio::process::Child>>>,
    ws_sink: Arc<Mutex<S>>,
) where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin + Send + 'static,
{
    // Terminate existing shell if open
    {
        let mut child_guard = child_holder.lock().await;
        if let Some(ref mut child) = *child_guard {
            let _ = child.kill().await;
        }
        *child_guard = None;
    }

    #[cfg(target_os = "windows")]
    let mut cmd = tokio::process::Command::new("powershell.exe");
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.args(["-NoLogo", "-NoProfile"]);
    }

    #[cfg(not(target_os = "windows"))]
    let mut cmd = tokio::process::Command::new("/bin/zsh");

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    match cmd.spawn() {
        Ok(mut child) => {
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let stdin = child.stdin.take();

            {
                let mut stdin_guard = stdin_holder.lock().await;
                *stdin_guard = stdin;
            }

            // Spawn stdout reader
            if let Some(mut out) = stdout {
                let sink_clone = ws_sink.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = out.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let mut sink = sink_clone.lock().await;
                        let _ = sink
                            .send(Message::Text(
                                serde_json::json!({
                                    "type": "shell_output",
                                    "data": text
                                })
                                .to_string(),
                            ))
                            .await;
                    }
                });
            }

            // Spawn stderr reader
            if let Some(mut err) = stderr {
                let sink_clone = ws_sink.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = err.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let mut sink = sink_clone.lock().await;
                        let _ = sink
                            .send(Message::Text(
                                serde_json::json!({
                                    "type": "shell_output",
                                    "data": text
                                })
                                .to_string(),
                            ))
                            .await;
                    }
                });
            }

            let sink_clone = ws_sink.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                let code = status.map(|s| s.code().unwrap_or(0)).unwrap_or(-1);
                let mut sink = sink_clone.lock().await;
                let _ = sink
                    .send(Message::Text(
                        serde_json::json!({
                            "type": "shell_closed",
                            "code": code
                        })
                        .to_string(),
                    ))
                    .await;
            });
        }
        Err(e) => {
            let mut sink = ws_sink.lock().await;
            let _ = sink
                .send(Message::Text(
                    serde_json::json!({
                        "type": "error",
                        "message": format!("Failed to spawn shell: {e}")
                    })
                    .to_string(),
                ))
                .await;
        }
    }
}
