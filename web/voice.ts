// Spoken answers. A natural neural voice (Kokoro, made by the Forge server) once
// it has loaded, and the browser's best built-in voice until then, or
// if it can't load. Both read the same tidied text, one sentence at a time.

export const VOICES = [
  { id: "af_heart", label: "Heart · US, warm" },
  { id: "af_bella", label: "Bella · US, bright" },
  { id: "bf_emma", label: "Emma · UK" },
  { id: "am_michael", label: "Michael · US" },
  { id: "bm_george", label: "George · UK" },
  { id: "browser", label: "Browser voice" },
] as const;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

let voice: string = new URLSearchParams(location.search).get("voice") ?? store.get("forge.voice") ?? "af_heart";
let enabled = () => true;
let onStatus: (text: string) => void = () => {};
let onSpeaking: (on: boolean) => void = () => {};

// ---------- text as it should sound ----------

/** Symbols and units read aloud, so neither voice spells out "km/h" or "°C". */
export function spoken(text: string): string {
  return text
    .replace(/(\d)\s*°C\b/g, "$1 degrees Celsius")
    .replace(/(\d)\s*°F\b/g, "$1 degrees Fahrenheit")
    .replace(/(\d)\s*°/g, "$1 degrees")
    .replace(/\bkm\/h\b/g, "kilometres per hour")
    .replace(/\bμg\/m³|\bug\/m3\b/g, "micrograms per cubic metre")
    .replace(/\bmm\b/g, "millimetres")
    .replace(/(\d)\s*km\b/g, "$1 kilometres")
    .replace(/\bPM\s?2\.5\b/g, "PM 2.5")
    .replace(/\bAQI\b/g, "A.Q.I.")
    .replace(/\bISS\b/g, "I.S.S.")
    .replace(/(\d)%/g, "$1 percent")
    .replace(/(\d) (USD|INR|EUR|GBP|JPY|AED)\b/g, (_, d, c) => `${d} ${({ USD: "US dollars", INR: "rupees", EUR: "euros", GBP: "pounds", JPY: "yen", AED: "dirhams" } as Record<string, string>)[c]}`)
    .replace(/(^|[\s(])-(\d)/g, "$1minus $2")
    // Indian digit grouping (2,29,373) confuses speech engines; the bare number reads well.
    .replace(/\d{1,3}(?:,\d{2,3})+/g, (n) => n.replace(/,/g, ""))
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => new Date(`${y}-${m}-${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }))
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences, kept whole across decimals like 31.5, with very short ones joined to the next. */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    if (out.length && out[out.length - 1].length < 25) out[out.length - 1] += " " + part;
    else out.push(part);
  }
  // Long sentences are split at the comma nearest their middle: each piece starts sooner.
  return out.filter((s) => s.trim()).flatMap((s) => {
    if (s.length < 90) return [s];
    const commas = [...s.matchAll(/, /g)].map((m) => m.index!).filter((i) => i > 25 && s.length - i > 25);
    if (!commas.length) return [s];
    const at = commas.reduce((a, b) => (Math.abs(b - s.length / 2) < Math.abs(a - s.length / 2) ? b : a));
    return [s.slice(0, at + 1), s.slice(at + 2)];
  });
}

// ---------- the browser's own voice ----------

const PREFERRED = [/natural/i, /^Google UK English Female$/, /^Google US English$/, /^Google UK English Male$/, /Samantha|Karen|Moira|Daniel/, /Microsoft (Aria|Jenny|Guy|Zira)/];

function browserVoice(): SpeechSynthesisVoice | undefined {
  const all = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  for (const p of PREFERRED) {
    const v = all.find((x) => p.test(x.name));
    if (v) return v;
  }
  return all.find((v) => !/espeak/i.test(v.name)) ?? all[0];
}

function speakWithBrowser(parts: string[], mine: number) {
  if (!("speechSynthesis" in window) || !parts.length) return onSpeaking(false);
  const v = browserVoice();
  // One utterance per sentence: Chrome's online voices stop mid-way through long ones.
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = 1;
    if (i === 0) u.onstart = () => mine === turn && onSpeaking(true);
    if (i === parts.length - 1) u.onend = u.onerror = () => mine === turn && onSpeaking(false);
    speechSynthesis.speak(u);
  });
}

// ---------- the natural voice ----------
// Made by the Forge server (src/voice.ts): the browser could only run it on one core.

let ready = false;
let request: AbortController | undefined;

async function watchNatural() {
  for (let i = 0; i < 120; i++) {
    try {
      const s = await (await fetch("/voice/status")).json();
      if (s.ready) {
        ready = true;
        return onStatus("");
      }
      if (s.failed) return onStatus("");
      onStatus("Loading the natural voice…");
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  onStatus("");
}

function synthesize(text: string, signal: AbortSignal): Promise<ArrayBuffer | null> {
  return fetch("/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }), signal })
    .then((r) => (r.status === 200 ? r.arrayBuffer() : null))
    .catch(() => null);
}

let audio: HTMLAudioElement | undefined;

function play(wav: ArrayBuffer): Promise<void> {
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  audio = new Audio(url);
  return new Promise((resolve) => {
    const done = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio!.onended = done;
    audio!.onpause = done;
    audio!.onerror = done;
    audio!.play().catch(done);
  });
}

// ---------- speaking ----------

let turn = 0;

export function stopSpeaking() {
  turn++;
  request?.abort();
  request = undefined;
  audio?.pause();
  audio = undefined;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  onSpeaking(false);
}

export function speak(text: string) {
  if (!enabled()) return;
  stopSpeaking();
  const parts = sentences(spoken(text));
  const mine = turn;
  if (!ready || voice === "browser") return speakWithBrowser(parts, mine);
  request = new AbortController();
  const signal = request.signal;
  void (async () => {
    // The next sentence is made while this one plays.
    let next = synthesize(parts[0], signal);
    for (let i = 0; i < parts.length; i++) {
      const wav = await next;
      if (mine !== turn) return;
      if (!wav) return speakWithBrowser(parts.slice(i), mine);
      if (i + 1 < parts.length) next = synthesize(parts[i + 1], signal);
      onSpeaking(true);
      await play(wav);
      if (mine !== turn) return;
    }
    onSpeaking(false);
  })();
}

/** Wires the voice picker and starts loading the natural voice in the background. */
export function setupVoice(opts: { picker: HTMLSelectElement; status: HTMLElement; enabled: () => boolean; onSpeaking: (on: boolean) => void }) {
  enabled = opts.enabled;
  onSpeaking = opts.onSpeaking;
  onStatus = (t) => (opts.status.textContent = t);
  if (!VOICES.some((v) => v.id === voice)) voice = "af_heart";
  for (const v of VOICES) opts.picker.append(new Option(v.label, v.id, false, v.id === voice));
  opts.picker.onchange = () => {
    voice = opts.picker.value;
    store.set("forge.voice", voice);
    speak("Hi! This is how I'll sound from now on.");
  };
  // Chrome lists its voices only after this event; read them once so the first answer has them.
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  void watchNatural();
}
