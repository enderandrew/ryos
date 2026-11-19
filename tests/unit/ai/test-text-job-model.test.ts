import { describe, expect, test } from "bun:test";
import {
  getTextJobModel,
  getTextJobProviderOptions,
  GROQ_TEXT_MODEL,
  OPENAI_TEXT_MODEL,
  resolveTextModelProvider,
} from "../../../api/_utils/_text-model";

type ModelLike = { provider: string; modelId: string };

describe("text job model (lyrics translation, furigana, soramimi)", () => {
  test("uses Groq gpt-oss-120b when GROQ_API_KEY is set", () => {
    const env = { GROQ_API_KEY: "gsk", OPENAI_API_KEY: "sk" };
    expect(resolveTextModelProvider(env)).toBe("groq");
    const model = getTextJobModel(env) as unknown as ModelLike;
    expect(model.provider).toContain("groq");
    expect(model.modelId).toBe(GROQ_TEXT_MODEL);
    expect(getTextJobProviderOptions(env)).toEqual({
      groq: { reasoningEffort: "low" },
    });
  });

  test("falls back to OpenAI without a Groq key", () => {
    const env = { OPENAI_API_KEY: "sk", GROQ_API_KEY: "  " };
    expect(resolveTextModelProvider(env)).toBe("openai");
    const model = getTextJobModel(env) as unknown as ModelLike;
    expect(model.provider).toContain("openai");
    expect(model.modelId).toBe(OPENAI_TEXT_MODEL);
    expect(getTextJobProviderOptions(env)).toBeUndefined();
  });
});
