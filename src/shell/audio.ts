// Web Audio notification sound — no asset shipped.
//
// The "lobby found" chime is synthesized at runtime (two short tones), so the
// userscript carries zero audio bytes and isn't subject to the page's missing
// media-src CSP. A custom base64 data-URL sound is still honored if one is set.
//
// The content engine constructs `new Audio(src)`; we shadow Audio with this so
// its .play() rings the chime. Surface: new Audio(src), .src, .preload,
// .currentTime, .volume, .loop, play(), pause().

let ctx: AudioContext | null = null;
let pendingSpawnSpeech: string | null = null;
let spawnSpeechActivated = false;

function getCtx(): AudioContext {
  ctx ??= new AudioContext();
  return ctx;
}

function installGestureResume(): void {
  const resume = () => {
    const context = getCtx();
    if (context.state === "suspended") void context.resume();
    activateSpawnSpeech();
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", resume, opts);
  window.addEventListener("keydown", resume, opts);
}

// A short, friendly two-note chime.
function playChime(volume: number): void {
  const context = getCtx();
  const now = context.currentTime;
  const notes = [
    { freq: 880, start: 0, dur: 0.16 }, // A5
    { freq: 1318.5, start: 0.13, dur: 0.22 }, // E6
  ];
  for (const note of notes) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.value = note.freq;
    const t0 = now + note.start;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.25 * volume, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);
    osc.connect(gain).connect(context.destination);
    osc.start(t0);
    osc.stop(t0 + note.dur + 0.02);
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const decodeCache = new Map<string, Promise<AudioBuffer | null>>();

function decodeCustom(src: string): Promise<AudioBuffer | null> {
  let cached = decodeCache.get(src);
  if (cached) return cached;
  cached = (async () => {
    const marker = ";base64,";
    const idx = src.indexOf(marker);
    if (!src.startsWith("data:") || idx < 0) return null;
    {
      return await getCtx().decodeAudioData(base64ToArrayBuffer(src.slice(idx + marker.length)));
    }
  })();
  decodeCache.set(src, cached);
  return cached;
}

export class WebAudioElement {
  src: string;
  preload = "auto";
  currentTime = 0;
  volume = 1;
  loop = false;

  constructor(src = "") {
    this.src = src;
  }

  async play(): Promise<void> {
    const context = getCtx();
    if (context.state === "suspended") {
      {
        await context.resume();
      }
    }
    // A real base64 sound (custom upload) -> play it; otherwise the chime.
    const buffer = this.src.startsWith("data:") ? await decodeCustom(this.src) : null;
    if (buffer) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = this.volume;
      source.connect(gain).connect(context.destination);
      source.start(0);
    } else {
      playChime(this.volume);
    }
  }

  pause(): void {
    /* one-shot sounds; nothing to pause */
  }
}

/** Directly ring the chime (used by the popup's "test sound" button). */
export async function ringChime(): Promise<void> {
  const context = getCtx();
  if (context.state === "suspended") {
    {
      await context.resume();
    }
  }
  if (context.state !== "running") return;
  playChime(1);
}

// Compact, local female-voice clips. They are rendered once with the feminine
// eSpeak voice and decoded through the same Web Audio path as the helper's
// chime, avoiding Brave's unavailable or silently blocked SpeechSynthesis
// service on Linux. Ogg/Opus keeps both prompts below 4 KB combined.
const SPAWN_VOICE_CLIPS: Record<string, string> = {
  "PICK SPAWN": [
    "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",
  ].join(""),
  "SPAWN, SPAWN": [
    "T2dnUwACAAAAAAAAAAB6YoGkAAAAAC8px/0BE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAA",
    "AAAAAHpigaQBAAAA1odHRAE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMgEAAAAdAAAAZW5jb2Rl",
    "cj1MYXZjNjIuMjguMTAyIGxpYm9wdXNPZ2dTAARWiAAAAAAAAHpigaQCAAAAmMMc3iUPFBQUHhkb",
    "GhITHR0aFh0TEBYQFxgTFBQTFBUUExcUEw8RDQ0RCIAJCFQQx0O1rvLv/nbkCJMldqxdTGZ+lUVJ",
    "oqOobJcjvlAIkvDxyj8nvMhT4ZjA9YzSpMuBcQisMXdqR7BIQBSjKoFDTO9R9x40CLWav4Bk2cnj",
    "JhQCCSvwKc2CYef2dXGJunZNEXBbCLrffrz6vO+ozTNsXjEuwr7VlBnMt5a8+Ai7tOiYL29HDT/O",
    "MLuUa7b9zmd/w0djVuoR/gi8Ibd10lXuwaPsJ9NwC+lvEDYoyg12CFb4CLprXccI8kKFkEAgAfcT",
    "YkOACLmIdeXUtxP231ozNUsHsGNv4Ai4ptJe+D8VmBL1mEtNCzk3+7dDSAMSivlSLHRgCLS+glS2",
    "p/CuZdkcQzNpETm/4Wq3ErXpYQahb8AItEtcyNyDHK0jOBNPleMcflCqTjvd0RylYAi16T+5TsRk",
    "/djs4NAXPj+zLiymD4AItZwHhIdPRq0oLOp1UFGGlIxDms9Jdx/dui/NwAi2oCpuEP/Hj9RrioUH",
    "ba0sKEAIlFscsI3jcsa7w5o10ghoCK+di3W0RNjW4c+kYNGihv4oWCeUoAiEggz5Z5auUGCaVgj3",
    "LqAIu/Sqz6L56l05L0ZIdg3TIDB3NO8NgAi7elHu/4B1m89jsZLCp5aRu4joEIpugAi7/Emo2j6Q",
    "ffI1lvzdrryJFsAIu/xJq0mkM5tEtRGwMopM4l4t6Qi79YLyR3Ye9C0UFi3WmEX34AagCLv07KnY",
    "s8QRE9sF9clM8GrcWQi7RNbleclOklNYln/+tYzm3ZnWCLo20PoeOiGH7EmoLwUGtCVO19laCLlb",
    "rnVV5MeUonPgfb3XLFc34CAIt5AnVokwInUMuBDcm5spUfnMCLag0EDhc0NzaogiMhqKVK2rwk5a",
    "zqgItbgK4xN19LLWTDSIvyUncV9iZQi08Tdo2/xdCd3EicipXXwfPOAIs5dH0KpAVtDIumfFZGgI",
    "saOXY/RwepFPaEMJEp7M0AgFkunkdPvaiND4PxgIBTrNJHioDJm69TdiCAT+85pJCtzkMAki71d7",
    "i5I=",
  ].join(""),
};

function playSpawnVoice(text: string): boolean {
  const clip = SPAWN_VOICE_CLIPS[text];
  if (!clip) return false;
  void new WebAudioElement(`data:audio/ogg;base64,${clip}`).play();
  return true;
}

function activateSpawnSpeech(): void {
  spawnSpeechActivated = true;
  if (pendingSpawnSpeech === null) return;
  const prompt = pendingSpawnSpeech;
  pendingSpawnSpeech = null;
  playSpawnVoice(prompt);
}

/** Spawn-phase spoken prompts use bundled female-voice clips, not Web Speech. */
export function speakSpawnPrompt(text: string): void {
  if (!spawnSpeechActivated) {
    pendingSpawnSpeech = text;
    return;
  }
  if (!playSpawnVoice(text)) pendingSpawnSpeech = text;
}

export function installAudio(): typeof WebAudioElement {
  installGestureResume();
  return WebAudioElement;
}
