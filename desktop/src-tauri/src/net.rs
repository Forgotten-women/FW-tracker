// Shared HTTP client with a DNS fallback.
//
// A laptop whose DNS (Windows' cache, the office router or the ISP) still held
// a stale "no such host" for api.fwtracker.tech after the move to our own
// server could not record anything: breaks failed with "dns error: No such
// host is known (os error 11001)". The resolver below asks the system first
// and only if that fails resolves the name over DNS-over-HTTPS, reaching
// Cloudflare (1.1.1.1) and Google (8.8.8.8) by IP address, so no DNS is needed
// to do it. TLS is unaffected: the request still goes to the real hostname and
// its certificate is verified as usual; only the address lookup changes.
//
// One shared client also means one pooled connection instead of a new TLS
// handshake on every call.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hyper::client::connect::dns::Name;
use reqwest::dns::{Addrs, Resolve, Resolving};

/// How long a DNS-over-HTTPS answer is reused before asking again.
const DOH_CACHE_FOR: Duration = Duration::from_secs(300);

struct FallbackResolver {
    cache: Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>,
}

impl Resolve for FallbackResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let cached = self
            .cache
            .lock()
            .ok()
            .and_then(|c| c.get(&host).filter(|(_, at)| at.elapsed() < DOH_CACHE_FOR).map(|(ips, _)| ips.clone()));
        let cache = resolver_cache();

        Box::pin(async move {
            // 1. The system resolver, as before.
            let lookup_host = host.clone();
            let system = tokio::task::spawn_blocking(move || {
                (lookup_host.as_str(), 0u16).to_socket_addrs().map(|addrs| addrs.collect::<Vec<SocketAddr>>())
            })
            .await;
            if let Ok(Ok(addrs)) = system {
                if !addrs.is_empty() {
                    return Ok(Box::new(addrs.into_iter()) as Addrs);
                }
            }

            // 2. DNS over HTTPS (cached briefly).
            let ips = match cached {
                Some(ips) => ips,
                None => {
                    let ips = doh_lookup(&host).await?;
                    if let Some(c) = cache {
                        if let Ok(mut c) = c.lock() {
                            c.insert(host.clone(), (ips.clone(), Instant::now()));
                        }
                    }
                    eprintln!("[net] system DNS could not resolve {host}; using DNS-over-HTTPS -> {ips:?}");
                    ips
                }
            };
            Ok(Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0))) as Addrs)
        })
    }
}

fn resolver() -> &'static Arc<FallbackResolver> {
    static R: OnceLock<Arc<FallbackResolver>> = OnceLock::new();
    R.get_or_init(|| Arc::new(FallbackResolver { cache: Mutex::new(HashMap::new()) }))
}

fn resolver_cache() -> Option<&'static Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>> {
    Some(&resolver().cache)
}

/// A/AAAA records for `host` from Cloudflare, then Google, over HTTPS by IP.
async fn doh_lookup(host: &str) -> Result<Vec<IpAddr>, Box<dyn std::error::Error + Send + Sync>> {
    // Plain client: these URLs are IP literals, so they never need resolving.
    let client = reqwest::Client::builder().timeout(Duration::from_secs(6)).build()?;
    let endpoints = ["https://1.1.1.1/dns-query", "https://8.8.8.8/resolve"];
    let mut last_err = String::from("no answer");
    for endpoint in endpoints {
        let mut ips = Vec::new();
        for rtype in ["A", "AAAA"] {
            let res = client
                .get(endpoint)
                .query(&[("name", host), ("type", rtype)])
                .header("accept", "application/dns-json")
                .send()
                .await;
            let body: serde_json::Value = match res {
                Ok(r) if r.status().is_success() => match r.json().await {
                    Ok(v) => v,
                    Err(e) => { last_err = e.to_string(); continue; }
                },
                Ok(r) => { last_err = format!("HTTP {}", r.status()); continue; }
                Err(e) => { last_err = e.to_string(); continue; }
            };
            for answer in body.get("Answer").and_then(|a| a.as_array()).into_iter().flatten() {
                // type 1 = A, 28 = AAAA; CNAMEs (5) are followed by the DoH server.
                let t = answer.get("type").and_then(|t| t.as_u64()).unwrap_or(0);
                if t == 1 || t == 28 {
                    if let Some(ip) = answer.get("data").and_then(|d| d.as_str()).and_then(|d| d.parse::<IpAddr>().ok()) {
                        ips.push(ip);
                    }
                }
            }
        }
        if !ips.is_empty() {
            // IPv4 first: some office networks have no working IPv6 route.
            ips.sort_by_key(|ip| ip.is_ipv6());
            return Ok(ips);
        }
    }
    Err(format!("could not resolve {host} (system DNS and DNS-over-HTTPS failed: {last_err})").into())
}

/// The shared client for every backend request (cheap to clone).
pub fn http() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .dns_resolver(resolver().clone())
                .connect_timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

/// The same, with an overall request timeout (for the live-view calls).
pub fn http_with_timeout(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .dns_resolver(resolver().clone())
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// A message for the widget instead of reqwest's raw error text.
pub fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "The server took too long to respond. Please try again.".to_string()
    } else if e.is_connect() {
        "Can't reach the server right now. Check the internet connection and try again.".to_string()
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Network tests: cargo test net:: -- --ignored
    #[tokio::test]
    #[ignore]
    async fn doh_resolves_the_backend() {
        let ips = doh_lookup("api.fwtracker.tech").await.expect("DoH lookup");
        assert!(ips.contains(&"72.60.236.105".parse::<IpAddr>().unwrap()), "{ips:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn shared_client_reaches_the_backend() {
        let r = http().get("https://api.fwtracker.tech/api/health").send().await.expect("request");
        assert!(r.status().is_success());
    }
}
