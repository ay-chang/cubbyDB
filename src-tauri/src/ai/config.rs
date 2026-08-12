//! Persistence for the AI assistant's provider, API keys, and chosen models.
//!
//! Provider credentials are kept separately so switching providers does not
//! make the user re-enter a key. This mirrors
//! `connections.rs`'s plaintext-JSON-with-`0600`-perms approach exactly —
//! see that module's doc comment for why this app stores secrets this way
//! instead of the OS keychain (keychain prompts on every read/write are too
//! disruptive for something read on every AI panel use).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ReasoningEffort;
use crate::db::{DbError, DbErrorKind};

const FILE_NAME: &str = "ai_config.json";

/// Bump this whenever the AI-provider terms at cubbydb.com/terms change in a
/// way that should re-prompt anyone who already accepted an older version —
/// see `AiConfig::terms_accepted_version` and `AiConfigStore::accept_terms`.
pub const CURRENT_AI_TERMS_VERSION: &str = "2026-08-11";

/// AI API selected for new assistant turns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    #[default]
    Anthropic,
    Openai,
    Codex,
    /// Claude subscription access via the `claude` CLI's own OAuth login —
    /// same relationship to Anthropic that `Codex` has to OpenAI's API.
    #[serde(rename = "claudeCode")]
    ClaudeCode,
}

/// The AI assistant's full config. Never sent to the frontend as-is — see
/// [`AiConfigStatus`], which masks the actual key.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// Defaults to Anthropic so configs written before provider selection was
    /// added keep exactly the behavior they had before.
    #[serde(default)]
    pub provider: AiProvider,
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
    #[serde(default)]
    pub openai_api_key: Option<String>,
    #[serde(default)]
    pub openai_model: Option<String>,
    #[serde(default)]
    pub openai_model_supports_effort: Option<bool>,
    #[serde(default)]
    pub openai_reasoning_effort: Option<ReasoningEffort>,
    /// Codex subscription access is authenticated by the Codex CLI, so no
    /// credential is stored in this config — only the model choice.
    #[serde(default)]
    pub codex_model: Option<String>,
    #[serde(default)]
    pub codex_reasoning_effort: Option<ReasoningEffort>,
    /// Claude Code subscription access is authenticated by the `claude` CLI,
    /// same reasoning as `codex_model` above — no credential stored here.
    #[serde(default)]
    pub claude_code_model: Option<String>,
    #[serde(default)]
    pub claude_code_reasoning_effort: Option<ReasoningEffort>,
    /// The AI-provider terms version (see `CURRENT_AI_TERMS_VERSION`) the
    /// user last explicitly accepted, via `AiConfigStore::accept_terms`.
    /// `None` until they accept for the first time. Compared against the
    /// current constant rather than treated as a bare bool so a future terms
    /// change can re-prompt instead of silently grandfathering old consent.
    #[serde(default)]
    pub terms_accepted_version: Option<String>,
}

impl AiConfig {
    pub fn provider(&self) -> AiProvider {
        self.provider
    }

    pub fn api_key(&self) -> Option<&str> {
        match self.provider {
            AiProvider::Anthropic => self.anthropic_api_key.as_deref(),
            AiProvider::Openai => self.openai_api_key.as_deref(),
            AiProvider::Codex | AiProvider::ClaudeCode => None,
        }
    }

    /// The model id to use: whatever the user picked, or the hardcoded
    /// fallback if they haven't picked one yet.
    pub fn model(&self) -> &str {
        match self.provider {
            AiProvider::Anthropic => self
                .anthropic_model
                .as_deref()
                .unwrap_or(crate::ai::provider::DEFAULT_MODEL),
            AiProvider::Openai => self
                .openai_model
                .as_deref()
                .filter(|model| *model != "gpt-5.6")
                .unwrap_or(crate::ai::openai::DEFAULT_MODEL),
            AiProvider::Codex => self
                .codex_model
                .as_deref()
                .unwrap_or(crate::ai::codex::DEFAULT_MODEL),
            AiProvider::ClaudeCode => self
                .claude_code_model
                .as_deref()
                .unwrap_or(crate::ai::claude_code::DEFAULT_MODEL),
        }
    }

    pub fn reasoning_effort(&self) -> Option<ReasoningEffort> {
        match self.provider {
            AiProvider::Anthropic => None,
            AiProvider::Openai => Some(self.openai_reasoning_effort.unwrap_or_default()),
            AiProvider::Codex => Some(self.codex_reasoning_effort.unwrap_or_default()),
            AiProvider::ClaudeCode => Some(self.claude_code_reasoning_effort.unwrap_or_default()),
        }
    }

