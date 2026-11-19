import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Model for server-side text jobs that are not the user-facing chat model:
 * song lyric translation, furigana, and soramimi.
 *
 * Groq is used whenever GROQ_API_KEY is set; OpenAI is the fallback so an
 * OpenAI-only deployment keeps working unchanged.
 */
export const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
export const OPENAI_TEXT_MODEL = "gpt-5.4";

export type TextModelProvider = "groq" | "openai";

export function resolveTextModelProvider(
  env: NodeJS.ProcessEnv = process.env
): TextModelProvider {
  return env.GROQ_API_KEY?.trim() ? "groq" : "openai";
}

export function getTextJobModel(
  env: NodeJS.ProcessEnv = process.env
): LanguageModel {
  return resolveTextModelProvider(env) === "groq"
    ? groq(GROQ_TEXT_MODEL)
    : openai(OPENAI_TEXT_MODEL);
}

/**
 * Provider options to pass alongside getTextJobModel(). gpt-oss is a
 * reasoning model; these jobs are line-by-line transforms where low effort
 * keeps latency down, and hidden reasoning never reaches the text stream.
 */
export function getTextJobProviderOptions(
  env: NodeJS.ProcessEnv = process.env
) {
  return resolveTextModelProvider(env) === "groq"
    ? { groq: { reasoningEffort: "low" as const } }
    : undefined;
}
