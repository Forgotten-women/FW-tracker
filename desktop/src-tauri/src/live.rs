// Live screen view, agent side: the instant-start doorbell and the stream.
//
// Before: a loop asked /api/desktop/stream-status every 20s, 24/7, on every
// workstation, just to find out whether HR had opened the viewer -- ~82K
// requests a day against the backend, and still up to 20s (plus PowerShell
// start-up) before a stream began. HR's viewer gave up after ~10s, so most
// attempts failed before the laptop had even noticed.
//
// Now:
//   * run_doorbell holds one WebSocket to Supabase Realtime (the backend runs
//     on Vercel, which can't hold connections) on a per-device topic the
//     backend hands out in the heartbeat response. HR opening the viewer
//     "rings" it and the laptop reacts within a second. The ring carries
//     nothing and authorises nothing: it only prompts the normal
//     authenticated stream-status call, which decides.
//   * run_stream_worker waits for a ring. Only while the doorbell is down does
//     it fall back to polling -- and then only when a stream could be allowed
//     at all (inside working hours, not on a break).
//   * stream_session captures natively (capture.rs), skips unchanged screens,
//     and stops as soon as a frame reply says nobody is watching.

use crate::capture;
use crate::client::{self, AppConfig, HeartbeatResponse, RealtimeConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

const FALLBACK_POLL: Duration = Duration::from_secs(5);
const IDLE_WAKE: Duration = Duration::from_secs(6);
const MIN_CHECK_GAP: Duration = Duration::from_secs(2);
const FRAME_INTERVAL: Duration = Duration::from_millis(1000);
const KEEPALIVE_EVERY: Duration = Duration::from_secs(3);
// The backend keeps a frame for 8s; resend an unchanged screen well inside
// that so the viewer never loses the picture on a static screen.
const RESEND_UNCHANGED_EVERY: Duration = Duration::from_secs(6);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(25);
const HELLO_EVERY: Duration = Duration::from_secs(10 * 60);

struct Hub {
    ring: Notify,
    break_changed: Notify,
    config_changed: Notify,
    realtime: Mutex<Option<RealtimeConfig>>,
    doorbell_up: AtomicBool,
    outside_hours: AtomicBool,
    server_break: AtomicBool,
}

fn hub() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(|| Hub {
        ring: Notify::new(),
        break_changed: Notify::new(),
        config_changed: Notify::new(),
        realtime: Mutex::new(None),
        doorbell_up: AtomicBool::new(false),
        outside_hours: AtomicBool::new(false),
        server_break: AtomicBool::new(false),
    })
}

fn current_config(app: &AppHandle) -> AppConfig {
    app.state::<crate::AppState>().config.lock().unwrap().clone()
}

/// Feed every heartbeat response in: it carries the doorbell subscription,
/// and (from any backend version) whether a stream is already being asked for.
pub fn on_heartbeat(resp: &HeartbeatResponse) {
    let h = hub();
    h.outside_hours.store(resp.outside_working_hours.unwrap_or(false), Ordering::SeqCst);
    h.server_break.store(resp.today.on_break, Ordering::SeqCst);

    let next = resp.live_view.as_ref().and_then(|lv| lv.realtime.clone());
    let changed = {
        let mut cur = h.realtime.lock().unwrap();
        if *cur != next {
            *cur = next;
            true
        } else {
            false
        }
    };
    if changed {
        h.config_changed.notify_one();
    }

    if resp.live_stream_requested == Some(true) {
        h.ring.notify_one();
    }
}

// ---------------------------------------------------------------------------
// Doorbell
// ---------------------------------------------------------------------------

pub async fn run_doorbell(app: AppHandle) {
    let mut backoff_secs = 1u64;
    let mut last_hello: Option<Instant> = None;

    loop {
        let cfg = current_config(&app);
        let rt = hub().realtime.lock().unwrap().clone();
        let rt = match rt {
            Some(rt) if !cfg.token.is_empty() => rt,
            _ => {
                hub().doorbell_up.store(false, Ordering::SeqCst);
                // Not configured (yet): wait for a heartbeat to bring a config.
                let _ = tokio::time::timeout(Duration::from_secs(30), hub().config_changed.notified()).await;
                continue;
            }
        };

        let started = Instant::now();
        let result = listen(&rt, &cfg, &mut last_hello).await;
        hub().doorbell_up.store(false, Ordering::SeqCst);

        match result {
            // The config changed underneath us: reconnect with the new one now.
            Ok(()) => {
                backoff_secs = 1;
                continue;
            }
            Err(e) => eprintln!("[live] doorbell connection ended: {e}"),
        }
        if started.elapsed() > Duration::from_secs(60) {
            backoff_secs = 1;
        }
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(60);
    }
}

fn websocket_url(rt: &RealtimeConfig) -> Result<String, String> {
    let base = rt.url.trim_end_matches('/');
    let host = base
        .strip_prefix("https://")
        .ok_or_else(|| "realtime url must be https".to_string())?;
    if !rt.api_key.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) || rt.api_key.is_empty() {
        return Err("unexpected realtime key format".to_string());
    }
    Ok(format!("wss://{host}/realtime/v1/websocket?apikey={}&vsn=1.0.0", rt.api_key))
}

