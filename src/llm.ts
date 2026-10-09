import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "./config.js";

/**
 * Claude via the first-party API or Amazon Bedrock (Mantle). Both expose the
 * same `beta.messages` surface, so the rest of Forge doesn't care which one runs.
 */
export function createClient(): Anthropic {
  if (config.provider === "bedrock") {
    return new AnthropicBedrockMantle({ awsRegion: config.awsRegion }) as unknown as Anthropic;
  }
  return new Anthropic();
}

/** Server-side refusal fallback is a Claude API feature; Bedrock requests go without it. */
export function fallbackParams(): Pick<Anthropic.Beta.MessageCreateParams, "betas" | "fallbacks"> {
  if (config.provider !== "anthropic") return {};
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}
