//! Namaz (prayer) times worked out on the laptop itself, from the device clock
//! and the office location - no server needed, so the reminder arrives on the
//! exact minute even offline.
//!
//! Same method as the backend (backend/src/domain/namaz.js, which uses it to
//! count the 15 minutes after each prayer as working): the standard
//! astronomical calculation (PrayTimes.org), University of Islamic Sciences,
//! Karachi parameters, Hanafi Asr, for the Islamabad office (agreed with HR on
//! 2026-10-28; remote staff use the office's times). Pakistan Standard Time is
//! UTC+5 all year (no daylight saving).

use chrono::{Datelike, Duration, TimeZone, Timelike, Utc, Weekday};

const LATITUDE: f64 = 33.6844; // Islamabad
const LONGITUDE: f64 = 73.0479;
const ASR_FACTOR: f64 = 2.0; // Hanafi
const OFFICE_UTC_OFFSET_HOURS: i64 = 5; // Asia/Karachi
/// Minutes after each prayer that count as working (server side).
pub const WINDOW_MINUTES: u64 = 15;

#[derive(Debug, Clone, PartialEq)]
pub struct Prayer {
    pub name: &'static str,
    /// Unix ms of the prayer time.
    pub at_ms: u64,
    /// Office time, e.g. "3:41 PM".
    pub label: String,
}

fn rad(d: f64) -> f64 { d.to_radians() }
fn sin(d: f64) -> f64 { rad(d).sin() }
fn cos(d: f64) -> f64 { rad(d).cos() }
fn tan(d: f64) -> f64 { rad(d).tan() }
fn arcsin(x: f64) -> f64 { x.asin().to_degrees() }
fn arccos(x: f64) -> f64 { x.clamp(-1.0, 1.0).acos().to_degrees() }
fn arctan2(y: f64, x: f64) -> f64 { y.atan2(x).to_degrees() }
fn arccot(x: f64) -> f64 { (1.0 / x).atan().to_degrees() }
fn fix(a: f64, b: f64) -> f64 { let r = a - b * (a / b).floor(); if r < 0.0 { r + b } else { r } }
fn fix_angle(a: f64) -> f64 { fix(a, 360.0) }
fn fix_hour(a: f64) -> f64 { fix(a, 24.0) }

fn julian(mut year: i32, mut month: u32, day: u32) -> f64 {
    if month <= 2 { year -= 1; month += 12; }
    let a = (year as f64 / 100.0).floor();
    let b = 2.0 - a + (a / 4.0).floor();
    (365.25 * (year as f64 + 4716.0)).floor() + (30.6001 * (month as f64 + 1.0)).floor() + day as f64 + b - 1524.5
}

/// (declination, equation of time)
fn sun_position(jd: f64) -> (f64, f64) {
    let d = jd - 2451545.0;
    let g = fix_angle(357.529 + 0.98560028 * d);
    let q = fix_angle(280.459 + 0.98564736 * d);
    let l = fix_angle(q + 1.915 * sin(g) + 0.020 * sin(2.0 * g));
    let e = 23.439 - 0.00000036 * d;
    let ra = arctan2(cos(e) * sin(l), cos(l)) / 15.0;
    (arcsin(sin(e) * sin(l)), q / 15.0 - fix_hour(ra))
}

/// UTC clock hours of (dhuhr, asr, maghrib) on a calendar date.
fn utc_hours(year: i32, month: u32, day: u32) -> (f64, f64, f64) {
    let jdate = julian(year, month, day) - LONGITUDE / (15.0 * 24.0);
    let mid_day = |t: f64| fix_hour(12.0 - sun_position(jdate + t).1);
    let sun_angle_time = |angle: f64, t: f64| {
        let decl = sun_position(jdate + t).0;
        let h = arccos((-sin(angle) - sin(decl) * sin(LATITUDE)) / (cos(decl) * cos(LATITUDE))) / 15.0;
        mid_day(t) + h
    };
    let asr = |t: f64| {
        let decl = sun_position(jdate + t).0;
        sun_angle_time(-arccot(ASR_FACTOR + tan((LATITUDE - decl).abs())), t)
    };
    let to_utc = |h: f64| h - LONGITUDE / 15.0;
    (to_utc(mid_day(12.0 / 24.0)), to_utc(asr(13.0 / 24.0)), to_utc(sun_angle_time(0.833, 18.0 / 24.0)))
}

