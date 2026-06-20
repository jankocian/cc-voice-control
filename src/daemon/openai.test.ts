import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceRemoteConfig } from "./config.js";
import { MAX_TTS_INPUT_CHARS, splitForTts, synthesizeSpeech, transcribeAudio } from "./openai.js";

const baseConfig: VoiceRemoteConfig = {
  openaiApiKey: "sk-test",
  openaiVoice: "marin",
  ttsModel: "gpt-4o-mini-tts",
  sttModel: "gpt-4o-mini-transcribe",
  bridgeUrl: "https://voice.example.com"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transcribeAudio", () => {
  it("POSTs multipart form-data to the transcriptions endpoint and trims the text", async () => {
    const fetchMock = vi.fn(async () => new Response("  hello world \n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await transcribeAudio(baseConfig, new Uint8Array([1, 2, 3]), "audio/webm;codecs=opus");
    expect(text).toBe("hello world");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("response_format")).toBe("text");
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("audio/webm;codecs=opus");
  });

  it("includes a language hint when configured", async () => {
    const fetchMock = vi.fn(async () => new Response("hi", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await transcribeAudio({ ...baseConfig, language: "en" }, new Uint8Array([0]), "audio/mp4");
    const form = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(form.get("language")).toBe("en");
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key", { status: 401 }))
    );
    await expect(transcribeAudio(baseConfig, new Uint8Array([0]), "audio/webm")).rejects.toThrow(
      /OpenAI speech-to-text failed \(401\): bad key/
    );
  });
});

describe("synthesizeSpeech", () => {
  it("POSTs JSON to the speech endpoint and returns base64 mp3 as audio/mpeg", async () => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x10, 0x20]);
    const fetchMock = vi.fn(async () => new Response(audioBytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeSpeech(baseConfig, "Hello there");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.audioBase64).toBe(Buffer.from(audioBytes).toString("base64"));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "marin",
      input: "Hello there",
      response_format: "mp3"
    });
    expect(body.instructions).toBeUndefined();
  });

  it("prefers a per-session voice override over the config voice", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeSpeech(baseConfig, "hi", "cedar");
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.voice).toBe("cedar");
  });

  it("passes instructions when configured", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeSpeech({ ...baseConfig, ttsInstructions: "Speak calmly." }, "hi");
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.instructions).toBe("Speak calmly.");
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    await expect(synthesizeSpeech(baseConfig, "hi")).rejects.toThrow(/OpenAI text-to-speech failed \(500\): nope/);
  });

  it("makes exactly one call for a reply within the per-call limit", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeSpeech(baseConfig, "A".repeat(MAX_TTS_INPUT_CHARS));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("chunks a long reply into N calls and concatenates the mp3 buffers in order", async () => {
    // Two sentences, each at the limit, force exactly two chunks.
    const sentence = `${"A".repeat(MAX_TTS_INPUT_CHARS - 2)}. `;
    const text = sentence + sentence;
    expect(text.length).toBeGreaterThan(MAX_TTS_INPUT_CHARS);

    // Distinct mp3 byte sequences per call so we can assert ordering of the concatenation.
    let call = 0;
    const payloads = [new Uint8Array([0xaa, 0xbb]), new Uint8Array([0xcc, 0xdd, 0xee])];
    const fetchMock = vi.fn(async () => new Response(payloads[call++], { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeSpeech(baseConfig, text, "cedar");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Concatenation is the chunks in call order.
    const expected = Buffer.concat([Buffer.from(payloads[0]), Buffer.from(payloads[1])]);
    expect(result.audioBase64).toBe(expected.toString("base64"));
    expect(result.mimeType).toBe("audio/mpeg");

    // The voice override is carried on every chunk.
    for (const callArgs of fetchMock.mock.calls) {
      const body = JSON.parse((callArgs[1] as RequestInit).body as string);
      expect(body.voice).toBe("cedar");
      expect(body.input.length).toBeLessThanOrEqual(MAX_TTS_INPUT_CHARS);
    }
  });

  it("makes two calls when the reply is one character over the per-call limit", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // A single terminator-less run of limit+1 chars hard-splits into [limit, 1] → 2 calls.
    await synthesizeSpeech(baseConfig, "A".repeat(MAX_TTS_INPUT_CHARS + 1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("speaks the partial audio when a later chunk fails instead of dropping the whole reply", async () => {
    const sentence = `${"A".repeat(MAX_TTS_INPUT_CHARS - 2)}. `;
    const text = sentence + sentence; // two chunks

    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(new Uint8Array([0xaa, 0xbb]), { status: 200 })
        : new Response("rate limited", { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeSpeech(baseConfig, text);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Only the first chunk's bytes survive — partial speech beats the silence we'd get if a
    // single late failure threw away every already-synthesized chunk.
    expect(result.audioBase64).toBe(Buffer.from([0xaa, 0xbb]).toString("base64"));
  });

  it("throws when the very first chunk fails (nothing synthesized to fall back to)", async () => {
    const sentence = `${"A".repeat(MAX_TTS_INPUT_CHARS - 2)}. `;
    const text = sentence + sentence;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    await expect(synthesizeSpeech(baseConfig, text)).rejects.toThrow(/OpenAI text-to-speech failed \(500\)/);
  });
});

describe("splitForTts", () => {
  it("returns a single trimmed chunk for text under the limit", () => {
    expect(splitForTts("Hello world.", 100)).toEqual(["Hello world."]);
    expect(splitForTts("  padded.  ", 100)).toEqual(["padded."]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(splitForTts("", 100)).toEqual([]);
    expect(splitForTts("   \n\t ", 100)).toEqual([]);
  });

  it("splits multi-sentence text on boundaries into ≤limit chunks with no characters lost", () => {
    // Three ~40-char sentences; a 90-char limit packs two per chunk then one.
    const a = `${"a".repeat(38)}. `;
    const b = `${"b".repeat(38)}! `;
    const c = `${"c".repeat(38)}?`;
    const text = a + b + c;
    const chunks = splitForTts(text, 90);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(90);
    // Reassembling the trimmed chunks reproduces the trimmed source modulo edge whitespace.
    expect(chunks.join(" ")).toBe(text.trim());
    // Every original letter survives in order.
    expect(chunks.join("").replace(/[^abc]/g, "")).toBe(text.replace(/[^abc]/g, ""));
  });

  it("hard-splits a single sentence longer than the limit", () => {
    const text = "x".repeat(250);
    const chunks = splitForTts(text, 100);
    expect(chunks).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
    expect(chunks.join("")).toBe(text);
  });

  it("breaks on paragraph/newline boundaries too", () => {
    const text = `${"p".repeat(60)}\n\n${"q".repeat(60)}`;
    const chunks = splitForTts(text, 70);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(70);
  });
});
