import OpenAI from "openai";
import { toFile } from "openai/uploads";

/** Unset client `ttsModel` (`null` / omitted) uses this provider (ElevenLabs / Ryo PVC). Stored OpenAI stays OpenAI. */
export const DEFAULT_TTS_MODEL = "elevenlabs";
export const DEFAULT_OPENAI_TTS_VOICE = "alloy";
export const DEFAULT_OPENAI_TTS_SPEED = 1.1;
/**
 * Speech-to-text goes to Groq when GROQ_API_KEY is set (Groq's endpoint is
 * OpenAI-compatible, so the same SDK talks to it), otherwise to OpenAI.
 * whisper-large-v3 is Groq-hosted; OpenAI only serves whisper-1.
 */
export const GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3";
export const OPENAI_TRANSCRIPTION_MODEL = "whisper-1";

export type TranscriptionProvider = "groq" | "openai";

export interface TranscriptionTarget {
  provider: TranscriptionProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
}

/** Groq first, OpenAI as the alternative; null when neither key is set. */
export function resolveTranscriptionTarget(
  env: NodeJS.ProcessEnv = process.env
): TranscriptionTarget | null {
  const groqKey = env.GROQ_API_KEY?.trim();
  if (groqKey) {
    return {
      provider: "groq",
      apiKey: groqKey,
      baseURL: GROQ_OPENAI_BASE_URL,
      model: DEFAULT_TRANSCRIPTION_MODEL,
    };
  }
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      model: OPENAI_TRANSCRIPTION_MODEL,
    };
  }
  return null;
}

export class TranscriptionNotConfiguredError extends Error {
  constructor() {
    super("Transcription is not configured: set GROQ_API_KEY or OPENAI_API_KEY");
    this.name = "TranscriptionNotConfiguredError";
  }
}

export const DEFAULT_ELEVENLABS_VOICE_ID = "OHP6tMHkOsRKrsDdbPah"; // Ryo PVC
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5"; // 2.5 turbo
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";
export const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.3,
  similarity_boost: 0.8,
  use_speaker_boost: true,
  speed: 1.1,
} as const;

export type ElevenLabsOutputFormat =
  | "mp3_44100_128"
  | "mp3_22050_32"
  | "pcm_16000"
  | "pcm_22050"
  | "pcm_24000"
  | "pcm_44100"
  | "ulaw_8000";

export interface ElevenLabsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

const transcriptionClients = new Map<string, OpenAI>();

function getTranscriptionClient(target: TranscriptionTarget): OpenAI {
  const cacheKey = `${target.provider}:${target.apiKey}`;
  let client = transcriptionClients.get(cacheKey);
  if (!client) {
    client = new OpenAI({ apiKey: target.apiKey, baseURL: target.baseURL });
    transcriptionClients.set(cacheKey, client);
  }
  return client;
}

type TranscribeAudioBufferDeps = {
  /** Environment to resolve the provider from (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  toFileImpl?: typeof toFile;
  createTranscription?: (options: {
    file: Awaited<ReturnType<typeof toFile>>;
    model: string;
  }) => Promise<{ text: string }>;
};

export async function transcribeAudioBuffer({
  buffer,
  fileName,
  mimeType,
  model,
  deps = {},
}: {
  buffer: Uint8Array | Buffer | ArrayBuffer;
  fileName: string;
  mimeType: string;
  model?: string;
  deps?: TranscribeAudioBufferDeps;
}): Promise<string> {
  const toFileImpl = deps.toFileImpl ?? toFile;
  const target = resolveTranscriptionTarget(deps.env ?? process.env);
  let createTranscription = deps.createTranscription;
  if (!createTranscription) {
    if (!target) throw new TranscriptionNotConfiguredError();
    const client = getTranscriptionClient(target);
    createTranscription = (options) => client.audio.transcriptions.create(options);
  }

  const file = await toFileImpl(buffer, fileName, { type: mimeType });
  const transcription = await createTranscription({
    file,
    model: model ?? target?.model ?? DEFAULT_TRANSCRIPTION_MODEL,
  });

  return transcription.text;
}

/** Lowest-latency ElevenLabs model; used when a caller streams speech. */
export const STREAMING_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";

export function elevenLabsMimeType(outputFormat: ElevenLabsOutputFormat): string {
  if (outputFormat.startsWith("pcm_")) return "audio/pcm";
  if (outputFormat.startsWith("ulaw_")) return "audio/basic";
  return "audio/mpeg";
}

type ElevenLabsSpeechOptions = {
  text: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: ElevenLabsOutputFormat;
  voiceSettings?: ElevenLabsVoiceSettings;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Opens an ElevenLabs stream and returns the upstream body as it arrives, so
 * the caller can start playback before the whole clip is synthesized.
 */
export async function streamElevenLabsSpeech({
  text,
  voiceId = DEFAULT_ELEVENLABS_VOICE_ID,
  modelId = STREAMING_ELEVENLABS_MODEL_ID,
  outputFormat = DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
  voiceSettings = DEFAULT_ELEVENLABS_VOICE_SETTINGS,
  apiKey = process.env.ELEVENLABS_API_KEY,
  fetchImpl = fetch,
}: ElevenLabsSpeechOptions): Promise<ReadableStream<Uint8Array>> {
  if (!apiKey) {
    throw new Error("ElevenLabs API key not configured");
  }

  // ElevenLabs reads output_format from the query string.
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`);
  url.searchParams.set("output_format", outputFormat);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      Accept: elevenLabsMimeType(outputFormat),
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: voiceSettings,
    }),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
  }

  return response.body;
}

export async function generateElevenLabsSpeech({
  text,
  voiceId = DEFAULT_ELEVENLABS_VOICE_ID,
  modelId = DEFAULT_ELEVENLABS_MODEL_ID,
  outputFormat = DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
  voiceSettings = DEFAULT_ELEVENLABS_VOICE_SETTINGS,
  apiKey = process.env.ELEVENLABS_API_KEY,
  fetchImpl = fetch,
}: ElevenLabsSpeechOptions): Promise<ArrayBuffer> {
  if (!apiKey) {
    throw new Error("ElevenLabs API key not configured");
  }

  const response = await fetchImpl(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        output_format: outputFormat,
        voice_settings: voiceSettings,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
  }

  return response.arrayBuffer();
}