/// One connection's lifetime. Ok(()) = config changed (reconnect now);
/// Err = the connection failed or dropped (reconnect with backoff).
async fn listen(rt: &RealtimeConfig, cfg: &AppConfig, last_hello: &mut Option<Instant>) -> Result<(), String> {
    let url = websocket_url(rt)?;
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(url.as_str()))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| e.to_string())?;

    let topic = format!("realtime:{}", rt.topic);
    let event = if rt.event.is_empty() { "live" } else { rt.event.as_str() };
    let join = serde_json::json!({
        "topic": topic,
        "event": "phx_join",
        "payload": {
            "config": {
                "broadcast": { "self": false, "ack": false },
                "presence": { "key": "" },
                "private": false
            }
        },
        "ref": "1",
        "join_ref": "1"
    });
    ws.send(Message::Text(join.to_string())).await.map_err(|e| e.to_string())?;

    let mut heartbeat = tokio::time::interval(HEARTBEAT_EVERY);
    heartbeat.tick().await; // the first tick fires immediately
    let mut next_ref: u64 = 2;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = serde_json::json!({
                    "topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": next_ref.to_string()
                });
                next_ref += 1;
                ws.send(Message::Text(hb.to_string())).await.map_err(|e| e.to_string())?;
            }
            _ = hub().config_changed.notified() => {
                let _ = ws.close(None).await;
                return Ok(());
            }
            msg = ws.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => return Err(e.to_string()),
                    None => return Err("connection closed".to_string()),
                };
                match msg {
                    Message::Text(text) => {
                        let v: serde_json::Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let ev = v["event"].as_str().unwrap_or("");
                        let v_topic = v["topic"].as_str().unwrap_or("");
                        let on_topic = v_topic == topic || v_topic == rt.topic || v_topic.ends_with(&rt.topic);
                        if ev == "phx_reply" && on_topic && v["ref"].as_str() == Some("1") {
                            if v["payload"]["status"].as_str() != Some("ok") {
                                return Err(format!("join refused: {}", v["payload"]));
                            }
                            hub().doorbell_up.store(true, Ordering::SeqCst);
                            // A request made while we were disconnected may already be waiting.
                            hub().ring.notify_one();
                            if last_hello.map(|t| t.elapsed() > HELLO_EVERY).unwrap_or(true) {
                                *last_hello = Some(Instant::now());
                                let cfg = cfg.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = client::send_live_hello(&cfg, true, "native").await;
                                });
                            }
                        } else if ev == "broadcast" && on_topic {
                            match v["payload"]["event"].as_str() {
                                Some(e) if e == event => hub().ring.notify_one(),
                                // The break changed on another device (the phone).
                                Some("sync") => hub().break_changed.notify_one(),
                                _ => {}
                            }
                        } else if (ev == "phx_error" || ev == "phx_close") && on_topic {
                            return Err(format!("channel {ev}"));
                        }
                    }
                    Message::Ping(p) => {
                        ws.send(Message::Pong(p)).await.map_err(|e| e.to_string())?;
                    }
                    Message::Close(_) => return Err("server closed the connection".to_string()),
                    _ => {}
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Break sync
// ---------------------------------------------------------------------------

/// When the phone starts or ends a break, the backend rings the doorbell with
/// "sync"; re-read the break state (read-only, books no time) and show it now
/// instead of on the next minutely heartbeat.
pub async fn run_break_sync(app: AppHandle) {
    loop {
        hub().break_changed.notified().await;
        // Coalesce a start+end in quick succession into one read.
        tokio::time::sleep(Duration::from_millis(400)).await;

        let cfg = current_config(&app);
        let state = match client::fetch_break_state(&cfg).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[live] break sync failed: {e}");
                continue;
            }
        };

        crate::IS_MANUAL_BREAK.store(state.on_break, Ordering::SeqCst);
        hub().server_break.store(state.on_break, Ordering::SeqCst);

        let app_state = app.state::<crate::AppState>();
        let updated = {
            let mut guard = app_state.latest_response.lock().unwrap();
            if let Some(ref mut r) = *guard {
                r.today.on_break = state.on_break;
                r.today.break_already_taken = state.break_already_taken;
                r.today.break_started_at = state.break_started_at;
                if state.break_permitted_minutes.is_some() {
                    r.today.break_permitted_minutes = state.break_permitted_minutes;
                }
                r.today.break_remaining_seconds = state.break_remaining_seconds;
                r.workstation_status = if state.on_break { "ON_BREAK".to_string() } else { "ACTIVE".to_string() };
                Some(r.clone())
            } else {
                None
            }
        };
        if let Some(resp) = updated {
            let _ = app.emit_all("heartbeat-updated", resp);
        }
    }
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