    /// Whether it's safe to send `output_config.effort` for the active
    /// model. Defaults to `false` when unknown — see the field docs. Codex
    /// and Claude Code have their own reasoning-effort flag on every model
    /// (see their `run_loop`s), so this bool is meaningless for them.
    pub fn model_supports_effort(&self) -> bool {
        match self.provider {
            AiProvider::Anthropic => self.anthropic_model_supports_effort.unwrap_or(false),
            AiProvider::Openai => self.openai_model_supports_effort.unwrap_or(true),
            AiProvider::Codex | AiProvider::ClaudeCode => false,
        }
    }
}

/// What's actually reported back to the frontend — the real key never
/// round-trips to JS once saved. A short masked hint identifies which key is
/// configured without exposing enough of it to authenticate. `model` is
/// always resolved (saved choice, or the default) so the Settings picker
/// always has a concrete value to show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigStatus {
    pub provider: AiProvider,
    pub anthropic_key_set: bool,
    pub anthropic_key_hint: Option<String>,
    pub anthropic_model: String,
    pub openai_key_set: bool,
    pub openai_key_hint: Option<String>,
    pub openai_model: String,
    pub openai_reasoning_effort: ReasoningEffort,
    pub codex_model: String,
    pub codex_reasoning_effort: ReasoningEffort,
    pub codex_installed: bool,
    pub codex_authenticated: bool,
    pub codex_email: Option<String>,
    pub codex_plan_type: Option<String>,
    pub codex_version: Option<String>,
    pub codex_error: Option<String>,
    pub claude_code_model: String,
    pub claude_code_reasoning_effort: ReasoningEffort,
    pub claude_code_installed: bool,
    pub claude_code_authenticated: bool,
    pub claude_code_email: Option<String>,
    pub claude_code_plan_type: Option<String>,
    pub claude_code_version: Option<String>,
    pub claude_code_error: Option<String>,
    /// Whether `terms_accepted_version` matches `CURRENT_AI_TERMS_VERSION` —
    /// the frontend only needs to know "current or not", not the raw string.
    pub terms_accepted: bool,
}

impl From<&AiConfig> for AiConfigStatus {
    fn from(config: &AiConfig) -> Self {
        Self {
            provider: config.provider,
            anthropic_key_set: config.anthropic_api_key.is_some(),
            anthropic_key_hint: config.anthropic_api_key.as_deref().map(masked_api_key_hint),
            anthropic_model: config
                .anthropic_model
                .clone()
                .unwrap_or_else(|| crate::ai::provider::DEFAULT_MODEL.to_string()),
            openai_key_set: config.openai_api_key.is_some(),
            openai_key_hint: config.openai_api_key.as_deref().map(masked_api_key_hint),
            openai_model: config
                .openai_model
                .clone()
                .filter(|model| model != "gpt-5.6")
                .unwrap_or_else(|| crate::ai::openai::DEFAULT_MODEL.to_string()),
            openai_reasoning_effort: config.openai_reasoning_effort.unwrap_or_default(),
            codex_model: config
                .codex_model
                .clone()
                .unwrap_or_else(|| crate::ai::codex::DEFAULT_MODEL.to_string()),
            codex_reasoning_effort: config.codex_reasoning_effort.unwrap_or_default(),
            codex_installed: false,
            codex_authenticated: false,
            codex_email: None,
            codex_plan_type: None,
            codex_version: None,
            codex_error: None,
            claude_code_model: config
                .claude_code_model
                .clone()
                .unwrap_or_else(|| crate::ai::claude_code::DEFAULT_MODEL.to_string()),
            claude_code_reasoning_effort: config.claude_code_reasoning_effort.unwrap_or_default(),
            claude_code_installed: false,
            claude_code_authenticated: false,
            claude_code_email: None,
            claude_code_plan_type: None,
            claude_code_version: None,
            claude_code_error: None,
            terms_accepted: config.terms_accepted_version.as_deref()
                == Some(CURRENT_AI_TERMS_VERSION),
        }
    }
}

