export {
  createKintsugiEventBus,
  type KintsugiEventBus,
  type KintsugiEventMap,
} from "./events.ts";

export {
  requireDocker,
  runDocker,
  runDockerBuffer,
  withManagedDockerCommand,
  type CommandInput,
  type CommandResult,
} from "./docker.ts";

export {
  KintsugiCoreError,
  invalidArguments,
} from "./errors.ts";

export {
  isJsonObject,
  readJsonObject,
  requestAcceptsJson,
} from "./json-request.ts";

export {
  type JsonObject,
  type JsonValue,
} from "./json.ts";

export {
  acquireFileLock,
  createProcessFileLock,
} from "./file-lock.ts";

export {
  shellQuote,
} from "./shell.ts";

export { isNotFoundError, readTextIfExists, writeFileAtomic, writeJsonAtomic } from "./fs.ts";

export {
  kintsugiDataPath,
  dockerHostKintsugiDataPath,
  getKintsugiRuntimeContext,
  type KintsugiRuntimeContext,
} from "./runtime-context.ts";

export {
  GitHostingRateLimitError,
  createGitHostingCache,
  gitCredentialHelperShellBody,
  gitHostingCredentialPath,
  parseGitHostingResponse,
  readGitHostingCredentialFile,
  removeGitHostingCredentialFile,
  writeGitHostingCredentialFile,
  type GitHostingConnectForm,
  type GitHostingCredential,
  type GitHostingIdentity,
  type GitHostingProvider,
  type GitHostingRepository,
  type GitHostingRepositorySearch,
  type GitHostingValidation,
} from "./git-hosting.ts";

export { kintsugiEnv } from "./environment.ts";
export { createKeyedOperationQueue } from "./keyed-operation-queue.ts";
export { workloadCgroupArgs, workloadCommand, workspaceResourceControlAvailable } from "./workload-resources.ts";

export { commandSignal, withCommandSignal, waitForCommand, runCommand, killCommandGroup } from "./command-scope.ts";

export { readStorageDriver, storageContainerdConfig, assertStorageSupport, storageDriversLabel, type StorageDriver } from "./storage-driver.ts";

export { collectUnpushedCommits, type UnpushedCommit } from "./git-delete-safety.ts";

export {
  clearGitHubToken,
  discoverGitHubToken,
  gitHubCredentialHelperCommand,
  gitHubCredentialHelperShellBody,
  hasGitHubToken,
  setGitHubToken,
} from "./github-token.ts";

export { buildGoProgram, runGoTests } from "./go.ts";
