//! CubbyDB license, sold through Polar (polar.sh).
//!
//! A new install gets a 7-day trial, counted from its first launch; after
//! that the app is locked until a license key is entered. The trial start is
//! kept in two places (the data dir and the cache dir) and the earliest wins,
//! so deleting one file doesn't restart it. Entering a key activates it with
//! Polar, which
//! registers this computer as one of the key's limited activations (set on
//! the Polar benefit), and the result is saved to `license.json`; after that
//! the app only needs the network for a weekly background re-check
//! (`refresh`), which drops a key Polar no longer recognizes (revoked,
//! refunded, or a hand-written `license.json`) and is skipped silently when
//! Polar can't be reached. Removing the license
//! deactivates it, freeing that slot for another computer. Polar's
//! customer-portal license endpoints are public by design (no API secret
//! ships in the app), so they're keyed only by the organization id below.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "license.json";
const TRIAL_FILE_NAME: &str = "trial.json";
/// The trial start's second copy, in the cache dir under a less obvious name.
const TRIAL_MIRROR_FILE_NAME: &str = ".install";
const REVALIDATE_DAYS: u64 = 7;

const TRIAL_DAYS: u64 = 7;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Polar organization that sells CubbyDB.
const POLAR_ORGANIZATION_ID: &str = "25d16d8c-eb29-49b3-8a3c-d9147add9dd3";

const POLAR_VALIDATE_URL: &str = "https://api.polar.sh/v1/customer-portal/license-keys/validate";
const POLAR_ACTIVATE_URL: &str = "https://api.polar.sh/v1/customer-portal/license-keys/activate";
const POLAR_DEACTIVATE_URL: &str =
    "https://api.polar.sh/v1/customer-portal/license-keys/deactivate";

/// Where "Buy CubbyDB" sends the user: the site's pricing page, which links
/// on to the Polar checkout.
pub const PURCHASE_URL: &str = "https://cubbydb.com/pricing";

/// What's saved after a key validates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLicense {
    key: String,
    /// This computer's activation, needed to deactivate it on removal.
    activation_id: String,
    /// Polar's masked form of the key, safe to show in the UI.
    display_key: String,
    email: Option<String>,
    /// Epoch milliseconds when Polar confirmed the key.
    activated_at: u64,
    /// Epoch milliseconds of the last successful re-check with Polar.
    /// Missing (0) means one is due right away.
    #[serde(default)]
    last_validated_at: u64,
}

/// What the frontend sees — never the full key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub licensed: bool,
    pub display_key: Option<String>,
    pub email: Option<String>,
    /// Whole days of trial remaining, rounded up; 0 means the trial is over
    /// and an unlicensed app is locked. Meaningless once licensed.
    pub trial_days_left: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trial {
    /// Epoch milliseconds of the first launch that checked the license.
    started_at: u64,
}

#[derive(Deserialize)]
struct Activation {
    id: String,
    license_key: ActivatedKey,
}

#[derive(Deserialize)]
struct ActivatedKey {
    display_key: String,
    customer: Option<Customer>,
}

#[derive(Deserialize)]
struct ValidatedKey {
    status: String,
}

#[derive(Deserialize)]
struct PolarError {
    detail: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Customer {
    email: Option<String>,
}

pub struct LicenseStore {
    path: PathBuf,
    trial_path: PathBuf,
    trial_mirror_path: PathBuf,
}

impl LicenseStore {
    pub fn new(data_dir: &Path, cache_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
            trial_path: data_dir.join(TRIAL_FILE_NAME),
            trial_mirror_path: cache_dir.join(TRIAL_MIRROR_FILE_NAME),
        }
    }

    pub fn status(&self) -> Result<LicenseStatus, DbError> {
        Ok(match self.read()? {
            Some(l) => LicenseStatus {
                licensed: true,
                display_key: Some(l.display_key),
                email: l.email,
                trial_days_left: 0,
            },
            None => LicenseStatus {
                licensed: false,
                display_key: None,
                email: None,
                trial_days_left: trial_days_left(self.trial_started_at(), now_millis()),
            },
        })
    }