/// Preserve only a recognizable provider prefix and the final four
/// characters. Unknown key formats reveal no prefix at all; very short
/// values reveal neither prefix nor suffix.
fn masked_api_key_hint(key: &str) -> String {
    let trimmed = key.trim();
    let prefix = ["sk-svcacct-", "sk-proj-", "sk-ant-", "sk-"]
        .into_iter()
        .find(|candidate| trimmed.starts_with(candidate))
        .unwrap_or("");
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if trimmed.chars().count() <= prefix.chars().count() + 8 {
        return format!("{prefix}••••");
    }
    format!("{prefix}••••{suffix}")
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

    pub fn set_provider(&self, provider: AiProvider) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.provider = provider;
        self.write(&config)?;
        Ok(config)
    }

    pub fn set_api_key(&self, provider: AiProvider, api_key: String) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.provider = provider;
        match provider {
            AiProvider::Anthropic => config.anthropic_api_key = Some(api_key),
            AiProvider::Openai => config.openai_api_key = Some(api_key),
            AiProvider::Codex => {
                return Err(DbError::new(
                    DbErrorKind::Internal,
                    "Codex uses ChatGPT sign-in, not an API key.",
                ));
            }
            AiProvider::ClaudeCode => {
                return Err(DbError::new(
                    DbErrorKind::Internal,
                    "Claude Code uses Claude sign-in, not an API key.",
                ));
            }
        }
        self.write(&config)?;
        Ok(config)
    }

    pub fn clear_api_key(&self, provider: AiProvider) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        match provider {
            AiProvider::Anthropic => config.anthropic_api_key = None,
            AiProvider::Openai => config.openai_api_key = None,
            AiProvider::Codex | AiProvider::ClaudeCode => {}
        }
        self.write(&config)?;
        Ok(config)
    }

    pub fn set_model(
        &self,
        provider: AiProvider,
        model: String,
        supports_effort: bool,
    ) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.provider = provider;
        match provider {
            AiProvider::Anthropic => {
                config.anthropic_model = Some(model);
                config.anthropic_model_supports_effort = Some(supports_effort);
            }
            AiProvider::Openai => {
                config.openai_model = Some(model);
                config.openai_model_supports_effort = Some(supports_effort);
            }
            AiProvider::Codex => config.codex_model = Some(model),
            AiProvider::ClaudeCode => config.claude_code_model = Some(model),
        }
        self.write(&config)?;
        Ok(config)
    }

    pub fn set_reasoning_effort(
        &self,
        provider: AiProvider,
        effort: ReasoningEffort,
    ) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.provider = provider;
        match provider {
            AiProvider::Anthropic => {
                return Err(DbError::new(
                    DbErrorKind::Internal,
                    "Anthropic reasoning is managed by the selected model.",
                ));
            }
            AiProvider::Openai => config.openai_reasoning_effort = Some(effort),
            AiProvider::Codex => config.codex_reasoning_effort = Some(effort),
            AiProvider::ClaudeCode => config.claude_code_reasoning_effort = Some(effort),
        }
        self.write(&config)?;
        Ok(config)
    }

    /// Records that the user explicitly accepted the current AI-provider
    /// terms (see `CURRENT_AI_TERMS_VERSION`) — gates the Codex/Claude Code
    /// sign-in buttons on the frontend so connecting a subscription provider
    /// requires an affirmative click, not just a passive warning.
    pub fn accept_terms(&self) -> Result<AiConfig, DbError> {
        let mut config = self.get()?;
        config.terms_accepted_version = Some(CURRENT_AI_TERMS_VERSION.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_anthropic_config_keeps_anthropic_selected() {
        let config: AiConfig = serde_json::from_value(serde_json::json!({
            "anthropicApiKey": "legacy-key",
            "anthropicModel": "claude-test"
        }))
        .unwrap();

        assert_eq!(config.provider(), AiProvider::Anthropic);
        assert_eq!(config.api_key(), Some("legacy-key"));
        assert_eq!(config.model(), "claude-test");
    }

    #[test]
    fn status_masks_both_provider_keys() {
        let config = AiConfig {
            provider: AiProvider::Openai,
            anthropic_api_key: Some("anthropic-secret".into()),
            openai_api_key: Some("openai-secret".into()),
            ..AiConfig::default()
        };

        let value = serde_json::to_value(AiConfigStatus::from(&config)).unwrap();
        assert_eq!(value["provider"], "openai");
        assert_eq!(value["anthropicKeySet"], true);
        assert_eq!(value["anthropicKeyHint"], "••••cret");
        assert_eq!(value["openaiKeySet"], true);
        assert_eq!(value["openaiKeyHint"], "••••cret");
        assert_eq!(value["codexAuthenticated"], false);
        assert_eq!(value["openaiReasoningEffort"], "medium");
        assert_eq!(value["codexReasoningEffort"], "medium");
        assert!(!value.to_string().contains("secret"));
    }

    #[test]
    fn key_hints_keep_only_known_prefixes_and_four_character_suffixes() {
        assert_eq!(
            masked_api_key_hint("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"),
            "sk-ant-••••wxyz"
        );
        assert_eq!(
            masked_api_key_hint("sk-proj-abcdefghijklmnopqrstuvwxyz"),
            "sk-proj-••••wxyz"
        );
        assert_eq!(masked_api_key_hint("custom-secret-value"), "••••alue");
        assert_eq!(masked_api_key_hint("tiny"), "••••");
    }

    #[test]
    fn legacy_openai_alias_resolves_to_luna() {
        let config = AiConfig {
            provider: AiProvider::Openai,
            openai_model: Some("gpt-5.6".into()),
            ..AiConfig::default()
        };

        assert_eq!(config.model(), "gpt-5.6-luna");
        assert_eq!(config.reasoning_effort(), Some(ReasoningEffort::Medium));
    }
}
