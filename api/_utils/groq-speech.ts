/**
 * Groq text-to-speech (Canopy Labs Orpheus) for the "openai" TTS slot.
 *
 * The client setting is still stored as `ttsModel: "openai"` for backward
 * compatibility with saved preferences; the server sends it to Groq whenever
 * GROQ_API_KEY is set and to OpenAI `tts-1` otherwise.
 *
 * Orpheus specifics this module handles:
 * - input is capped at 200 characters per request, so longer text is split
 *   at sentence / clause / word boundaries and synthesized piece by piece;
 * - output is WAV, so the pieces are joined into a single WAV file;
 * - voices are its own (autumn, diana, hannah, austin, daniel, troy), so
 *   OpenAI voice names fall back to the default voice.
 */

export const GROQ_SPEECH_URL = "https://api.groq.com/openai/v1/audio/speech";
export const GROQ_TTS_MODEL = "canopylabs/orpheus-v1-english";
export const GROQ_TTS_MAX_INPUT_CHARS = 200;
export const GROQ_TTS_VOICES = [
  "autumn",
  "diana",
  "hannah",
  "austin",
  "daniel",
  "troy",
] as const;
export type GroqTtsVoice = (typeof GROQ_TTS_VOICES)[number];
export const DEFAULT_GROQ_TTS_VOICE: GroqTtsVoice = "troy";
/** Pieces synthesized at once; keeps a long reply fast without bursting the rate limit. */
const GROQ_TTS_CONCURRENCY = 3;

export function isGroqTtsVoice(voice: unknown): voice is GroqTtsVoice {
  return (
    typeof voice === "string" &&
    (GROQ_TTS_VOICES as readonly string[]).includes(voice)
  );
}

export function resolveGroqTtsVoice(voice: string | null | undefined): GroqTtsVoice {
  return isGroqTtsVoice(voice) ? voice : DEFAULT_GROQ_TTS_VOICE;
}

export function isGroqSpeechConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(env.GROQ_API_KEY?.trim());
}

/**
 * Split text into pieces no longer than `maxChars`, preferring to break after
 * sentence punctuation, then clause punctuation, then whitespace. A single
 * unbroken run longer than `maxChars` is hard-split as a last resort.
 */
export function splitTextForTts(
  text: string,
  maxChars: number = GROQ_TTS_MAX_INPUT_CHARS
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const pieces: string[] = [];
  let rest = normalized;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const cut =
      lastBreak(window, /[.!?…。！？](?=\s|$)/g, maxChars) ??
      lastBreak(window, /[,;:—–、，；：](?=\s|$)/g, maxChars) ??
      lastBreak(window, /\s/g, maxChars) ??
      maxChars;
    const head = rest.slice(0, cut).trim();
    if (head) pieces.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Index just after the last match of `re` that still fits in `maxChars`, or
 * null. Breaks in the first third are ignored so pieces don't get tiny.
 */
function lastBreak(window: string, re: RegExp, maxChars: number): number | null {
  let best: number | null = null;
  const minUseful = Math.floor(maxChars / 3);
  for (const m of window.matchAll(re)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end > minUseful && end <= maxChars) best = end;
  }
  return best;
}

interface WavParts {
  fmt: Uint8Array;
  data: Uint8Array;
}

function readAscii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Pull the `fmt ` and `data` chunks out of a RIFF/WAVE file. */
export function parseWav(bytes: Uint8Array): WavParts {
  if (bytes.length < 12 || readAscii(bytes, 0) !== "RIFF" || readAscii(bytes, 8) !== "WAVE") {
    throw new Error("Groq speech returned audio that is not a WAV file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: Uint8Array | null = null;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset);
    const declared = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (id === "data") {
      // Streamed WAVs may declare 0 or 0xFFFFFFFF; trust the bytes we have.
      const remaining = bytes.length - bodyStart;
      const size =
        declared === 0 || declared === 0xffffffff || declared > remaining
          ? remaining
          : declared;
      if (!fmt) throw new Error("WAV data chunk appeared before fmt chunk");
      return { fmt, data: bytes.subarray(bodyStart, bodyStart + size) };
    }
    if (id === "fmt ") fmt = bytes.subarray(bodyStart, bodyStart + declared);
    offset = bodyStart + declared + (declared % 2);
  }
  throw new Error("WAV file has no data chunk");
}

/** Join WAV files that share one sample format into a single WAV file. */
export function concatWavFiles(files: Uint8Array[]): Uint8Array {
  if (files.length === 0) throw new Error("No audio to join");
  if (files.length === 1) return files[0];
  const parts = files.map(parseWav);
  const fmt = parts[0].fmt;
  for (const p of parts) {
    if (p.fmt.length !== fmt.length || p.fmt.some((b, i) => b !== fmt[i])) {
      throw new Error("Cannot join WAV pieces with different sample formats");
    }
  }
  const dataLength = parts.reduce((n, p) => n + p.data.length, 0);
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + dataLength);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < 4; i++) out[offset + i] = s.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  let offset = 20 + fmt.length;
  writeAscii(offset, "data");
  view.setUint32(offset + 4, dataLength, true);
  offset += 8;
  for (const p of parts) {
    out.set(p.data, offset);
    offset += p.data.length;
  }
  return out;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GroqSpeechOptions {
  text: string;
  voice?: string | null;
  apiKey?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

export interface GroqSpeechResult {
  audio: Uint8Array;
  mimeType: "audio/wav";
  voice: GroqTtsVoice;
  pieces: number;
}

export class GroqSpeechError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GroqSpeechError";
    this.status = status;
  }
}

async function synthesizePiece(
  input: string,
  voice: GroqTtsVoice,
  apiKey: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const res = await fetchImpl(GROQ_SPEECH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_TTS_MODEL,
      voice,
      input,
      response_format: "wav",
    }),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch {
      // non-JSON error body
    }
    throw new GroqSpeechError(
      res.status,
      `Groq speech failed (${res.status})${detail ? `: ${detail}` : ""}`
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Synthesize `text` with Groq Orpheus, splitting and re-joining as needed. */
export async function generateGroqSpeech({
  text,
  voice,
  apiKey = process.env.GROQ_API_KEY?.trim(),
  fetchImpl = fetch,
  signal,
}: GroqSpeechOptions): Promise<GroqSpeechResult> {
  if (!apiKey) throw new GroqSpeechError(503, "Groq API key not configured");
  const pieces = splitTextForTts(text);
  if (pieces.length === 0) throw new GroqSpeechError(400, "'text' is required");
  const resolvedVoice = resolveGroqTtsVoice(voice);

  const results: Uint8Array[] = new Array(pieces.length);
  for (let i = 0; i < pieces.length; i += GROQ_TTS_CONCURRENCY) {
    const batch = pieces.slice(i, i + GROQ_TTS_CONCURRENCY);
    const audio = await Promise.all(
      batch.map((p) => synthesizePiece(p, resolvedVoice, apiKey, fetchImpl, signal))
    );
    audio.forEach((a, j) => {
      results[i + j] = a;
    });
  }

  return {
    audio: concatWavFiles(results),
    mimeType: "audio/wav",
    voice: resolvedVoice,
    pieces: pieces.length,
  };
}