    /// When this install's trial began: the earliest of its two copies, or
    /// now if neither exists. Both copies are rewritten whenever they
    /// disagree, so a deleted one is restored from the other. Best-effort
    /// writes — a read-only disk just means the trial restarts next launch.
    fn trial_started_at(&self) -> u64 {
        let read = |path: &Path| {
            fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Trial>(&bytes).ok())
                .map(|t| t.started_at)
        };
        let primary = read(&self.trial_path);
        let mirror = read(&self.trial_mirror_path);
        let started_at = primary.into_iter().chain(mirror).min().unwrap_or_else(now_millis);
        if let Ok(json) = serde_json::to_vec(&Trial { started_at }) {
            for (path, existing) in [(&self.trial_path, primary), (&self.trial_mirror_path, mirror)] {
                if existing != Some(started_at) {
                    if let Some(parent) = path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::write(path, &json);
                }
            }
        }
        started_at
    }

    /// The weekly re-check: when one is due, asks Polar whether this
    /// computer's activation is still valid and forgets the key if not.
    /// Never fails — an unreachable or misbehaving Polar leaves the license
    /// as it was, to be checked again next launch.
    pub async fn refresh(&self) -> Result<LicenseStatus, DbError> {
        let Some(mut license) = self.read()? else {
            return self.status();
        };
        let now = now_millis();
        if !revalidation_due(license.last_validated_at, now) {
            return self.status();
        }
        let Ok(response) = post_to_polar(
            POLAR_VALIDATE_URL,
            serde_json::json!({
                "key": license.key,
                "organization_id": POLAR_ORGANIZATION_ID,
                "activation_id": license.activation_id,
            }),
        )
        .await
        else {
            return self.status();
        };
        let code = response.status();
        if matches!(code.as_u16(), 403 | 404 | 422) {
            self.forget()?;
        } else if code.is_success() {
            match response.json::<ValidatedKey>().await {
                Ok(key) if key.status == "granted" => {
                    license.last_validated_at = now;
                    self.write(&license)?;
                }
                Ok(_) => self.forget()?,
                Err(_) => {}
            }
        }
        self.status()
    }

    /// Activates `key` for this computer with Polar and saves it.
    pub async fn activate(&self, key: &str) -> Result<LicenseStatus, DbError> {
        let key = key.trim();
        let response = post_to_polar(
            POLAR_ACTIVATE_URL,
            serde_json::json!({
                "key": key,
                "organization_id": POLAR_ORGANIZATION_ID,
                "label": device_label(),
            }),
        )
        .await?;

        let code = response.status();
        // Polar answers 404 for a key it doesn't know, and 422 for one too
        // malformed to look up — to the user, both are just a wrong key.
        if code == reqwest::StatusCode::NOT_FOUND
            || code == reqwest::StatusCode::UNPROCESSABLE_ENTITY
        {
            return Err(DbError::internal(
                "That license key wasn't recognized. Check it against your purchase email.",
            ));
        }
        // 403 covers both a used-up activation limit and a revoked or
        // disabled key; only Polar's own detail says which.
        if code == reqwest::StatusCode::FORBIDDEN {
            let detail = error_detail(response).await;
            return Err(DbError::internal(if detail.to_lowercase().contains("limit") {
                "This key is already active on the maximum number of computers. Remove it \
                 in Settings on one of them, or from your Polar customer portal, then try again."
                    .to_string()
            } else {
                format!("This license key can't be activated: {detail}")
            }));
        }
        if !code.is_success() {
            return Err(DbError::internal(format!(
                "The license server returned an error ({code}). Try again in a moment."
            )));
        }
        let activation: Activation = response
            .json()
            .await
            .map_err(|e| DbError::internal(format!("Unexpected license server response: {e}")))?;

        self.write(&StoredLicense {
            key: key.to_string(),
            activation_id: activation.id,
            display_key: activation.license_key.display_key,
            email: activation.license_key.customer.and_then(|c| c.email),
            activated_at: now_millis(),
            last_validated_at: now_millis(),
        })?;
        self.status()
    }

    /// Deactivates this computer with Polar, then forgets the key. Refuses
    /// (keeping the key) when Polar can't be reached, since removing it
    /// locally would leave the slot used up with no way to free it from here.
    pub async fn remove(&self) -> Result<(), DbError> {
        let Some(license) = self.read()? else {
            return Ok(());
        };
        let response = post_to_polar(
            POLAR_DEACTIVATE_URL,
            serde_json::json!({
                "key": license.key,
                "organization_id": POLAR_ORGANIZATION_ID,
                "activation_id": license.activation_id,
            }),
        )
        .await?;
        // 404: the activation is already gone (e.g. removed in the customer
        // portal), which is the state we wanted anyway.
        let code = response.status();
        if !code.is_success() && code != reqwest::StatusCode::NOT_FOUND {
            return Err(DbError::internal(format!(
                "The license server returned an error ({code}). Try again in a moment."
            )));
        }
        self.forget()
    }

    fn forget(&self) -> Result<(), DbError> {
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err(e)),
            _ => Ok(()),
        }
    }

    /// A file that doesn't parse counts as no license rather than an error,
    /// so a damaged or hand-mangled file can't keep the lock screen away.
    fn read(&self) -> Result<Option<StoredLicense>, DbError> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        Ok(serde_json::from_slice(&bytes).ok())
    }

    fn write(&self, license: &StoredLicense) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let json =
            serde_json::to_vec_pretty(license).map_err(|e| DbError::internal(e.to_string()))?;
        fs::write(&self.path, json).map_err(io_err)?;
        restrict_permissions(&self.path);
        Ok(())
    }
}

