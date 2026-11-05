// Preloaded by every `bun test` run (see bunfig.toml) to isolate data and Docker discovery.
// Child fixtures must pass an explicit env copy or configure their own paths: Bun's
// parallel workers do not automatically export process.env mutations to child processes.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "kintsugi-test-data-"));
process.env.KINTSUGI_DATA_DIR = dataDir;
// Data paths alone do not isolate Docker discovery or subscription-CLI cleanup.
// Reuse the existing namespace boundary so unit tests cannot find live workspaces.
process.env.KINTSUGI_NAMESPACE = basename(dataDir);
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