pub async fn run_stream_worker(app: AppHandle) {
    let mut last_check = Instant::now() - MIN_CHECK_GAP;

    loop {
        let wait = if hub().doorbell_up.load(Ordering::SeqCst) { IDLE_WAKE } else { FALLBACK_POLL };
        let _ = tokio::time::timeout(wait, hub().ring.notified()).await;

        let cfg = current_config(&app);
        if cfg.token.is_empty() {
            continue;
        }
        
        let h = hub();
        if h.outside_hours.load(Ordering::SeqCst)
            || h.server_break.load(Ordering::SeqCst)
            || crate::IS_MANUAL_BREAK.load(Ordering::SeqCst)
        {
            continue;
        }

        // A burst of rings (or status checks) costs at most one status check every few seconds.
        let since = last_check.elapsed();
        if since < MIN_CHECK_GAP {
            tokio::time::sleep(MIN_CHECK_GAP - since).await;
        }
        last_check = Instant::now();

        if let Ok(s) = client::check_stream_status(&cfg).await {
            if s.live_stream_requested && s.is_permitted && !s.on_break && !s.outside_working_hours {
                stream_session(&app).await;
            }
        }
    }
}

async fn capture_frame(native_failures: &mut u32) -> Option<(String, Option<u64>)> {
    if *native_failures < 3 {
        match tokio::task::spawn_blocking(capture::capture_live_frame).await {
            Ok(Ok(f)) => {
                *native_failures = 0;
                return Some((f.jpeg_base64, Some(f.fingerprint)));
            }
            Ok(Err(e)) => {
                eprintln!("[live] native capture failed: {e}");
                *native_failures += 1;
            }
            Err(e) => {
                eprintln!("[live] capture task failed: {e}");
                *native_failures += 1;
            }
        }
    }
    // Fall back immediately to screen capture so no frames or ticks are dropped.
    tokio::task::spawn_blocking(crate::capture_screen_frame)
        .await
        .ok()
        .flatten()
        .map(|f| (f, None))
}

async fn stream_session(app: &AppHandle) {
    let mut last_fingerprint: Option<u64> = None;
    let mut last_frame_sent: Option<Instant> = None;
    let mut last_any_sent = Instant::now() - KEEPALIVE_EVERY;
    let mut legacy_check = Instant::now();
    let mut send_failures = 0u32;
    let mut native_failures = 0u32;

    loop {
        let tick = Instant::now();
        if crate::IS_MANUAL_BREAK.load(Ordering::SeqCst) {
            break;
        }
        let cfg = current_config(app);
        if cfg.token.is_empty() {
            break;
        }

        let frame = capture_frame(&mut native_failures).await;
        let unchanged = matches!(
            (&frame, last_fingerprint),
            (Some((_, Some(fp))), Some(prev)) if *fp == prev
        );
        let resend_due = last_frame_sent.map(|t| t.elapsed() >= RESEND_UNCHANGED_EVERY).unwrap_or(true);

        let reply = match frame {
            Some((b64, fp)) if !unchanged || resend_due => {
                let r = client::send_stream_frame(&cfg, Some(&b64)).await;
                if r.is_ok() {
                    last_fingerprint = fp;
                    last_frame_sent = Some(Instant::now());
                    last_any_sent = Instant::now();
                }
                Some(r)
            }
            // Unchanged screen: a tiny "still here" instead of the same JPEG.
            Some(_) if last_any_sent.elapsed() >= KEEPALIVE_EVERY => {
                let r = client::send_stream_frame(&cfg, None).await;
                if r.is_ok() {
                    last_any_sent = Instant::now();
                }
                Some(r)
            }
            _ => None,
        };

        match reply {
            Some(Ok(r)) => {
                send_failures = 0;
                if r.status == "PAUSED" || r.keep_going == Some(false) {
                    break;
                }
                // An older backend doesn't say whether to go on; ask it the old way.
                if r.keep_going.is_none() && legacy_check.elapsed() >= Duration::from_secs(5) {
                    legacy_check = Instant::now();
                    match client::check_stream_status(&cfg).await {
                        Ok(s) if s.live_stream_requested && s.is_permitted => {}
                        _ => break,
                    }
                }
            }
            Some(Err(e)) => {
                send_failures += 1;
                eprintln!("[live] frame upload failed ({send_failures}): {e}");
                if send_failures >= 5 {
                    break;
                }
            }
            None => {}
        }

        let spent = tick.elapsed();
        if spent < FRAME_INTERVAL {
            tokio::time::sleep(FRAME_INTERVAL - spent).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(url: &str, key: &str) -> RealtimeConfig {
        RealtimeConfig { url: url.into(), api_key: key.into(), topic: "t".into(), event: "live".into() }
    }

    #[test]
    fn websocket_url_is_wss_on_the_same_host() {
        let url = websocket_url(&rt("https://abc.supabase.co/", "eyJhbGci.OiJ-IUz_I1")).unwrap();
        assert_eq!(url, "wss://abc.supabase.co/realtime/v1/websocket?apikey=eyJhbGci.OiJ-IUz_I1&vsn=1.0.0");
    }

    #[test]
    fn websocket_url_refuses_plain_http_and_odd_keys() {
        assert!(websocket_url(&rt("http://abc.supabase.co", "k")).is_err());
        assert!(websocket_url(&rt("https://abc.supabase.co", "a&b=c")).is_err());
        assert!(websocket_url(&rt("https://abc.supabase.co", "")).is_err());
    }
}
