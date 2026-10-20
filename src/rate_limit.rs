//! Per-client limits on creating pastes and on attachment bytes, as token
//! buckets kept in memory (they reset when the server restarts).
//!
//! Clients are told apart by IP address: Rocket's `client_ip()`, which reads
//! the X-Real-IP header the reverse proxy sets. IPv6 addresses are grouped by
//! /64, since one user usually has a whole /64.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A refilling allowance: `capacity` per `period`, refilled continuously.
#[derive(Clone, Copy)]
struct Rule {
    capacity: f64,
    per_sec: f64,
}

impl Rule {
    /// `None` when `amount` is 0, which turns the limit off.
    fn new(amount: u64, period: Duration) -> Option<Rule> {
        (amount > 0).then(|| Rule {
            capacity: amount as f64,
            per_sec: amount as f64 / period.as_secs_f64(),
        })
    }
}

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    updated: Instant,
}

impl Bucket {
    fn refill(&mut self, rule: &Rule, now: Instant) {
        let elapsed = now.saturating_duration_since(self.updated).as_secs_f64();
        self.tokens = (self.tokens + elapsed * rule.per_sec).min(rule.capacity);
        self.updated = now;
    }

    /// How long until the bucket holds `cost`.
    fn wait_for(&self, rule: &Rule, cost: f64) -> Duration {
        let missing = cost - self.tokens;
        if missing <= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(missing / rule.per_sec)
        }
    }
}

// Indexes into `RateLimiter::rules` and each client's buckets.
const PASTES_PER_MINUTE: usize = 0;
const PASTES_PER_HOUR: usize = 1;
const UPLOAD_BYTES_PER_HOUR: usize = 2;

pub struct RateLimiter {
    rules: [Option<Rule>; 3],
    clients: Mutex<HashMap<IpAddr, [Bucket; 3]>>,
}

impl RateLimiter {
    pub fn new(pastes_per_minute: u64, pastes_per_hour: u64, upload_bytes_per_hour: u64) -> Self {
        let minute = Duration::from_secs(60);
        let hour = Duration::from_secs(60 * 60);
        RateLimiter {
            rules: [
                Rule::new(pastes_per_minute, minute),
                Rule::new(pastes_per_hour, hour),
                Rule::new(upload_bytes_per_hour, hour),
            ],
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// Takes one paste and `upload_bytes` of attachment allowance from the
    /// client, or, if any limit would be exceeded, takes nothing and returns
    /// how long to wait.
    pub fn take(&self, ip: Option<IpAddr>, upload_bytes: u64) -> Result<(), Duration> {
        let mut costs = [0.0; 3];
        costs[PASTES_PER_MINUTE] = 1.0;
        costs[PASTES_PER_HOUR] = 1.0;
        costs[UPLOAD_BYTES_PER_HOUR] = upload_bytes as f64;

        let now = Instant::now();
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        let buckets = clients.entry(client_key(ip)).or_insert_with(|| self.full_buckets(now));

        let mut wait = Duration::ZERO;
        for (i, rule) in self.rules.iter().enumerate() {
            if let Some(rule) = rule {
                buckets[i].refill(rule, now);
                wait = wait.max(buckets[i].wait_for(rule, costs[i]));
            }
        }
        if wait > Duration::ZERO {
            return Err(wait);
        }

        for (i, rule) in self.rules.iter().enumerate() {
            if rule.is_some() {
                buckets[i].tokens -= costs[i];
            }
        }
        Ok(())
    }

    /// Forgets clients whose allowances have fully refilled, so the table
    /// only holds recently active ones.
    pub fn prune(&self) {
        let now = Instant::now();
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        clients.retain(|_, buckets| {
            self.rules.iter().enumerate().any(|(i, rule)| match rule {
                Some(rule) => {
                    buckets[i].refill(rule, now);
                    buckets[i].tokens < rule.capacity
                }
                None => false,
            })
        });
    }

    fn full_buckets(&self, now: Instant) -> [Bucket; 3] {
        self.rules.map(|rule| Bucket {
            tokens: rule.map_or(0.0, |rule| rule.capacity),
            updated: now,
        })
    }
}

fn client_key(ip: Option<IpAddr>) -> IpAddr {
    match ip {
        Some(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
        Some(v4) => v4,
        // Rocket always knows the peer address, but just in case.
        None => IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: Option<IpAddr> = Some(IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7)));
    const B: Option<IpAddr> = Some(IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 8)));

    #[test]
    fn limits_pastes_per_client() {
        let limiter = RateLimiter::new(3, 0, 0);
        for _ in 0..3 {
            assert!(limiter.take(A, 0).is_ok());
        }
        let wait = limiter.take(A, 0).unwrap_err();
        // One paste refills every 20 seconds.
        assert!(wait > Duration::from_secs(19) && wait <= Duration::from_secs(20));
        assert!(limiter.take(B, 0).is_ok(), "other clients aren't affected");
    }

    #[test]
    fn refused_requests_take_nothing() {
        let limiter = RateLimiter::new(10, 0, 100);
        assert!(limiter.take(A, 80).is_ok());
        assert!(limiter.take(A, 30).is_err());
        assert!(limiter.take(A, 20).is_ok(), "the refused 30 bytes weren't taken");
    }

    #[test]
    fn groups_ipv6_by_64() {
        let ip = |s: &str| Some(s.parse::<IpAddr>().unwrap());
        let limiter = RateLimiter::new(1, 0, 0);
        assert!(limiter.take(ip("2001:db8:1:2::1"), 0).is_ok());
        assert!(limiter.take(ip("2001:db8:1:2:ffff::9"), 0).is_err(), "same /64");
        assert!(limiter.take(ip("2001:db8:1:3::1"), 0).is_ok(), "different /64");
        assert_eq!(client_key(ip("::ffff:203.0.113.7")), A.unwrap());
    }

    #[test]
    fn zero_turns_a_limit_off() {
        let limiter = RateLimiter::new(0, 0, 0);
        for _ in 0..1000 {
            assert!(limiter.take(A, u64::MAX).is_ok());
        }
    }

    #[test]
    fn prune_forgets_idle_clients() {
        let limiter = RateLimiter::new(5, 0, 0);
        limiter.take(A, 0).unwrap();
        limiter.prune();
        assert_eq!(limiter.clients.lock().unwrap().len(), 1, "still refilling");
        limiter.clients.lock().unwrap().get_mut(&A.unwrap()).unwrap()[0].updated -=
            Duration::from_secs(60);
        limiter.prune();
        assert!(limiter.clients.lock().unwrap().is_empty());
    }
}
