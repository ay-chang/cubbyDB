/** Reading an `AiConfigStatus` — shared by every surface that has to know
 *  whether the assistant can actually run before offering to use it.
 *
 *  Each provider proves itself differently (an API key for Anthropic and
 *  OpenAI, a signed-in CLI for Codex and Claude Code), and only the active
 *  one's proof matters — a saved Anthropic key doesn't make Codex usable.
 *  That distinction is easy to get subtly wrong twice, which is why it lives
 *  here rather than beside each caller. */
import type { AiConfigStatus } from "../types";

/** The active provider's display name, for prompts like "Add an X API key". */
export function aiProviderLabel(config: AiConfigStatus | null): string {
  switch (config?.provider) {
    case "openai":
      return "OpenAI";
    case "codex":
      return "Codex";
    case "claudeCode":
      return "Claude Code";
    default:
      return "Anthropic";
  }
}

/** Whether the active provider is set up enough to answer.
 *
 *  `null` config means "not loaded yet" and reads as ready: the alternative
 *  is flashing a setup prompt on every launch before the config arrives, and
 *  a request made in that window fails with the backend's own message
 *  anyway. */
export function aiProviderReady(config: AiConfigStatus | null): boolean {
  if (!config) return true;
  switch (config.provider) {
    case "codex":
      return config.codexAuthenticated;
    case "claudeCode":
      return config.claudeCodeAuthenticated;
    case "openai":
      return config.openaiKeySet;
    default:
      return config.anthropicKeySet;
  }
}
