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

/** One structured reply from Ollama's native chat API, streamed so long CPU generations don't hit HTTP timeouts. */
export async function askOllama<T>(system: string, user: string, schema: object, temperature = 0.2): Promise<T> {
  try {
    return await askOllamaOnce<T>(system, user, schema, temperature);
  } catch (e) {
    // An occasional empty or cut-off reply (the model reloading under memory pressure): ask once more.
    if (!(e instanceof SyntaxError)) throw e;
    return askOllamaOnce<T>(system, user, schema, temperature);
  }
}

async function askOllamaOnce<T>(system: string, user: string, schema: object, temperature: number): Promise<T> {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      format: schema,
      options: { num_ctx: config.ollamaContext, temperature },
      // Stay loaded between requests: reloading 5 GB on a laptop short of memory is slow.
      keep_alive: config.ollamaKeepAlive,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  let text = "";
  let buffered = "";
  // The last chunk reports the prompt's size: one that filled the context was cut off by Ollama.
  const read = (chunk: { message?: { content?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number }) => {
    if (chunk.done && (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0) >= config.ollamaContext - 32)
      console.error(`warning: an Ollama prompt filled the ${config.ollamaContext}-token context (${chunk.prompt_eval_count} in, ${chunk.eval_count} out); raise OLLAMA_CONTEXT`);
    if (config.debug && chunk.done) console.error(`[debug] tokens: ${chunk.prompt_eval_count} in, ${chunk.eval_count} out`);
    return chunk.message?.content ?? "";
  };
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) if (line.trim()) text += read(JSON.parse(line));
  }
  if (buffered.trim()) text += read(JSON.parse(buffered));
  if (config.debug) console.error("[debug] guided reply:", text.slice(0, 3000));
  return JSON.parse(text) as T;
}
