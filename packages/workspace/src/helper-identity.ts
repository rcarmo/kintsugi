import { readFileSync } from "node:fs";
import { createHash, createPrivateKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { kintsugiEnv, createKeyedOperationQueue, getKintsugiRuntimeContext, kintsugiDataPath, readTextIfExists, runCommand, withCommandSignal } from "@kintsugi/core";

const serialize = createKeyedOperationQueue();
const identityScope = (id: string): string => `${kintsugiEnv("NAMESPACE") || "host"}\0${id}`;

export function assertWorkspaceHelperIdentityScope(id: string): void {
 if (readFileSync(join(workspaceHelperIdentityDirectory(id), "namespace"), "utf8") !== identityScope(id)) throw new Error("Workspace helper identity belongs to another namespace");
}

export function workspaceHelperIdentityDirectory(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error("Invalid workspace id");
  return kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "helper-identity");
}

/** Derive a distinct TLS key from the existing workspace gateway secret, without
 * exposing that secret to socket peers. The identity stays outside user mounts. */
export function ensureWorkspaceHelperIdentity(id: string): Promise<string> {
  const directory = workspaceHelperIdentityDirectory(id);
  return serialize(directory, () => withCommandSignal(new AbortController().signal, async () => {
    if (await readTextIfExists(join(directory, "cert.pem")) !== undefined) {
      assertWorkspaceHelperIdentityScope(id);
      await readFile(join(directory, "key.pem"));
      return directory;
    }
    const token = await readFile(kintsugiDataPath(getKintsugiRuntimeContext(), "workspaces", id, "gateway-token"));
    if (token.length < 32) throw new Error("Invalid workspace gateway credential");
    const seed = createHash("sha256").update("kintsugi workspace helper TLS\0").update(token).digest();
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), type: "pkcs8", format: "der" }).export({ type: "pkcs8", format: "pem" });
    await mkdir(join(directory, ".."), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(`${directory}.`);
    try {
      await writeFile(join(staging, "namespace"), identityScope(id), {mode: 0o600});
      await writeFile(join(staging, "key.pem"), key, { mode: 0o600 });
      const result = await runCommand(["openssl", "req", "-new", "-x509", "-key", join(staging, "key.pem"), "-out", join(staging, "cert.pem"), "-days", "3650", "-subj", "/CN=kintsugi-workspace-helper", "-addext", "subjectAltName=DNS:kintsugi-workspace-helper", "-addext", "extendedKeyUsage=serverAuth,clientAuth"]);
      if (result.exitCode !== 0) throw new Error(`Could not create workspace helper certificate: ${result.stderr}`);
      await rename(staging, directory);
      return directory;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }));
}
