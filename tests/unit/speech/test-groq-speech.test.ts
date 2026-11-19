import { describe, expect, test } from "bun:test";
import {
  concatWavFiles,
  DEFAULT_GROQ_TTS_VOICE,
  generateGroqSpeech,
  GROQ_SPEECH_URL,
  GROQ_TTS_MAX_INPUT_CHARS,
  GROQ_TTS_MODEL,
  GROQ_TTS_VOICES,
  GroqSpeechError,
  parseWav,
  resolveGroqTtsVoice,
  splitTextForTts,
} from "../../../api/_utils/groq-speech";
import { GROQ_TTS_VOICES as GROQ_TTS_VOICE_OPTIONS } from "../../../src/apps/control-panels/components/control-panels-app/ttsVoiceOptions";

/** Minimal 16-bit mono PCM WAV with the given sample bytes. */
function makeWav(samples: number[], { sampleRate = 48000, dataSize }: { sampleRate?: number; dataSize?: number } = {}): Uint8Array {
  const data = new Uint8Array(samples);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataSize ?? data.length, true);
  out.set(data, 44);
  return out;
}

describe("splitTextForTts", () => {
  test("keeps short text as one piece and normalizes whitespace", () => {
    expect(splitTextForTts("  hello \n  world  ")).toEqual(["hello world"]);
    expect(splitTextForTts("   ")).toEqual([]);
  });

  test("never exceeds the Orpheus 200-character limit", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} has a few words in it.`).join(" ");
    const pieces = splitTextForTts(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(GROQ_TTS_MAX_INPUT_CHARS);
    expect(pieces.join(" ")).toBe(text);
  });

  test("prefers sentence ends, then clauses, then spaces", () => {
    const a = "A".repeat(120) + ". " + "B".repeat(120) + ".";
    expect(splitTextForTts(a)).toEqual(["A".repeat(120) + ".", "B".repeat(120) + "."]);
    const b = "word ".repeat(30) + "clause, " + "more ".repeat(30);
    for (const p of splitTextForTts(b)) expect(p.length).toBeLessThanOrEqual(200);
  });

  test("hard-splits a single unbroken run", () => {
    const pieces = splitTextForTts("x".repeat(450));
    expect(pieces.map((p) => p.length)).toEqual([200, 200, 50]);
  });
});

describe("WAV joining", () => {
  test("concatenates sample data under one header", () => {
    const joined = concatWavFiles([makeWav([1, 2, 3, 4]), makeWav([5, 6])]);
    const { data } = parseWav(joined);
    expect([...data]).toEqual([1, 2, 3, 4, 5, 6]);
    const v = new DataView(joined.buffer);
    expect(v.getUint32(4, true)).toBe(joined.length - 8);
  });

  test("accepts streamed WAVs with a placeholder data size", () => {
    const streamed = makeWav([9, 9], { dataSize: 0xffffffff });
    expect([...parseWav(streamed).data]).toEqual([9, 9]);
  });

  test("refuses pieces with different sample formats", () => {
    expect(() =>
      concatWavFiles([makeWav([1, 2]), makeWav([3, 4], { sampleRate: 24000 })])
    ).toThrow(/different sample formats/);
  });

  test("refuses non-WAV audio", () => {
    expect(() => parseWav(new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/not a WAV/);
  });
});

describe("generateGroqSpeech", () => {
  test("sends each piece to Groq Orpheus and joins the audio in order", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
      const index = calls.length;
      return new Response(makeWav([index, index]), { headers: { "content-type": "audio/wav" } });
    };
    const text = "First sentence here. ".repeat(20).trim();
    const result = await generateGroqSpeech({ text, voice: "hannah", apiKey: "gsk_test", fetchImpl });

    expect(calls.length).toBe(result.pieces);
    expect(result.pieces).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.url).toBe(GROQ_SPEECH_URL);
      expect(c.auth).toBe("Bearer gsk_test");
      expect(c.body.model).toBe(GROQ_TTS_MODEL);
      expect(c.body.voice).toBe("hannah");
      expect(c.body.response_format).toBe("wav");
      expect(String(c.body.input).length).toBeLessThanOrEqual(200);
    }
    expect(result.mimeType).toBe("audio/wav");
    expect([...parseWav(result.audio).data].length).toBe(result.pieces * 2);
  });

  test("maps unknown and OpenAI voice names to the default Orpheus voice", () => {
    expect(resolveGroqTtsVoice("alloy")).toBe(DEFAULT_GROQ_TTS_VOICE);
    expect(resolveGroqTtsVoice(null)).toBe(DEFAULT_GROQ_TTS_VOICE);
    expect(resolveGroqTtsVoice("daniel")).toBe("daniel");
  });

  test("surfaces Groq errors with their status", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "model terms not accepted" } }), { status: 400 });
    const err = await generateGroqSpeech({ text: "hi", apiKey: "k", fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(GroqSpeechError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("model terms not accepted");
  });

  test("reports a missing key as 503", async () => {
    const err = await generateGroqSpeech({ text: "hi", apiKey: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(GroqSpeechError);
    expect(err.status).toBe(503);
  });

  test("settings picker offers exactly the server's voices", () => {
    expect(GROQ_TTS_VOICE_OPTIONS.map((v) => v.value).sort()).toEqual([...GROQ_TTS_VOICES].sort());
  });
});
