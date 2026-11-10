import { expect, test } from "bun:test";

const installer = (await Bun.file(new URL("./install.sh", import.meta.url)).text()).replace("no_updater=0", "no_updater=1");

function run(options: { resourceDataVersion?: number; appResourceCompatibility?: string; rememberedLimits?: string; hostMemoryAvailable?: number; currentMemoryPercent?: string; resourceLimits?: string; hostMemory?: number; hostCpus?: number; networkDataVersion?: number; systemCompatibility?: string; appNetworkCompatibility?: string; hostUpdater?: boolean; systemd?: boolean; tmpfilesFails?: boolean; savedStorageDriver?: string; storageCompatible?: boolean; erofsMissing?: boolean; savedRepository?: string; savedHostname?: string; appPrepareFails?: boolean; savedRegistry?: boolean; rollbackAvailable?: boolean; installerCompatible?: boolean; promptRepository?: string; promptHostname?: string; systemState?: "restarting" | "exited"; portMappings?: string; nonRoot?: boolean; denySudo?: boolean; mac?: boolean; wsl?: boolean; installed?: boolean; old?: boolean; legacyAtelier?: boolean; legacyVolumeOnly?: boolean; legacyPreSystem?: boolean; legacyDownloadFails?: boolean; legacyDelegateFails?: boolean; pullFails?: boolean; pullDenied?: boolean; appFails?: boolean; retryUpdateRequest?: boolean; rejectUpdateRequest?: boolean; pendingHealth?: boolean; missingFilesystem?: boolean; loadable?: boolean; uninstallAnswer?: string; uninstallFails?: boolean; uninstallRequestFails?: boolean; inventoryFails?: boolean; volumeOnly?: boolean; volumeRemovalFails?: boolean; initiallyStopped?: boolean } = {}, args: string[] = []) {
  const pinned = `sha256:${"c".repeat(64)}`;
  const logPath = `/tmp/kintsugi-install-test-${crypto.randomUUID()}.log`;
  const mock = `
mktemp() { if [ "\${1:-}" = -d ]; then command mktemp "$@"; return; fi; if [[ "$*" == *atelier-legacy-uninstall* ]]; then echo "${logPath}.legacy"; else echo "${logPath}"; fi; }
curl() { printf 'CURL %s\\n' "$*" >&2; return ${options.legacyDownloadFails ? 22 : 0}; }
bash() { printf 'LEGACY BASH %s\\n' "$*" >&2; return ${options.legacyDelegateFails ? 1 : 0}; }
sleep() { command sleep 0.01; }
uname() { echo ${options.mac ? "Darwin" : "Linux"}; }
id() { echo ${options.mac || options.nonRoot ? 501 : 0}; }
sudo() {
  printf 'SUDO %s\\n' "$*" >&2
  if [ "${options.denySudo ? 1 : 0}" -eq 1 ]; then return 1; fi
  if [ "$1" = -n ]; then shift; fi
  "$@"
}
systemctl() { printf 'SYSTEMCTL %s\\n' "$*" >&2; printf 'SYSTEMCTL %s\\n' "$*" >> "${logPath}.host"; return ${options.systemd ? 0 : 1}; }
systemd-tmpfiles() { printf 'TMPFILES %s\\n' "$*" >> "${logPath}.host"; return ${options.tmpfilesFails ? 1 : 0}; }
install() {
  printf 'INSTALL %s\\n' "$*" >> "${logPath}.host"
  if [[ "$*" == *'/dev/stdin /etc/tmpfiles.d/kintsugi-updater.conf' ]]; then command tee "${logPath}.tmpfiles" >/dev/null; fi
}
mv() { printf 'MV %s\\n' "$*" >> "${logPath}.host"; }
tee() {
  if [ "$1" = /etc/systemd/system/kintsugi-updater.service ]; then command tee "${logPath}.unit"; else command tee "$@"; fi
}
rm() {
  case "$*" in
    *'/etc/tmpfiles.d/kintsugi-updater.conf'*|*'/var/lib/kintsugi-updater'*|*'/etc/modules-load.d/kintsugi-system.conf'*) printf 'REMOVE %s\\n' "$*" >> "${logPath}.host" ;;
    *) command rm "$@" ;;
  esac
}
awk() { if [[ "$*" == *MemAvailable* ]]; then echo ${options.hostMemoryAvailable ?? 17179869184}; else command awk "$@"; fi; }
module_loaded=0
container_present=${options.installed ? 1 : 0}
volume_present=${options.installed || options.volumeOnly ? 1 : 0}
grep() { if [[ "$*" == *microsoft* ]]; then return ${options.wsl ? 0 : 1}; fi; if [[ "$*" == *erofs* ]] && [ "${options.erofsMissing ? 1 : 0}" -eq 1 ]; then return 1; fi; [ "$module_loaded" -eq 1 ] || return ${options.missingFilesystem ? 1 : 0}; }
modprobe() {
  printf 'MODPROBE %s\\n' "$*" >&2
  module_loaded=1
  return ${options.missingFilesystem && !options.loadable ? 1 : 0};
}
mkdir() { :; }
docker() {
  printf 'DOCKER %s\\n' "$*" >&2
  printf 'DOCKER %s\\n' "$1 \${2:-}" >> "${logPath}.host"
  if [ "$1" = --config ]; then shift 2; fi
  case "$1 \${2:-}" in
    'container inspect')
      case "$3" in
        kintsugi-system) return ${options.installed ? 0 : 1} ;;
        kintsugi) return ${options.old ? 0 : 1} ;;
        atelier-system) return ${options.legacyAtelier ? 0 : 1} ;;
        atelier) return ${options.legacyPreSystem ? 0 : 1} ;;
      esac ;;
    'create '*) echo updater-extract; return 0 ;;
    'cp '*)
      if [[ "$2" == *'/usr/local/bin/bun' ]]; then printf '#!/bin/sh\\nexit 0\\n' > "$3";
      else printf '%s' '{"auths":{"ghcr.io":{"auth":"Zml4dHVyZTp0b2tlbg=="}}}' > "$3"; fi
      return 0 ;;
    'run --rm')
      if [[ "$*" == *' resource-limits '* ]]; then printf '%s\n' ${JSON.stringify(options.rememberedLimits ?? '')}; return 0; fi
      if [[ "$*" == *' resource-data-version '* ]]; then echo ${options.resourceDataVersion ?? 0}; return 0; fi
      if [[ "$*" == *' network-data-version '* ]]; then echo ${options.networkDataVersion ?? 0}; return 0; fi
      if [[ "$*" == *' rollback-plan '* ]]; then if [ "${options.rollbackAvailable === false ? 0 : 1}" -eq 0 ]; then return 1; fi; printf '%s\n%s\n%s\n' ${pinned} ${pinned} kintsugi-system; return 0; fi
      if [[ "$*" == *' auth-check '* ]]; then echo ${options.savedRegistry ? 1 : 0}; return 0; fi
      if [[ "$*" == *" plan "* ]]; then
        local -a arguments=("$@")
        local i source app system hostname
        for ((i=0;i<\${#arguments[@]};i++)); do
          if [ "\${arguments[i]}" = plan ]; then
            source="\${arguments[i+1]}"; app="\${arguments[i+2]}"; system="\${arguments[i+3]}"; hostname="\${arguments[i+4]}"; break
          fi
        done
        source="\${source:-${options.savedRepository ?? 'ghcr.io/rcarmo/kintsugi'}}"
        printf '%s\n%s\n%s\n' "\${system:-$source-system:latest}" "\${app:-$source:latest}" "\${hostname:-${options.savedHostname ?? 'kintsugi-system'}}"
      fi
      return 0 ;;
    'stats --no-stream') echo ${options.currentMemoryPercent ?? '0.00%'}; return 0 ;;
    'info --format') if [[ "$*" == *MemTotal* ]]; then echo ${options.hostMemory ?? 17179869184}; else echo ${options.hostCpus ?? 8}; fi; return 0 ;;
    'image inspect') if [[ "$*" == *'org.kintsugi.system-version'* ]]; then echo ${options.systemCompatibility ?? '0'}; elif [[ "$*" == *'deployment-config'* || "$*" == *'host-updater'* ]]; then echo 1; elif [[ "$*" == *'storage-drivers'* ]]; then echo ${options.storageCompatible === false ? 'erofs' : 'erofs,overlayfs'}; elif [[ "$*" == *'installer-config'* ]]; then echo ${options.installerCompatible === false ? 0 : 1}; elif [[ "$*" == *'{{.Id}}'* ]]; then echo ${pinned}; fi; return 0 ;;
    'pull '*)
      if [ "${options.pullDenied ? 1 : 0}" -eq 1 ]; then echo 'Error response from daemon: Head "https://ghcr.io/v2/rcarmo/kintsugi-system/manifests/latest": denied: denied' >&2; return 1; fi
      return ${options.pullFails ? 1 : 0} ;;
    'volume ls') if [[ "$*" == *'name=^atelier-system$'* ]]; then if [ "${options.legacyVolumeOnly ? 1 : 0}" -eq 1 ]; then echo atelier-system; fi; return 0; fi; if [ "$volume_present" -eq 1 ] && [ ! -e "${logPath}.volume-removed" ]; then echo kintsugi-system; fi; return 0 ;;
    'volume rm')
      if [ "${options.volumeRemovalFails ? 1 : 0}" -eq 1 ]; then return 1; fi
      touch "${logPath}.volume-removed"; return 0 ;;
    'ps -a') if [ "$container_present" -eq 1 ] && [ ! -e "${logPath}.container-removed" ]; then echo kintsugi-system; fi; return 0 ;;
    'rm kintsugi-system') touch "${logPath}.container-removed"; return 0 ;;
    'exec --user')
      if [[ "$*" == *http://supervisor/uninstall* ]]; then
        if [[ "$*" == *'method:"POST"'* ]]; then return ${options.uninstallRequestFails ? 1 : 0}; fi
        if [ "${options.inventoryFails ? 1 : 0}" -eq 1 ]; then return 2; fi
        printf '8\\n${"a".repeat(64)}\\n'; return 0
      fi
      if [[ "$*" == *3001/status* ]]; then
        printf '${options.uninstallFails ? "failed\\nvolume is in use" : "complete\\nManaged resources deleted"}\\n'; return 0
      fi ;;
    'exec kintsugi-system')
      if [[ "$*" == *'org.kintsugi.resource-policy-version'* ]]; then echo ${options.appResourceCompatibility ?? '0'}; return 0; fi
      if [[ "$*" == *'org.kintsugi.network-policy-version'* ]]; then echo ${options.appNetworkCompatibility ?? '0'}; return 0; fi
      if [[ "$*" == *"Cannot prepare the selected app"* ]]; then
        if [ "${options.appPrepareFails ? 1 : 0}" -eq 1 ]; then return 1; fi
        echo ${pinned}; return 0
      fi
      if [[ "$*" == *3001/update-channel* ]]; then
        if [ "${options.rejectUpdateRequest ? 1 : 0}" -eq 1 ]; then return 2; fi
        if [ "${options.retryUpdateRequest ? 1 : 0}" -eq 1 ] && [ ! -e "${logPath}.update-attempted" ]; then
          touch "${logPath}.update-attempted"
          return 75
        fi
        touch "${logPath}.update-accepted"
        return 0
      fi
      if [[ "$*" == *3001/status* ]]; then
        if [ "${options.retryUpdateRequest ? 1 : 0}" -eq 1 ] && [ ! -e "${logPath}.update-accepted" ]; then
          printf 'failed\\nSaved app failed to start\\n\\n\\n\\n\\nOld app exited\\n'
          return
        fi
        if [ "${options.pendingHealth ? 1 : 0}" -eq 1 ] && [ ! -e "${logPath}.checked" ]; then
          touch "${logPath}.checked"
          printf 'starting\\nAn activity the installer has never heard of\\n42\\n'
          return
        fi
        printf '${options.appFails ? 'failed\\nApp health failed\\n\\n\\n\\n\\nApp exited' : 'ready\\nKintsugi is ready\\n\\nhttps://app.example/custom-path\\n\\n\\n'}\\n'
        return
      fi ;;
    'logs --tail') echo 'supervisor startup failed: io.weight unavailable';;
    'inspect --format') if [[ "$*" == *HostConfig.Memory* ]]; then echo ${options.resourceLimits ?? '0 0 0 0'}; elif [[ "$*" == *'kintsugi.storage-driver'* ]]; then echo ${options.savedStorageDriver ?? ''}; elif [[ "$*" == *'{{.Image}}'* ]]; then echo ${pinned}; elif [[ "$*" == *'range $port'* ]]; then printf '%b\\n' ${JSON.stringify(options.portMappings ?? '')}; elif [[ "$*" == *State.Status* ]]; then echo ${options.systemState ?? 'running'}; elif [[ "$*" == *3080/tcp* ]]; then echo 55123; else echo ${options.initiallyStopped ? "false" : "true"}; fi ;;
  esac
}
`;
  const script = (options.hostUpdater ? installer.replace("no_updater=1", "no_updater=0") : installer)
    .replace("tee /etc/modules-load.d/kintsugi-system.conf", "tee /dev/null")
    // Mock terminal availability and answers; these tests exercise Docker orchestration.
    .replace('{ [ -t 0 ]; } 2>/dev/null <"$prompt_input"', "true")
    .replace(
      'IFS= read -r -t 120 "$1" <"$prompt_input"',
      `if [ "$1" = action ]; then action=update; elif [ "$1" = source_repository ]; then source_repository=${JSON.stringify(options.promptRepository ?? "")}; elif [ "$1" = tailscale_hostname ]; then tailscale_hostname=${JSON.stringify(options.promptHostname ?? "")}; else answer=${JSON.stringify(options.uninstallAnswer ?? (options.installed ? "yes" : "1"))}; fi`,
    );
  const result = Bun.spawnSync([process.platform === "darwin" ? "/bin/bash" : "bash", "-c", mock + script, "installer", ...args], { stdin: "ignore" });
  const log = Bun.spawnSync(["cat", logPath]).stdout.toString();
  const hostTrace = Bun.spawnSync(["cat", `${logPath}.host`]).stdout.toString();
  const tmpfiles = Bun.spawnSync(["cat", `${logPath}.tmpfiles`]).stdout.toString();
  const unit = Bun.spawnSync(["cat", `${logPath}.unit`]).stdout.toString();
  Bun.spawnSync(["rm", "-f", logPath, `${logPath}.checked`, `${logPath}.update-attempted`, `${logPath}.update-accepted`, `${logPath}.container-removed`, `${logPath}.volume-removed`, `${logPath}.host`, `${logPath}.tmpfiles`, `${logPath}.unit`]);
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() + log, hostTrace, tmpfiles, unit };
}

