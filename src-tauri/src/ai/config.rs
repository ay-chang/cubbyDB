//! Persistence for the AI assistant's config (API key + chosen model).
//!
//! Anthropic-only, deliberately: an earlier version supported OpenAI too,
//! with a provider switch and a key/model per provider. Mirrors
//! `connections.rs`'s plaintext-JSON-with-`0600`-perms approach exactly —
//! see that module's doc comment for why this app stores secrets this way
//! instead of the OS keychain (keychain prompts on every read/write are too
//! disruptive for something read on every AI panel use).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "ai_config.json";

/// The AI assistant's full config. Never sent to the frontend as-is — see
/// [`AiConfigStatus`], which masks the actual key.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default)]
    pub anthropic_api_key: Option<String>,
    /// `None` until the user explicitly picks one in Settings — falls back
    /// to `provider::DEFAULT_MODEL` (see [`AiConfig::model`]).
    #[serde(default)]
    pub anthropic_model: Option<String>,
    /// Whether `anthropic_model` accepts `output_config.effort`, captured
    /// from the Models API when the user picked it. `None` means unknown
    /// (no model picked yet, or a config written before this field existed)
    /// and is treated as "don't send it" — omitting effort costs a little
    /// efficiency, whereas sending it to a model that rejects it 400s every
    /// request.
    #[serde(default)]
    pub anthropic_model_supports_effort: Option<bool>,
}

impl AiConfig {
    pub fn api_key(&self) -> Option<&str> {
        self.anthropic_api_key.as_deref()
    }

    /// The model id to use: whatever the user picked, or the hardcoded
    /// fallback if they haven't picked one yet.
    pub fn model(&self) -> &str {
        self.anthropic_model
            .as_deref()
            .unwrap_or(crate::ai::provider::DEFAULT_MODEL)
    }

    /// Whether it's safe to send `output_config.effort` for the active
    /// model. Defaults to `false` when unknown — see the field docs.
    pub fn model_supports_effort(&self) -> bool {
        self.anthropic_model_supports_effort.unwrap_or(false)
    }
}

/// What's actually reported back to the frontend — the real key never
/// round-trips to JS once saved, only whether one is set. `model` is always
/// resolved (saved choice, or the default) so the Settings picker always has
/// a concrete value to show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigStatus {
    pub anthropic_key_set: bool,
    pub anthropic_model: String,
}

impl From<&AiConfig> for AiConfigStatus {
    fn from(config: &AiConfig) -> Self {
        Self {
            anthropic_key_set: config.anthropic_api_key.is_some(),
            anthropic_model: config
                .anthropic_model
                .clone()
                .unwrap_or_else(|| crate::ai::provider::DEFAULT_MODEL.to_string()),
        }
    }
}

/// Reads/writes the single AI-config record — a singleton file, same shape
/// as `connections.rs`'s `LastConnectionStore`.
pub struct AiConfigStore {
    path: PathBuf,
}

impl AiConfigStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(FILE_NAME),
        }
    }

    pub fn get(&self) -> Result<AiConfig, DbError> {
        if !self.path.exists() {
            return Ok(AiConfig::default());
        }
        let bytes = fs::read(&self.path).map_err(io_err)?;
        // A corrupt file shouldn't wedge the AI panel — fall back to unset.
        Ok(serde_json::from_slice(&bytes).unwrap_or_default())
    }

    fn write(&self, config: &AiConfig) -> Result<(), DbError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let json =
            serde_json::to_vec_pretty(config).map_err(|e| DbError::internal(e.to_string()))?;
        fs::write(&self.path, json).map_err(io_err)?;
        restrict_permissions(&self.path);
        Ok(())
    }

    pub fn set_api_key(&self, api_key: String) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.anthropic_api_key = Some(api_key);
        self.write(&config)?;
        Ok(config)
    }

    pub fn clear_api_key(&self) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.anthropic_api_key = None;
        self.write(&config)?;
        Ok(config)
    }

    pub fn set_model(&self, model: String, supports_effort: bool) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.anthropic_model = Some(model);
        config.anthropic_model_supports_effort = Some(supports_effort);
        self.write(&config)?;
        Ok(config)
    }
}

fn io_err(e: std::io::Error) -> DbError {
    DbError::new(DbErrorKind::Internal, format!("File error: {e}"))
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
