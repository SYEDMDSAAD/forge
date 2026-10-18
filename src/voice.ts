// The demo page's natural voice: Kokoro (82M parameters, Apache-2.0), run on the
// CPU here because the browser can only run it on one core. Not part of the MCP
// server; Alexa+ speaks with its own voice.
import type { KokoroTTS } from "kokoro-js";

export const VOICE_IDS = ["af_heart", "af_bella", "bf_emma", "am_michael", "bm_george"] as const;

let loading: Promise<KokoroTTS> | undefined;
export const voiceState = { ready: false, failed: false };

export function loadVoice(): Promise<KokoroTTS> {
  loading ??= import("kokoro-js").then(({ KokoroTTS }) =>
    KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" }),
  );
  loading.then(
    () => (voiceState.ready = true),
    (e) => {
      voiceState.failed = true;
      console.warn("Natural voice unavailable, the demo page will use the browser's voice:", e instanceof Error ? e.message : e);
    },
  );
  return loading;
}

// One sentence at a time; sentences of an answer the listener has interrupted are skipped.
let queue: Promise<unknown> = Promise.resolve();

export function synthesize(text: string, voice: string, wanted: () => boolean): Promise<ArrayBuffer | null> {
  const job = queue.then(async () => {
    if (!wanted()) return null;
    const tts = await loadVoice();
    return (await tts.generate(text, { voice: voice as (typeof VOICE_IDS)[number] })).toWav();
  });
  queue = job.catch(() => {});
  return job;
}