test("piped sudo installs read prompts from the caller's terminal", () => {
  expect(installer).toContain('prompt_input="${SUDO_TTY:-/dev/tty}"');
  expect(installer).toContain('IFS= read -r -t 120 "$1" <"$prompt_input"');
});

const pinnedSystem = `sha256:${"c".repeat(64)}`;

test("fresh install launches privileged System with persistent named volume and bootstrap app", () => {
  const result = run({}, ["--system-image", "test/system:v1", "--app-image", "test/app:v1"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER image inspect test/system:v1");
  expect(result.output).toContain(`--name kintsugi-system --label kintsugi.storage-driver=erofs --hostname kintsugi-system --privileged --cgroupns=host --restart unless-stopped --stop-timeout 120 --memory 12884901888 --memory-swap 12884901888 --cpus 6.000000000 --pids-limit 8192 --tmpfs /run --mount source=kintsugi-system,target=/data --publish 127.0.0.1:3080:3080 ${pinnedSystem} --app-image test/app:v1 --access-mode tailscale`);
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).toContain("DOCKER exec kintsugi-system bun -e");
});

test("localhost install publishes a stable loopback port", () => {
  const result = run({}, ["--access-mode", "localhost"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 127.0.0.1:3080:3080");
  expect(result.output).toContain("--access-mode localhost");
  expect(result.output).not.toContain("--publish 127.0.0.1::3080");
});

test("replacement downloads before stopping and retains volume", () => {
  const result = run({ installed: true });
  expect(result.status).toBe(0);
  const commands = result.output;
  expect(commands.indexOf("DOCKER pull")).toBeLessThan(commands.indexOf("DOCKER stop --time 120 kintsugi-system"));
  expect(commands.indexOf("DOCKER stop")).toBeLessThan(commands.indexOf("DOCKER rm kintsugi-system"));
  expect(commands).toContain("--mount source=kintsugi-system,target=/data");
  expect(commands).not.toContain("volume rm");
});

test("failed pull leaves existing System untouched", () => {
  const result = run({ installed: true, pullFails: true });
  expect(result.status).not.toBe(0);
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER run -d");
});

test("private registry denial stops without suggesting credential removal", () => {
  const result = run({ pullDenied: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Cannot pull the selected System image");
  expect(result.output).not.toContain("Run: docker logout");
  expect(result.output).not.toContain("DOCKER run");
});

test("other pull failures keep the generic message", () => {
  const result = run({ pullFails: true });
  expect(result.output).toContain("no upstream fallback was attempted");
  expect(result.output).not.toContain("docker logout");
});

test("connect enables Tailscale on a running localhost installation without replacing or restarting System", () => {
  const result = run({ installed: true }, ["--action", "connect"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER exec kintsugi-system bun -e");
  expect(result.output).toContain("http://127.0.0.1:3001/access");
  expect(result.output).toContain(" 55123 tailscale");
  expect(result.output).toContain("http://127.0.0.1:3001/connect");
  expect(result.output.indexOf("3001/access")).toBeLessThan(result.output.indexOf("3001/connect"));
  for (const command of ["pull", "stop", "rm", "run", "start", "restart"]) {
    expect(result.output).not.toContain(`DOCKER ${command}`);
  }
});

test("connect starts a stopped System before configuring Tailscale access", () => {
  const result = run({ installed: true, initiallyStopped: true }, ["--action", "connect"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER start kintsugi-system");
  expect(result.output).toContain(" 55123 tailscale");
  expect(result.output.indexOf("DOCKER start")).toBeLessThan(result.output.indexOf("3001/access"));
  for (const command of ["pull", "stop", "rm", "run"]) {
    expect(result.output).not.toContain(`DOCKER ${command}`);
  }
});

test("connect honors an explicit localhost access mode", () => {
  const result = run({ installed: true }, ["--action", "connect", "--access-mode", "localhost"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("http://127.0.0.1:3001/access");
  expect(result.output).toContain(" 55123 localhost");
  expect(result.output).not.toContain(" 55123 tailscale");
  expect(result.output).not.toContain("3001/connect");
});

test("open honors an explicit Tailscale access mode without replacing System", () => {
  const result = run({ installed: true }, ["--action", "open", "--access-mode", "tailscale"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER exec kintsugi-system bun -e");
  expect(result.output).toContain("http://127.0.0.1:3001/access");
  expect(result.output).toContain(" 55123 tailscale");
  expect(result.output).not.toContain("3001/connect");
  for (const command of ["pull", "stop", "rm", "run", "start", "restart"]) {
    expect(result.output).not.toContain(`DOCKER ${command}`);
  }
});

test("old installation is rejected without migration", () => {
  const result = run({ old: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("does not migrate");
  expect(result.output).not.toContain("DOCKER pull");
});

test("invalid action is rejected before Docker changes", () => {
  const result = run({}, ["--action", "destroy"]);
  expect(result.status).not.toBe(0);
  expect(result.output).not.toContain("DOCKER");
});


test("missing filesystem driver fails before image pull or System replacement", () => {
  const result = run({ installed: true, missingFilesystem: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("does not have erofs, which Kintsugi requires");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("DOCKER stop");
});


test("loads an available filesystem module before starting System", () => {
  const result = run({ missingFilesystem: true, loadable: true });
  expect(result.status).toBe(0);
  expect(result.output).toContain("MODPROBE erofs");
  expect(result.output.indexOf("MODPROBE erofs")).toBeLessThan(result.output.indexOf("DOCKER pull"));
});

test("supervisor failure stops System without removing its container or data", () => {
  const result = run({ appFails: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("3001/status");
  expect(result.output).toContain("DOCKER stop --time 120 kintsugi-system");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("volume rm");
});

test("waits for supervisor readiness without interpreting the activity description", () => {
  const result = run({ pendingHealth: true });
  expect(result.status).toBe(0);
  expect(result.output.match(/http:\/\/127\.0\.0\.1:3001\/status/g)?.length).toBe(2);
});


test("macOS uses a network-isolated configuration helper without host module changes", () => {
  const result = run({ mac: true, missingFilesystem: true });
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER run --rm --network none --entrypoint bun");
  expect(result.output).not.toContain("MODPROBE");
  expect(result.output).toContain("Open https://app.example/custom-path");
});


test("desktop defaults local while an explicit access choice overrides the OS", () => {
  const mac = run({ mac: true });
  expect(mac.status).toBe(0);
  expect(mac.output).toContain("--access-mode localhost");
  const wsl = run({ wsl: true });
  expect(wsl.status).toBe(0);
  expect(wsl.output).toContain("--access-mode localhost");
  const remote = run({ mac: true }, ["--access-mode", "tailscale"]);
  expect(remote.status).toBe(0);
  expect(remote.output).toContain("--access-mode tailscale");
});


test("open without an access choice preserves the existing access mode", () => {
  const result = run({ installed: true }, ["--action", "open"]);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("3080/tcp");
  expect(result.output).not.toContain("3001/access");
  expect(result.output).not.toContain("3001/connect");
  expect(result.output).not.toContain("DOCKER stop");
});


test("Linux requests sudo itself while Mac and WSL with Docker access do not", () => {
  const linux = run({ nonRoot: true });
  expect(linux.status).toBe(0);
  expect(linux.output).not.toContain("SUDO -v");
  expect(linux.output).toContain("SUDO -n mkdir -p /etc/modules-load.d");
  for (const options of [{ mac: true }, { wsl: true, nonRoot: true }, {}]) {
    expect(run(options).output).not.toContain("SUDO");
  }
});

test("denied sudo fails before changing the Linux host", () => {
  const result = run({ nonRoot: true, denySudo: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Administrator access was not granted");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("MODPROBE");
});

for (const state of ["restarting", "exited"] as const) {
  for (const action of ["update", "open"] as const) {
    test(`${action} stops waiting and shows container logs when System is ${state}`, () => {
      const result = run({ installed: true, systemState: state }, ["--action", action]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`Kintsugi services are ${state}`);
      expect(result.output).toContain("supervisor startup failed: io.weight unavailable");
      expect(result.output).not.toContain("Waiting for the supervisor");
      expect(result.output).not.toContain("http://127.0.0.1:3001/status");
    });
  }
}

for (const action of ["open", "connect"]) {
  test(`${action} stops an existing System when its status reports failure`, () => {
    const result = run({ installed: true, appFails: true }, ["--action", action]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("DOCKER stop --time 120 kintsugi-system");
    expect(result.output).not.toContain("DOCKER rm");
  });
}


test("update prepares and pins the app before replacing System", () => {
  const result = run({ installed: true }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output.indexOf("Cannot prepare the selected app")).toBeLessThan(result.output.indexOf("DOCKER stop --time 120"));
  expect(result.output).not.toContain("3001/update-channel");
});

test("failed app preparation retains existing System", () => {
  const result = run({ installed: true, appPrepareFails: true }, ["--action", "update"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("existing System was not replaced");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
});

for (const action of ["install", "open", "connect"]) {
  test(`${action} does not request an app channel update`, () => {
    const result = run({ installed: action !== "install" }, ["--action", action]);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("3001/update-channel");
  });
}

test("--uninstall cannot be combined with an install/update action", () => {
  const result = run({ installed: true }, ["--uninstall", "--action", "update"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("--uninstall cannot be combined with --action");
  expect(result.output).not.toContain("DOCKER pull");
});

test("uninstall cancellation warns with the exact inventory and deletes nothing", () => {
  const result = run({ installed: true, uninstallAnswer: "no" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("8 workspaces will be permanently deleted, including parked workspaces");
  expect(result.output).toContain("shared /persistent files, projects, settings, and locally saved credentials");
  expect(result.output).toContain("Uninstall cancelled. No data was deleted");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER volume rm");
  expect(result.output).not.toContain("method:\"POST\"");
  expect(result.output).not.toContain("MODPROBE");
});

test("confirmed uninstall delegates cleanup, polls status, then removes only System and its volume", () => {
  const result = run({ installed: true, uninstallAnswer: "DELETE KINTSUGI" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Uninstalled. System and all installation data have been removed");
  expect(result.output).toContain("DOCKER exec --user root kintsugi-system");
  expect(result.output).toContain("/run/kintsugi-system/uninstall.sock");
  expect(result.output).toContain("DOCKER stop --time 120 kintsugi-system");
  expect(result.output).toContain("DOCKER rm kintsugi-system");
  expect(result.output).toContain("DOCKER volume rm kintsugi-system");
  // Background run_quiet commands are captured in the log after foreground output.
  expect(result.output.indexOf("http://supervisor/uninstall")).toBeLessThan(result.output.indexOf("DOCKER stop --time 120"));
  expect(result.output).not.toContain("DOCKER system prune");
  expect(result.output).not.toContain("DOCKER pull");
});

for (const option of ["uninstallFails", "uninstallRequestFails", "inventoryFails"] as const) {
  test(`${option} retains the outer System container and volume`, () => {
    const result = run({ installed: true, uninstallAnswer: "DELETE KINTSUGI", [option]: true }, ["--uninstall"]);
    expect(result.status).toBe(1);
    expect(result.output).not.toContain("DOCKER stop");
    expect(result.output).not.toContain("DOCKER rm");
    expect(result.output).not.toContain("DOCKER volume rm");
  });
}

test("uninstall restarts a stopped supervisor to obtain its inventory, without downloading anything", () => {
  const result = run({ installed: true, initiallyStopped: true, uninstallAnswer: "no" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER start kintsugi-system");
  expect(result.output).toContain("8 workspaces");
  expect(result.output).not.toContain("DOCKER pull");
});

test("uninstall can finish volume removal after System was already removed, with explicit unknown-count warning", () => {
  const result = run({ volumeOnly: true, uninstallAnswer: "DELETE KINTSUGI" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Workspace count unavailable");
  expect(result.output).not.toContain("0 workspaces");
  expect(result.output).toContain("DOCKER volume rm kintsugi-system");
  expect(result.output).not.toContain("DOCKER exec");
});

test("uninstall does not claim success if installation volume removal fails", () => {
  const result = run({ volumeOnly: true, volumeRemovalFails: true, uninstallAnswer: "DELETE KINTSUGI" }, ["--uninstall"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Deleting installation storage failed");
  expect(result.output).not.toContain("Uninstalled. System");
});

test("uninstall is a no-op when no System container or volume remains", () => {
  const result = run({}, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Nothing to uninstall");
  expect(result.output).not.toContain("DOCKER run");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("Type DELETE KINTSUGI");
});


test("installer refuses Atelier without adopting or deleting its resources", () => {
  const result = run({ legacyAtelier: true }, ["--action", "install"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Use its own installer to remove it");
  expect(result.output).not.toContain("DOCKER run");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER volume rm");
});

test("uninstall refuses upstream legacy data without downloading or deleting anything", () => {
  const result = run({ legacyAtelier: true }, ["--uninstall"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Use its own uninstaller");
  expect(result.output).not.toContain("CURL");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER volume rm");
});

test("when both products exist, uninstall removes only the new product and explains the next step", () => {
  const result = run({ installed: true, legacyAtelier: true, uninstallAnswer: "DELETE KINTSUGI" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("Atelier will remain; use its own installer to remove it");
  expect(result.output).toContain("DOCKER rm kintsugi-system");
  expect(result.output).not.toContain("LEGACY BASH");
  expect(result.output).not.toContain("DOCKER rm atelier");
});

test("a remaining new-product volume takes precedence over legacy delegation", () => {
  const result = run({ volumeOnly: true, legacyAtelier: true, uninstallAnswer: "DELETE KINTSUGI" }, ["--uninstall"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER volume rm kintsugi-system");
  expect(result.output).not.toContain("LEGACY BASH");
});

test("pre-System Atelier uninstall fails explicitly rather than claiming nothing is installed", () => {
  const result = run({ legacyPreSystem: true }, ["--uninstall"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Automatic uninstall is not supported for that layout");
  expect(result.output).not.toContain("Nothing to uninstall");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("LEGACY BASH");
});

test("fresh installer uses latest in the separate renamed repositories", () => {
  const result = run({});
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER pull ghcr.io/rcarmo/kintsugi-system:latest");
  expect(result.output).toContain("--app-image ghcr.io/rcarmo/kintsugi:latest");
  expect(result.output).not.toContain(":beta");
});

test("upstream legacy storage is retained even when its container is absent", () => {
  const result = run({ legacyVolumeOnly: true }, ["--uninstall"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("retained all of its data");
  expect(result.output).not.toContain("DOCKER volume rm");
});

test("updates preserve existing host publications, including a stopped System", () => {
  const result = run({ installed: true, initiallyStopped: true, portMappings: "192.168.1.10:3443:3443/tcp\n::1:5353:5353/udp" }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 192.168.1.10:3443:3443/tcp");
  expect(result.output).toContain("--publish [::1]:5353:5353/udp");
  expect(installer).not.toContain(".NetworkSettings.Ports");
});

test("admin publication is explicit and does not replace local ingress", () => {
  const result = run({}, ["--action", "install", "--admin-publish", "192.168.1.10:3443:3443"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 127.0.0.1:3080:3080 --publish 192.168.1.10:3443:3443");
});
test("loopback admin publication and multiple ports are supported", () => {
  const result = run({}, ["--action", "install", "--admin-publish", "127.0.0.1:3443:3443", "--admin-publish", "192.168.1.10:3444:3444"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 127.0.0.1:3443:3443 --publish 192.168.1.10:3444:3444");
});
test("invalid admin publication cannot expose internal UI, supervisor or previews", () => {
  for (const mapping of ["3443", "localhost:3443:3443", "192.168.1.10:3443:3000", "192.168.1.10:3443:3001", "192.168.1.10:3443:3080", "192.168.1.10:3443:41001", "999.1.1.1:3443:3443"]) {
    const result = run({}, ["--action", "install", "--admin-publish", mapping]);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("DOCKER run");
  }
});
test("updates retain previously published admin ports", () => {
  const result = run({ installed: true, portMappings: "192.168.1.10:3443:3443/tcp" }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 192.168.1.10:3443:3443");
});

test("admin publication removal skips saved mappings on update", () => {
  const result = run({ installed: true, portMappings: "192.168.1.10:3443:3443/tcp" }, ["--action", "update", "--no-admin-publish"]);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("--publish 192.168.1.10:3443:3443");
});
test("publication persistence reads Docker HostConfig, including stopped System", () => {
  expect(installer).toContain(".HostConfig.PortBindings");
  expect(installer).not.toContain(".NetworkSettings.Ports");
  const result = run({ installed: true, initiallyStopped: true, portMappings: "192.168.1.10:3443:3443/tcp" }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--publish 192.168.1.10:3443:3443");
});
test("publication flags cannot be silently ignored on open or connect", () => {
  for (const action of ["open", "connect"]) {
    const result = run({ installed: true }, ["--action", action, "--admin-publish", "127.0.0.1:3443:3443"]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("require --action install or update");
  }
});
test("wildcard publication requires explicit informed opt-in", () => {
  const denied = run({}, ["--action", "install", "--admin-publish", "0.0.0.0:3443:3443"]);
  expect(denied.status).not.toBe(0);
  const allowed = run({}, ["--action", "install", "--admin-publish", "0.0.0.0:3443:3443", "--allow-admin-all-interfaces"]);
  expect(allowed.status).toBe(0);
  expect(allowed.output).toContain("Docker publication may bypass host firewall");
});
test("publication removal and replacement are mutually exclusive", () => {
  expect(run({}, ["--action", "install", "--admin-publish", "127.0.0.1:3443:3443", "--no-admin-publish"]).status).not.toBe(0);
});

test("setup prompts for a source repository and hostname and uses the answers", () => {
  const result = run({ promptRepository: "ghcr.io/example/cloud", promptHostname: "cloud-home" });
  expect(result.status).toBe(0);
  expect(result.output).toContain("Release image repository");
  expect(result.output).toContain("Tailscale hostname");
  expect(result.output).toContain("DOCKER pull ghcr.io/example/cloud-system:latest");
  expect(result.output).toContain("--hostname cloud-home");
  expect(result.output).toContain("--app-image ghcr.io/example/cloud:latest");
});

test("updates use the saved fork source and hostname without prompting or pulling upstream", () => {
  const result = run({ installed: true, savedRepository: "ghcr.io/example/fork", savedHostname: "saved-cloud" }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER pull ghcr.io/example/fork-system:latest");
  expect(result.output).not.toContain("DOCKER pull ghcr.io/lucasmeijer");
  expect(result.output).toContain("--hostname saved-cloud");
  expect(result.output).not.toContain("Release image repository [");
});

test("invalid setup hostname is rejected before pulling or replacing System", () => {
  const result = run({}, ["--tailscale-hostname", "invalid host"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Invalid Tailscale hostname");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("DOCKER run -d");
});

test("saved private registry authentication is reused through a restrictive temporary host config", () => {
  const result = run({ installed: true, savedRegistry: true, savedRepository: "ghcr.io/example/private" }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER --config /tmp/kintsugi-registry.");
  expect(result.output).not.toContain("Zml4dHVyZTp0b2tlbg==");
  expect(result.output).toContain("pull ghcr.io/example/private-system:latest");
});

test("rollback uses retained images without registry pulls", () => {
  const result = run({ installed: true }, ["--action", "rollback"]);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).toContain(" rollback-apply ");
});

test("rollback without a retained pair leaves the existing installation untouched", () => {
  const result = run({ installed: true, rollbackAvailable: false }, ["--action", "rollback"]);
  expect(result.status).not.toBe(0);
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
});

test("an incompatible System image is rejected before stopping the current installation", () => {
  const result = run({ installed: true, installerCompatible: false }, ["--action", "update"]);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("does not support this installer");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
});

test("overlayfs installation does not require or load erofs and records its driver", () => {
  const result = run({ erofsMissing: true }, ["--action", "install", "--storage-driver", "overlayfs"]);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("MODPROBE erofs");
  expect(result.output).toContain("--label kintsugi.storage-driver=overlayfs");
});

test("overlayfs updates retain the selected driver and reject incompatible System before replacement", () => {
  const result = run({ installed: true, savedStorageDriver: "overlayfs", erofsMissing: true }, ["--action", "update"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("--label kintsugi.storage-driver=overlayfs");
  const incompatible = run({ installed: true, savedStorageDriver: "overlayfs", storageCompatible: false }, ["--action", "update"]);
  expect(incompatible.status).toBe(1);
  expect(incompatible.output).toContain("does not support overlayfs");
  expect(incompatible.output).not.toContain("DOCKER stop");
});

test("changing an installed backend is refused before pulls or replacement", () => {
  const result = run({ installed: true }, ["--action", "update", "--storage-driver", "overlayfs"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Cannot change an existing installation");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("DOCKER stop");
});

test("unsupported storage names are rejected", () => {
  const result = run({}, ["--storage-driver", "overlay2"]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Storage driver must be erofs or overlayfs");
});

const unattended = ["--non-interactive","--action","install","--access-mode","localhost","--storage-driver","overlayfs","--tailscale-hostname","agent-host","--source-repository","ghcr.io/rcarmo/kintsugi"];
test("unattended fresh install needs no terminal and never prompts",()=>{
  const result=run({},unattended); expect(result.status).toBe(0);
  expect(result.output).not.toContain("Choose [1]"); expect(result.output).not.toContain("Release image repository [");
});
test("missing unattended inputs and destructive confirmation fail before Docker changes",()=>{
  for(const args of [["--non-interactive"],["--non-interactive","--action","install"],["--non-interactive","--action","update"],["--non-interactive","--uninstall"]]) {
    const result=run({},args); expect(result.status).not.toBe(0); expect(result.output).not.toContain("DOCKER");
  }
});
test("passwordless command rules never require sudo validation",()=>{
  const result=run({nonRoot:true},unattended); expect(result.status).toBe(0); expect(result.output).not.toContain("SUDO -v"); expect(result.output).toContain("SUDO -n mkdir");
  const denied=run({nonRoot:true,denySudo:true},unattended);expect(denied.status).not.toBe(0);expect(denied.output).toContain("Administrator access required for mkdir");
});
test("proxy setup requires explicit LAN trust and loopback-only publications",()=>{
  const args=unattended.map(value=>value==="localhost"?"proxy":value);
  const proxy=["--public-origin","https://agent-host.local","--ui-publish","127.0.0.1:3000:3081"];
  expect(run({},[...args,...proxy]).status).not.toBe(0);
  const good=run({},[...args,...proxy,"--acknowledge-lan-trust"]);expect(good.status).toBe(0);expect(good.output).toContain("--publish 127.0.0.1:3000:3081");
  expect(run({},[...args,...proxy,"--acknowledge-lan-trust","--ui-publish","0.0.0.0:3000:3081"]).status).not.toBe(0);
});

test("supported proxy upgrade replaces conflicting legacy sidecar publications only",()=>{
 const result=run({installed:true,portMappings:"127.0.0.1:3000:3002/tcp\n127.0.0.1:3444:3444/tcp\n127.0.0.1:5555:5555/tcp"},["--action","update","--access-mode","proxy","--public-origin","https://agent-host.local","--acknowledge-lan-trust","--ui-publish","127.0.0.1:3000:3081","--admin-proxy-publish","127.0.0.1:3444:3082"]);
 expect(result.status).toBe(0);expect(result.output).toContain("--publish 127.0.0.1:3000:3081");expect(result.output).toContain("--publish 127.0.0.1:3444:3082");expect(result.output).not.toContain("--publish 127.0.0.1:3000:3002");expect(result.output).not.toContain("--publish 127.0.0.1:3444:3444");expect(result.output).toContain("--publish 127.0.0.1:5555:5555");
});


test("default host updater rejects a missing systemd manager before replacing System",()=>{
  const result=run({hostUpdater:true,installed:true},["--non-interactive","--action","update","--confirm-replace"]);
  expect(result.status).not.toBe(0);expect(result.output).toContain("requires a running systemd manager");expect(result.output).not.toContain("DOCKER stop");
});

test("explicit no-updater supports isolated non-systemd installs",()=>{
  const result=run({hostUpdater:true,installed:true},["--no-updater","--non-interactive","--action","update","--confirm-replace"]);
  expect(result.status).toBe(0);expect(result.output).not.toContain("SYSTEMCTL");
});

for (const action of ["install", "update", "rollback"]) {
  test(`${action} installs and applies a private boot-time updater directory before starting System`, () => {
    const result = run({ hostUpdater: true, systemd: true, installed: action !== "install", initiallyStopped: action === "update" }, ["--action", action]);
    expect(result.status).toBe(0);
    expect(result.tmpfiles).toBe("d /run/kintsugi-updater 0700 root root -\n");
    expect(result.hostTrace).toContain("INSTALL -m 644 -o root -g root /dev/stdin /etc/tmpfiles.d/kintsugi-updater.conf");
    const apply = result.hostTrace.indexOf("TMPFILES --create /etc/tmpfiles.d/kintsugi-updater.conf");
    expect(apply).toBeGreaterThan(result.hostTrace.indexOf("INSTALL -m 644"));
    expect(apply).toBeLessThan(result.hostTrace.indexOf("DOCKER run -d"));
    if (action === "update") expect(apply).toBeLessThan(result.hostTrace.indexOf("DOCKER start kintsugi-system"));
    expect(result.output).toContain("type=bind,source=/run/kintsugi-updater,target=/run/kintsugi-updater,readonly");
    if (action !== "rollback") {
      expect(result.unit).toContain("After=docker.service\nRequires=docker.service");
      expect(result.unit).toContain("RuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=yes");
      expect(result.unit).not.toContain("Before=docker");
      expect(result.hostTrace.indexOf("SYSTEMCTL enable --now kintsugi-updater.service")).toBeGreaterThan(apply);
    }
  });
}

test("tmpfiles failure stops installation before starting or replacing System", () => {
  const result = run({ hostUpdater: true, systemd: true, tmpfilesFails: true, installed: true }, ["--action", "update"]);
  expect(result.status).not.toBe(0);
  expect(result.hostTrace).toContain("TMPFILES --create");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER run -d");
});

test("no-updater and macOS do not install a boot-time rule or socket mount", () => {
  for (const options of [{ hostUpdater: true, systemd: true }, { hostUpdater: true, mac: true }]) {
    const result = run(options, options.mac ? [] : ["--no-updater"]);
    expect(result.status).toBe(0);
    expect(result.tmpfiles).toBe("");
    expect(result.hostTrace).not.toContain("TMPFILES");
    expect(result.output).not.toContain("source=/run/kintsugi-updater");
  }
});

test("confirmed uninstall removes only the owned tmpfiles rule after deleting System storage", () => {
  const result = run({ hostUpdater: true, systemd: true, nonRoot: true, installed: true, uninstallAnswer: "DELETE KINTSUGI" }, ["--uninstall"]);
  expect(result.status, result.output).toBe(0);
  expect(result.hostTrace).toContain("REMOVE -f /etc/tmpfiles.d/kintsugi-updater.conf");
  expect(result.hostTrace.indexOf("REMOVE -f")).toBeGreaterThan(result.hostTrace.indexOf("DOCKER volume rm"));
  expect(result.output).toContain("SUDO -n rm -f /etc/tmpfiles.d/kintsugi-updater.conf");
});

test("no-updater, cancelled and failed uninstalls retain the boot-time rule", () => {
  for (const [options, args] of [
    [{ uninstallAnswer: "DELETE KINTSUGI" }, ["--uninstall", "--no-updater"]],
    [{ uninstallAnswer: "no" }, ["--uninstall"]],
    [{ uninstallAnswer: "DELETE KINTSUGI", uninstallFails: true }, ["--uninstall"]],
  ] as const) {
    const result = run({ hostUpdater: true, systemd: true, installed: true, ...options }, [...args]);
    expect(result.hostTrace).not.toContain("REMOVE -f /etc/tmpfiles.d/kintsugi-updater.conf");
  }
});

test("listed-host data rejects legacy app/System targets before stopping the installation", () => {
  for (const versions of [{ systemCompatibility: "1", appNetworkCompatibility: "2" }, { systemCompatibility: "2", appNetworkCompatibility: "0" }]) {
    const result = run({ installed: true, networkDataVersion: 2, ...versions });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Apply Off before downgrading");
    expect(result.output).not.toContain("DOCKER stop");
    expect(result.output).not.toContain("DOCKER rm kintsugi-system");
  }
  expect(run({ installed: true, networkDataVersion: 2, systemCompatibility: "2", appNetworkCompatibility: "2" }).status).toBe(0);
});

test("installer preserves finite manual System RAM/swap/CPU/PID limits through update and rollback", () => {
  for (const action of ["update","rollback"]) {
    const result=run({installed:true,resourceLimits:"10737418240 12884901888 2500000000 4096"},["--non-interactive","--confirm-replace","--action",action]);
    expect(result.status).toBe(0);expect(result.output).toContain("--memory 10737418240 --memory-swap 12884901888 --cpus 2.500000000 --pids-limit 4096");
  }
});
test("new default budgets reserve RAM already used by unrelated host services", () => {
  const fresh=run({hostMemoryAvailable:8*1024**3},unattended);
  expect(fresh.status).toBe(0);expect(fresh.output).toContain("--memory 6442450944 --memory-swap 6442450944");
  const update=run({installed:true,hostMemoryAvailable:8*1024**3,currentMemoryPercent:"25.00%"},["--non-interactive","--confirm-replace","--action","update"]);
  expect(update.status).toBe(0);expect(update.output).toContain("--memory 9663676416 --memory-swap 9663676416");
});
test("unsafe available memory and unlimited saved swap fail before replacement", () => {
  for (const options of [{installed:true,hostMemoryAvailable:1024**3},{installed:true,resourceLimits:"10737418240 -1 0 0"}]) {
    const result=run(options,["--non-interactive","--confirm-replace","--action","update"]);
    expect(result.status).not.toBe(0);expect(result.output).not.toContain("DOCKER stop --time 120");expect(result.output).not.toContain("DOCKER rm kintsugi-system");
  }
});

test("installer reapplies a runtime budget recorded after an older installer upgrade without discarding explicit CPU limits", () => {
  const result=run({installed:true,resourceLimits:"0 0 2000000000 4096",rememberedLimits:"10737418240 12884901888 9000000000 8192"},["--non-interactive","--confirm-replace","--action","update"]);
  expect(result.status).toBe(0);expect(result.output).toContain("--memory 10737418240 --memory-swap 12884901888 --cpus 2.000000000 --pids-limit 4096");
});

test("saved workspace resource allocations refuse incompatible app/System replacements before stopping services",()=>{
  for(const target of [{systemCompatibility:"2",appResourceCompatibility:"1"},{systemCompatibility:"3",appResourceCompatibility:"0"}]){
    const result=run({installed:true,resourceDataVersion:1,...target});expect(result.status).not.toBe(0);expect(result.output).toContain("resource-aware");expect(result.output).not.toContain("DOCKER stop --time 120");expect(result.output).not.toContain("DOCKER rm kintsugi-system");
  }
  expect(run({installed:true,resourceDataVersion:1,systemCompatibility:"3",appResourceCompatibility:"1"}).status).toBe(0);
});

test("saved task settings require reader 3 and System 5 before update or rollback",()=>{
  for(const action of ["update","rollback"]){
    for(const target of [{systemCompatibility:"4",appResourceCompatibility:"3"},{systemCompatibility:"5",appResourceCompatibility:"2"}]){
      const result=run({installed:true,resourceDataVersion:3,...target},["--non-interactive","--confirm-replace","--action",action]);
      expect(result.status).not.toBe(0);expect(result.output).not.toContain("DOCKER stop --time 120");expect(result.output).not.toContain("DOCKER rm kintsugi-system");
    }
    expect(run({installed:true,resourceDataVersion:3,systemCompatibility:"5",appResourceCompatibility:"3"},["--non-interactive","--confirm-replace","--action",action]).status).toBe(0);
  }
});