async fn post_to_polar(url: &str, body: serde_json::Value) -> Result<reqwest::Response, DbError> {
    crate::ai::http_client()
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            DbError::new(
                DbErrorKind::Connection,
                format!("Couldn't reach the license server: {e}"),
            )
        })
}

/// Polar's `detail` is a string for most errors but a list for validation
/// errors; either way, something readable.
async fn error_detail(response: reqwest::Response) -> String {
    match response.json::<PolarError>().await.ok().and_then(|e| e.detail) {
        Some(serde_json::Value::String(s)) => s,
        Some(other) => other.to_string(),
        None => "no reason given".to_string(),
    }
}

/// How this computer is listed among the key's activations in Polar's
/// customer portal — the name the user gave it where the OS has one
/// ("Allen's MacBook Pro"), else its hostname.
fn device_label() -> String {
    let run = |program: &str, args: &[&str]| {
        std::process::Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    #[cfg(target_os = "macos")]
    if let Some(name) = run("scutil", &["--get", "ComputerName"]) {
        return name;
    }
    run("hostname", &[]).unwrap_or_else(|| "Unnamed computer".to_string())
}

/// Due a week after the last check, or right away when the recorded check is
/// in the future (a hand-edited file trying to skip checks forever).
fn revalidation_due(last_validated_at: u64, now: u64) -> bool {
    last_validated_at > now + DAY_MS || now - last_validated_at >= REVALIDATE_DAYS * DAY_MS
}

fn trial_days_left(started_at: u64, now: u64) -> u64 {
    let ends_at = started_at + TRIAL_DAYS * DAY_MS;
    ends_at.saturating_sub(now).div_ceil(DAY_MS)
}

fn io_err(e: std::io::Error) -> DbError {
    DbError::new(DbErrorKind::Internal, format!("File error: {e}"))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> LicenseStore {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cubbydb-license-test-{}-{}-{n}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        LicenseStore::new(&dir, &dir.join("cache"))
    }

    #[test]
    fn trial_counts_down_whole_days_then_ends() {
        let start = 1_000_000;
        assert_eq!(trial_days_left(start, start), TRIAL_DAYS);
        assert_eq!(trial_days_left(start, start + 1), TRIAL_DAYS);
        assert_eq!(trial_days_left(start, start + DAY_MS), TRIAL_DAYS - 1);
        assert_eq!(trial_days_left(start, start + TRIAL_DAYS * DAY_MS - 1), 1);
        assert_eq!(trial_days_left(start, start + TRIAL_DAYS * DAY_MS), 0);
        assert_eq!(trial_days_left(start, start + 30 * DAY_MS), 0);
    }

    #[test]
    fn trial_starts_once_and_is_remembered() {
        let store = temp_store();
        let first = store.trial_started_at();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(store.trial_started_at(), first);
        assert_eq!(store.status().unwrap().trial_days_left, TRIAL_DAYS);
    }

    #[test]
    fn deleting_either_trial_copy_keeps_the_original_start() {
        let store = temp_store();
        fs::write(&store.trial_path, r#"{"startedAt":1000}"#).unwrap();
        assert_eq!(store.trial_started_at(), 1000);
        fs::remove_file(&store.trial_path).unwrap();
        assert_eq!(store.trial_started_at(), 1000);
        fs::remove_file(&store.trial_mirror_path).unwrap();
        assert_eq!(store.trial_started_at(), 1000);
    }

    #[test]
    fn revalidation_is_weekly_and_distrusts_future_dates() {
        let now = 100 * DAY_MS;
        assert!(revalidation_due(0, now));
        assert!(!revalidation_due(now - DAY_MS, now));
        assert!(revalidation_due(now - 7 * DAY_MS, now));
        assert!(revalidation_due(now + 2 * DAY_MS, now));
    }

    #[test]
    fn unparsable_license_file_counts_as_unlicensed() {
        let store = temp_store();
        fs::write(&store.path, "{ not json").unwrap();
        assert!(!store.status().unwrap().licensed);
    }

    #[test]
    fn unlicensed_until_written_and_after_forgotten() {
        let store = temp_store();
        assert!(!store.status().unwrap().licensed);
        store
            .write(&StoredLicense {
                key: "CUBBY-1234".into(),
                activation_id: "act-1".into(),
                last_validated_at: 1,
                display_key: "****-1234".into(),
                email: Some("a@example.com".into()),
                activated_at: 1,
            })
            .unwrap();
        let status = store.status().unwrap();
        assert!(status.licensed);
        assert_eq!(status.display_key.as_deref(), Some("****-1234"));
        store.forget().unwrap();
        assert!(!store.status().unwrap().licensed);
        store.forget().unwrap();
    }
}
