// Cross-platform single-instance enforcement via local loopback port
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const SINGLE_INSTANCE_PORT: u16 = 45123;

pub enum InstanceRole {
    Primary(TcpListener),
    Secondary,
}

pub fn check_single_instance() -> InstanceRole {
    let addr = format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT);
    match TcpListener::bind(&addr) {
        Ok(listener) => {
            InstanceRole::Primary(listener)
        }
        Err(_) => {
            // Port already bound: another instance is running!
            // Connect to primary instance and tell it to show and focus its window.
            if let Ok(addr_sock) = addr.parse() {
                if let Ok(mut stream) = TcpStream::connect_timeout(&addr_sock, Duration::from_millis(800)) {
                    let _ = stream.write_all(b"SHOW\n");
                    let _ = stream.flush();
                }
            }
            InstanceRole::Secondary
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