/// Today's prayers inside the working day, by the office calendar date of
/// `now_ms`: Zuhr, Asr, Maghrib; on Friday Jumu'ah at 13:00 instead of Zuhr.
pub fn today(now_ms: u64) -> Vec<Prayer> {
    let offset = Duration::hours(OFFICE_UTC_OFFSET_HOURS);
    let office_now = Utc.timestamp_millis_opt(now_ms as i64).single().unwrap_or_else(Utc::now) + offset;
    let (y, m, d) = (office_now.year(), office_now.month(), office_now.day());
    let midnight_utc = Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).single().map(|t| t.timestamp_millis()).unwrap_or(0);
    let at = |utc_h: f64| -> u64 {
        // Rounded to the minute, like the server.
        let mins = (fix_hour(utc_h) * 60.0).round() as i64;
        (midnight_utc + mins * 60_000) as u64
    };
    let label = |ms: u64| -> String {
        let t = Utc.timestamp_millis_opt(ms as i64).single().unwrap_or_else(Utc::now) + offset;
        t.format("%-I:%M %p").to_string()
    };
    let (dhuhr, asr, maghrib) = utc_hours(y, m, d);
    let first = if office_now.weekday() == Weekday::Fri {
        ("Jumu'ah", (midnight_utc + (13 - OFFICE_UTC_OFFSET_HOURS) * 3_600_000) as u64)
    } else {
        ("Zuhr", at(dhuhr))
    };
    vec![first, ("Asr", at(asr)), ("Maghrib", at(maghrib))]
        .into_iter()
        .map(|(name, at_ms)| Prayer { name, at_ms, label: label(at_ms) })
        .collect()
}

/// Office clock minutes since midnight for `ms` (to compare with shift times).
pub fn office_minutes(ms: u64) -> i64 {
    let t = Utc.timestamp_millis_opt(ms as i64).single().unwrap_or_else(Utc::now) + Duration::hours(OFFICE_UTC_OFFSET_HOURS);
    (t.hour() * 60 + t.minute()) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_office(y: i32, m: u32, d: u32, h: u32, min: u32) -> u64 {
        (Utc.with_ymd_and_hms(y, m, d, h, min, 0).single().unwrap().timestamp_millis() - 5 * 3_600_000) as u64
    }

    #[test]
    fn matches_the_server_for_islamabad() {
        // backend/src/domain/namaz.js for 2026-10-28: Zuhr 11:52, Asr 15:41, Maghrib 17:20.
        let p = today(at_office(2026, 10, 28, 9, 0));
        assert_eq!(p.iter().map(|x| x.name).collect::<Vec<_>>(), vec!["Zuhr", "Asr", "Maghrib"]);
        assert_eq!(p[0].at_ms, at_office(2026, 10, 28, 11, 52));
        assert_eq!(p[1].at_ms, at_office(2026, 10, 28, 15, 41));
        assert_eq!(p[2].at_ms, at_office(2026, 10, 28, 17, 20));
        assert_eq!(p[1].label, "3:41 PM");
    }

    #[test]
    fn friday_is_jumuah_at_one() {
        let p = today(at_office(2026, 10, 30, 9, 0));
        assert_eq!(p[0].name, "Jumu'ah");
        assert_eq!(p[0].at_ms, at_office(2026, 10, 30, 13, 0));
    }

    #[test]
    fn times_move_daily() {
        assert_ne!(today(at_office(2026, 6, 21, 9, 0))[2].at_ms - at_office(2026, 6, 21, 0, 0),
                   today(at_office(2026, 12, 21, 9, 0))[2].at_ms - at_office(2026, 12, 21, 0, 0));
    }
}
