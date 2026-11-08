/** Kintsugi's app/System contract, independent of image tags and upstream's version numbers. */
export const systemVersion = 4;
/** Optional feature gate; existing app functions still require only version zero. */
export const listedHostsSystemVersion = 2;
/** App capability for reading persisted listed-host policy snapshots. */
export const networkPolicyVersion = 2;
export const networkPolicyVersionLabel = "org.kintsugi.network-policy-version";
/** Reader for persisted workspace resource allocations; independent of network policy format. */
export const resourcePolicyVersion = 2;
export const resourcePolicyVersionLabel = "org.kintsugi.resource-policy-version";
export const resourceControlSystemVersion = 3;
export const workspaceMemoryPolicySystemVersion = 4;
/** Keep zero for the support release. Raise only after the corresponding System support is published. */
export const requiredSystemVersion = 0;
export const systemVersionLabel = "org.kintsugi.system-version";
export const requiredSystemVersionLabel = "org.kintsugi.required-system-version";

// 0: existing unversioned Kintsugi images.
// 1: compatibility status, image labels and enforcement.
// 2: listed-host network policies, pinned destinations and protected TCP port grants.
// 3: persistent workspace resource admission and OOM circuit breaking.
// 4: installation-wide hard workspace RAM policy.
const maximumVersion = 2_147_483_647;

export function parseSystemVersion(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9]\d{0,9})$/.test(value) || Number(value) > maximumVersion) throw new Error("Invalid System compatibility version");
  return Number(value);
}

/** Both versions are validated at their I/O boundaries; missing image labels have version zero. */
export function assertSystemCompatible(available: number, required: number): void {
  if (required > available) throw new Error(`This app needs installation compatibility version ${required}, but the selected installation provides ${available}. Run the matching installer to update both components.`);
}

export function assertImagePairCompatible(appLabels: Readonly<Record<string, string>> | null | undefined, systemLabels: Readonly<Record<string, string>> | null | undefined): void {
  assertSystemCompatible(parseSystemVersion(systemLabels?.[systemVersionLabel]), parseSystemVersion(appLabels?.[requiredSystemVersionLabel]));
}
