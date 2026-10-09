import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "./config.js";

/**
 * Claude via the first-party API or Amazon Bedrock (Mantle), or a local model via
 * Ollama's Anthropic-compatible endpoint. All expose the same `beta.messages`
 * surface, so the rest of Forge doesn't care which one runs.
 */
export function createClient(): Anthropic {
  if (config.provider === "bedrock") {
    return new AnthropicBedrockMantle({ awsRegion: config.awsRegion }) as unknown as Anthropic;
  }
  if (config.provider === "ollama") {
    return new Anthropic({ baseURL: config.ollamaUrl, apiKey: "ollama" });
  }
  return new Anthropic();
}

/** Claude-only request knobs; local models get plain tool use. */
export function modelParams(): Pick<Anthropic.Beta.MessageCreateParams, "thinking" | "output_config" | "max_tokens"> {
  if (config.provider === "ollama") return { max_tokens: 8192 };
  return { max_tokens: 64000, thinking: { type: "adaptive" }, output_config: { effort: "high" } };
}

/** Server-side refusal fallback is a Claude API feature; Bedrock requests go without it. */
export function fallbackParams(): Pick<Anthropic.Beta.MessageCreateParams, "betas" | "fallbacks"> {
  if (config.provider !== "anthropic") return {};
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}
