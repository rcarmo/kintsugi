/** Kintsugi names take precedence; existing installation settings remain readable. */
export function kintsugiEnv(name: string): string | undefined {
  return process.env[`KINTSUGI_${name}`] ?? process.env[`ATELIER_${name}`];
}
