import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceRemoteConfig } from "./config.js";
import { synthesizeSpeech, transcribeAudio } from "./openai.js";

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
});
