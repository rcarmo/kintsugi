import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultDictationModel, readDictationModel, writeDictationModel } from "../../src/server/models.ts";
import { dictationSettingsContribution } from "../../src/server/settings.ts";

let directory: string | undefined;

async function useTemporaryDataDirectory(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "kintsugi-transcription-settings-"));
  process.env.KINTSUGI_DATA_DIR = directory;
  return directory;
}

afterEach(async () => {
  delete process.env.KINTSUGI_DATA_DIR;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Dictation settings", () => {
  test("defaults to Nemotron English and preserves an explicit multilingual selection", async () => {
    await useTemporaryDataDirectory();
    expect(await readDictationModel()).toBe("nemotron-en");
    await writeDictationModel("nemotron-3.5");
    expect(await readDictationModel()).toBe("nemotron-3.5");
  });

  test.each(["parakeet-tdt", "parakeet-ctc"])("uses the default for retired %s selections", async (model) => {
    const root = await useTemporaryDataDirectory();
    await writeFile(join(root, "transcription.json"), JSON.stringify({ model }));
    expect(await readDictationModel()).toBe(defaultDictationModel);
  });

  test("preserves existing saved model selections and unrelated settings", async () => {
    const root = await useTemporaryDataDirectory();
    await writeFile(join(root, "transcription.json"), JSON.stringify({ model: "nemotron-3.5", retained: true }));
    expect(await readDictationModel()).toBe("nemotron-3.5");
    await writeDictationModel("nemotron-en");
    expect(await Bun.file(join(root, "transcription.json")).json()).toEqual({ model: "nemotron-en", retained: true });
  });

  test("rejects malformed persisted settings", async () => {
    const root = await useTemporaryDataDirectory();
    await writeFile(join(root, "transcription.json"), JSON.stringify({ model: "unknown" }));
    expect(readDictationModel()).rejects.toThrow();
  });

  test("updates the selected server model", async () => {
    await useTemporaryDataDirectory();
    const form = new FormData();
    form.set("model", "nemotron-3.5");
    const response = await dictationSettingsContribution.handleAction!({
      request: new Request("http://kintsugi/settings/dictation-model", { method: "POST", body: form }),
      url: new URL("http://kintsugi/settings/dictation-model"),
    });
    expect(response?.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(await readDictationModel()).toBe("nemotron-3.5");
  });
});
