import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureLeafCertificate, ensureMitmCa } from "../src/egress/mitm-ca.ts";

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-mitm-ca-test-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function openssl(args: string[]): string {
  const result = Bun.spawnSync(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function certificateExpiration(certPath: string): number {
  const output = openssl(["x509", "-enddate", "-noout", "-in", certPath]);
  return Date.parse(output.slice("notAfter=".length));
}

async function caAndLeaf() {
  const ca = await ensureMitmCa({ kintsugiDataDir: dataDir, dockerHostKintsugiDataDir: dataDir, dockerBridgeHost: "127.0.0.1" });
  const leaf = await ensureLeafCertificate(ca, "api.github.com");
  return { ca, leaf };
}

describe("MITM leaf certificates", () => {
  test("are valid for seven days", async () => {
    const { leaf } = await caAndLeaf();
    const remaining = certificateExpiration(leaf.certPath) - Date.now();
    expect(remaining).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  test("renew when less than 24 hours remain", async () => {
    const { ca, leaf } = await caAndLeaf();
    const csrPath = join(dataDir, "near-expiry.csr");
    const extPath = join(dataDir, "near-expiry.ext");
    await writeFile(extPath, "subjectAltName=DNS:api.github.com\n");
    openssl(["req", "-new", "-key", leaf.keyPath, "-subj", "/CN=api.github.com", "-out", csrPath]);
    openssl(["x509", "-req", "-in", csrPath, "-CA", ca.certPath, "-CAkey", ca.keyPath, "-days", "1", "-sha256", "-extfile", extPath, "-out", leaf.certPath]);
    const nearExpiryFingerprint = openssl(["x509", "-fingerprint", "-sha256", "-noout", "-in", leaf.certPath]);

    const renewed = await ensureLeafCertificate(ca, "api.github.com");
    const remaining = certificateExpiration(renewed.certPath) - Date.now();
    expect(remaining).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(openssl(["x509", "-fingerprint", "-sha256", "-noout", "-in", renewed.certPath])).not.toBe(nearExpiryFingerprint);
  });

  test("verifies an exact DNS name longer than the certificate common-name limit", async () => {
    const ca = await ensureMitmCa({ kintsugiDataDir: dataDir, dockerHostKintsugiDataDir: dataDir, dockerBridgeHost: "127.0.0.1" });
    const hostname = `${"a".repeat(49)}.example.invalid`;
    const leaf = await ensureLeafCertificate(ca, hostname);
    expect(openssl(["x509", "-noout", "-checkhost", hostname, "-in", leaf.certPath])).toBe(`Hostname ${hostname} does match certificate`);
    expect(openssl(["x509", "-noout", "-ext", "subjectAltName", "-in", leaf.certPath])).toContain(`DNS:${hostname}`);
  });

  test.skipIf(process.platform !== "linux")("create a leaf when the CA directory is on a different filesystem from the system temporary directory", async () => {
    const crossDeviceDataDir = await mkdtemp("/dev/shm/kintsugi-mitm-ca-test-");
    try {
      const ca = await ensureMitmCa({ kintsugiDataDir: crossDeviceDataDir, dockerHostKintsugiDataDir: crossDeviceDataDir, dockerBridgeHost: "127.0.0.1" });
      const leaf = await ensureLeafCertificate(ca, "api.github.com");
      expect(certificateExpiration(leaf.certPath) - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    } finally {
      await rm(crossDeviceDataDir, { recursive: true, force: true });
    }
  });
});
