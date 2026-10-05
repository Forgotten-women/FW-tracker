// Cross-platform single-instance enforcement via local loopback port
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const SINGLE_INSTANCE_PORT: u16 = 45123;

/// How long a new copy waits for the port before deciding another copy really
/// is running. A restart after an update starts the new copy while the old one
/// is still exiting and holding the port; giving up at once made the new copy
/// quit, then the old one exited, leaving nothing running (2026-10-05: several
/// laptops stopped reporting right after taking 1.0.55).
const TAKEOVER_WAIT: Duration = Duration::from_secs(8);

pub enum InstanceRole {
    Primary(TcpListener),
    Secondary,
}

pub fn check_single_instance() -> InstanceRole {
    let addr = format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT);
    let deadline = Instant::now() + TAKEOVER_WAIT;
    let mut asked_to_show = false;
    loop {
        match TcpListener::bind(&addr) {
            Ok(listener) => return InstanceRole::Primary(listener),
            Err(_) => {
                // Another copy holds the port. Ask it to show its window once,
                // straight away, so a double-click still opens WorkSync promptly.
                if !asked_to_show {
                    asked_to_show = true;
                    if let Ok(addr_sock) = addr.parse() {
                        if let Ok(mut stream) = TcpStream::connect_timeout(&addr_sock, Duration::from_millis(800)) {
                            let _ = stream.write_all(b"SHOW\n");
                            let _ = stream.flush();
                        }
                    }
                }
                if Instant::now() >= deadline {
                    return InstanceRole::Secondary;
                }
                // It may only be on its way out (a restart): try again shortly.
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

pub fn start_listener(listener: TcpListener, app_handle: AppHandle) {
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let mut buf = [0u8; 16];
                if let Ok(n) = stream.read(&mut buf) {
                    if n > 0 {
                        let msg = String::from_utf8_lossy(&buf[..n]);
                        if msg.contains("SHOW") {
                            if let Some(window) = app_handle.get_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                }
            }
        }
    });
}
