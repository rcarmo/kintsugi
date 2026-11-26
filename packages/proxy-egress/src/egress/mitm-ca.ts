import { existsSync } from "node:fs";
import net from "node:net";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireFileLock, kintsugiDataPath, getKintsugiRuntimeContext, type KintsugiRuntimeContext } from "@kintsugi/core";

export type MitmCa = { dir: string; certPath: string; keyPath: string; leafDir: string };
type LeafCertificate = { certPath: string; keyPath: string; renewAt: number };

const leafCertificateRenewalWindowMs = 24 * 60 * 60 * 1000;
const leafCertificateLifetimeDays = 7;

export async function ensureMitmCa(context?: KintsugiRuntimeContext): Promise<MitmCa> {
  const runtime = context ?? getKintsugiRuntimeContext();
  const dir = kintsugiDataPath(runtime, "proxy-ca");
  const certPath = join(dir, "kintsugi-mitm-ca.pem");
  const keyPath = join(dir, "kintsugi-mitm-ca-key.pem");
  const leafDir = join(dir, "leaf");
  await mkdir(leafDir, { recursive: true, mode: 0o700 });
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    await runOpenSsl([
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1825", "-nodes",
      "-subj", "/CN=Kintsugi Local Workspace MITM CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout", keyPath, "-out", certPath,
    ]);
    await chmod(keyPath, 0o600);
    await chmod(certPath, 0o644);
  }
  return { dir, certPath, keyPath, leafDir };
}

export async function ensureLeafCertificate(ca: MitmCa, hostnames: string | readonly string[]): Promise<LeafCertificate> {
  const names = (Array.isArray(hostnames) ? [...hostnames] : [hostnames]).map(hostname => hostname.toLowerCase());
  if (!names.length) throw new Error("leaf certificate needs at least one hostname");
  const safeName = names[0]!.replace(/[^a-z0-9_.-]/g, "_");
  const certPath = join(ca.leafDir, `${safeName}.pem`);
  const keyPath = join(ca.leafDir, `${safeName}-key.pem`);
  const release = await acquireFileLock(join(ca.leafDir, `${safeName}.lock`), "certificate");
  let tmp = "";
  try {
    if (existsSync(certPath) && existsSync(keyPath)) {
      const renewAt = await certificateRenewalTime(certPath);
      if (Date.now() < renewAt) return { certPath, keyPath, renewAt };
    }

    tmp = await mkdtemp(join(ca.leafDir, ".kintsugi-leaf-"));
    const csr = join(tmp, "leaf.csr");
    const ext = join(tmp, "leaf.ext");
    const temporaryCertPath = join(tmp, "leaf.pem");
    const temporaryKeyPath = join(tmp, "leaf-key.pem");
    const subjectAltName = names.map(name => net.isIP(name) ? `IP:${name}` : `DNS:${name}`).join(", ");
    await writeFile(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${subjectAltName}\n`);
    // X.509 limits the common name to 64 characters; host verification uses the SAN above.
    const commonName = names[0]!.length <= 64 ? names[0]! : "Kintsugi Workspace";
    await runOpenSsl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${commonName}`, "-keyout", temporaryKeyPath, "-out", csr]);
    await runOpenSsl(["x509", "-req", "-in", csr, "-CA", ca.certPath, "-CAkey", ca.keyPath, "-CAcreateserial", "-days", String(leafCertificateLifetimeDays), "-sha256", "-extfile", ext, "-out", temporaryCertPath]);
    await chmod(temporaryKeyPath, 0o600);
    await rename(temporaryKeyPath, keyPath);
    await rename(temporaryCertPath, certPath);
    return { certPath, keyPath, renewAt: await certificateRenewalTime(certPath) };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    await release();
  }
}

async function certificateRenewalTime(certPath: string): Promise<number> {
  const output = await runOpenSsl(["x509", "-enddate", "-noout", "-in", certPath]);
  const prefix = "notAfter=";
  if (!output.startsWith(prefix)) throw new Error(`unexpected openssl certificate end date: ${output}`);
  const expiresAt = Date.parse(output.slice(prefix.length));
  if (!Number.isFinite(expiresAt)) throw new Error(`invalid openssl certificate end date: ${output}`);
  return expiresAt - leafCertificateRenewalWindowMs;
}

function runOpenSsl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += String(chunk));
    child.stderr.on("data", (chunk) => stderr += String(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`openssl failed (${code}): ${stderr.trim()}`)));
  });
}
