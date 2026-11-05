import { beforeEach, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as models from "../../src/server/pi-config-models.ts";
import { handleModelsRequest } from "../../src/server/models-panel.ts";

let directory: string | undefined;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.KINTSUGI_DATA_DIR;
  directory = await mkdtemp(join(tmpdir(), "kintsugi-oauth-lifecycle-"));
  process.env.KINTSUGI_DATA_DIR = directory;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previous;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a new provider login cancels its abandoned pending attempt instead of queuing behind it", async () => {
  const signals: AbortSignal[] = [];
  const rejectLogins: Array<(error: Error) => void> = [];
  const login = spyOn(models, "loginPiOAuthProvider").mockImplementation(async (_provider, interaction) => {
    signals.push(interaction.signal!);
    interaction.notify?.({ type: "auth_url", url: "https://example.com/sign-in" });
    return new Promise<void>((_resolve, reject) => {
      rejectLogins.push(reject);
      interaction.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
  });
  try {
    const url = new URL("http://localhost/models/providers/openai-codex/connect");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handleModelsRequest(new Request(url, { method: "POST" }), url, async () => "", async () => new Response());
      expect(response?.status).toBe(200);
    }
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  } finally {
    for (const reject of rejectLogins) reject(new Error("Test finished"));
    await Bun.sleep(0);
    login.mockRestore();
  }
});

test.each(["pending", "failed"])("switching a %s Codex attempt to browser auth cancels device polling", async (status) => {
  const signals: AbortSignal[] = [];
  const methods: string[] = [];
  const rejectLogins: Array<(error: Error) => void> = [];
  let manualInput: Promise<string> | undefined;
  const login = spyOn(models, "loginPiOAuthProvider").mockImplementation(async (_provider, interaction) => {
    signals.push(interaction.signal!);
    const method = await interaction.prompt({
      type: "select", message: "Sign in", options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });
    methods.push(method);
    if (method === "device_code") {
      if (status === "failed") throw new Error("Device login unavailable");
      interaction.notify?.({ type: "device_code", userCode: "TEST-CODE", verificationUri: "https://example.com/device", intervalSeconds: 3, expiresInSeconds: 600 });
    } else {
      interaction.notify?.({ type: "auth_url", url: "https://example.com/sign-in?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback" });
      manualInput = interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
      await manualInput;
    }
    return new Promise<void>((_resolve, reject) => {
      rejectLogins.push(reject);
      interaction.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
  });
  const post = async (path: string, body?: URLSearchParams) => {
    const url = new URL(path, "http://localhost");
    return (await handleModelsRequest(new Request(url, { method: "POST", body }), url, async () => "", async () => new Response()))!;
  };
  // Discover the session's operation URLs from the server response, without
  // asserting presentation. The assertions below cover the login protocol.
  const sessionPath = (html: string) => html.match(/\/models\/providers\/openai-codex\/oauth\/[^/"?]+/)![0];
  try {
    const first = await post("/models/providers/openai-codex/connect?host=settings");
    const firstPath = sessionPath(await first.text());
    const switched = await post(`${firstPath}/browser`);
    expect(switched.status).toBe(200);
    const browserPath = sessionPath(await switched.text());
    expect(methods).toEqual(["device_code", "browser"]);
    expect(signals[0]!.aborted).toBe(status === "pending");
    expect(signals[1]!.aborted).toBe(false);
    expect((await post(`${browserPath}/browser`)).status).toBe(409);
    expect(methods).toEqual(["device_code", "browser"]);
    expect((await post(`${firstPath}/status`)).status).toBe(410);
    const redirect = "http://localhost:1455/auth/callback?code=example&state=example";
    await post(`${browserPath}/prompt`, new URLSearchParams({ value: redirect }));
    expect(await manualInput).toBe(redirect);
    await post(`${browserPath}/cancel`);
    expect(signals[1]!.aborted).toBe(true);
  } finally {
    for (const reject of rejectLogins) reject(new Error("Test finished"));
    await Bun.sleep(0);
    login.mockRestore();
  }
});
