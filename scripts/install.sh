#!/usr/bin/env bash
set -Eeuo pipefail

system_image=ghcr.io/rcarmo/kintsugi-system:latest
app_image=ghcr.io/rcarmo/kintsugi:latest
source_repository=""
tailscale_hostname=""
registry_config=""
registry_directory=""
app_image_override=""
system_image_override=""
pinned_app=""
old_system_image=""
action=""
uninstall_requested=0
access_mode=""
admin_publish=()
admin_publish_disabled=0
admin_allow_all=0
storage_driver="erofs"
storage_override=""
system_name=kintsugi-system
non_interactive=0
confirm_replace=0
confirm_delete=0
install_docker=0
lan_trust=0
public_origin=""
preview_ports="41000:41999"
preview_override=""
ui_publish=""
admin_proxy_publish=""
admin_proxy_port="3443"
proxy_config=""
admin_bootstrap=""
admin_token_output=""
result_file=""
admin_ready=false
no_updater=0
preserve_release_selection=0
updater_mount=()

# Keep subprocess output available without turning the welcome into a log tail.
log_file=""
interactive=0
violet="" cyan="" green="" amber="" dim="" reset=""
if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
  interactive=1
  violet=$'\033[35m' cyan=$'\033[36m' green=$'\033[32m'
  amber=$'\033[33m' dim=$'\033[2m' reset=$'\033[0m'
fi
last_status=""
spinner_frame=0
active_pid=""
stop_on_failure=0

finish_line() {
  if [ "$interactive" -eq 1 ] && [ -n "$last_status" ]; then printf '\r\033[2K'; fi
  last_status=""
}
status() {
  local text="$1" elapsed="${2:-}" percent="${3:-}" bar="" i suffix
  local rows columns available
  local frames="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  local frame="${frames:spinner_frame:1}"
  spinner_frame=$(((spinner_frame + 1) % 10))
  if [ -n "$percent" ]; then
    for ((i=0; i<10; i++)); do
      if [ "$i" -lt "$((percent/10))" ]; then bar+="━"; else bar+="─"; fi
    done
    suffix="$bar $percent%"
  elif [[ "$text" == *" · "*" layers ready" ]]; then
    suffix="${text##* · }  $elapsed"
    text="${text% · *}"
  else
    suffix="$elapsed"
  fi
  if [ "$interactive" -eq 1 ]; then
    read -r rows columns < <(stty size </dev/tty)
    available=$((columns - 8 - ${#suffix}))
    if [ "$available" -lt 10 ]; then available=10; fi
    if [ "${#text}" -gt "$available" ]; then text="${text:0:available-1}…"; fi
    printf '\r\033[2K  %s%s %s%s  %s%s%s' "$cyan" "$frame" "$text" "$reset" "$dim" "$suffix" "$reset"
  elif [ "$1" != "$last_status" ]; then
    printf '  %s\n' "$text"
  fi
  last_status="$1"
}
fail() {
  finish_line
  printf '\n  %s! %s%s\n' "$amber" "$*" "$reset" >&2
  exit 1
}
prompt() {
  [ "$non_interactive" -eq 0 ] || fail "Missing unattended input: $2"
  printf '%s' "$2"
  IFS= read -r -t 120 "$1" <"$prompt_input" || fail "No response received within 2 minutes, or terminal input closed. Run the installer again when ready."
}
# Runs a step with a progress line and returns its exit status.
run_quiet_status() {
  local label="$1" pid start=$SECONDS code=0
  shift
  "$@" <&0 >>"$log_file" 2>&1 &
  pid=$!
  active_pid=$pid
  while kill -0 "$pid" 2>/dev/null; do
    status "$label" "$((SECONDS-start))s"
    if [ "$((SECONDS-start))" -ge 1800 ]; then
      kill "$pid"
      wait "$pid" || :
      active_pid=""
      fail "Timed out: $label."
    fi
    sleep 0.1
  done
  active_pid=""
  wait "$pid" || code=$?
  return "$code"
}
run_quiet() {
  run_quiet_status "$@" || fail "$1 failed. See the bootstrap log for details."
}
cleanup() {
  local code=$?
  trap - ERR
  finish_line
  if [ -n "$active_pid" ] && kill -0 "$active_pid" 2>/dev/null; then
    kill "$active_pid"
    wait "$active_pid" || :
  fi
  if [ -n "$registry_directory" ]; then rm -rf "$registry_directory"; fi
  if [ "$code" -ne 0 ] && [ "$stop_on_failure" -eq 1 ]; then
    printf '\n  Stopping Kintsugi services after installation failure.\n' >&2
    if ! docker stop --time 120 "$system_name" >>"$log_file" 2>&1; then
      printf '  Could not stop Kintsugi services. Run: docker stop %s\n' "$system_name" >&2
    fi
    printf '  Local diagnostics: docker logs %s\n' "$system_name" >&2
  fi
  if [ "$code" -ne 0 ] && [ -n "$log_file" ]; then
    printf '  Bootstrap log: %s\n' "$log_file" >&2
  fi
}
trap cleanup EXIT
trap 'fail "Installation could not continue. See the bootstrap log for details."' ERR
trap 'fail "Installation interrupted."' INT TERM

usage() {
  cat <<'HELP'
Usage: install.sh [options]

Installs Kintsugi System, or offers actions for an existing installation.
System replacements preserve the kintsugi-system volume and interrupt workspaces.
Update also installs the newest Kintsugi app on the installation's selected channel.

  --system-image REF   Explicit System selection (otherwise the saved release source)
  --app-image REF      Explicit app selection, including on existing installations
  --source-repository REPO  App repository (GHCR or Docker Hub); System defaults to REPO-system
  --tailscale-hostname NAME  Tailscale machine name (prompted on setup)
  --registry-config FILE  Docker config with inline GHCR auth; copied privately into System
  --storage-driver MODE  erofs (default) or overlayfs; selected on fresh install, retained on update
  --access-mode MODE  localhost, proxy (trusted LAN), or tailscale
  --no-updater        Disable host updater installation (Linux enables it by default)
  --preserve-release-selection  Use image overrides without changing saved tracking
  --non-interactive   Never prompt; fully specify fresh install inputs
  --confirm-replace   Confirm interruption for unattended update/rollback
  --confirm-delete    Confirm permanent deletion for unattended uninstall
  --install-docker    Allow unattended Docker package installation
  --public-origin URL  Advertised UI origin for proxy mode (no path)
  --preview-ports FIRST:LAST  Proxy preview ports (default 41000:41999; legacy ten-port pools expand on update)
  --ui-publish 127.IP:HOST_PORT:3081  Loopback UI upstream for external proxy
  --admin-proxy-publish 127.IP:HOST_PORT:3082  Loopback upstream to loopback HTTP API
  --admin-proxy-port PORT  Inner HTTP admin listener (default 3443)
  --acknowledge-lan-trust  Everyone who can reach the UI is trusted
  --admin-bootstrap FILE  JSON {bindings:[...],token:{name,scopes,expiresAt?}}
  --admin-token-output FILE|-  New private token file or secure stdout capture
  --result-file FILE|-  Credential-free JSON result; progress stays on stderr
  --admin-publish IP:HOST_PORT:ADMIN_PORT  Publish an admin listener (repeatable; TLS/token setup separate)
  --no-admin-publish   Remove all admin port publications on install/update
  --allow-admin-all-interfaces  Explicitly allow 0.0.0.0 admin publication (all host interfaces)
  --action ACTION     install, update, rollback, connect, or open
                      connect enables Tailscale without replacing an existing installation
  --uninstall         Permanently delete Kintsugi installation data
  -h, --help          Show help

Setup prompts for a release repository and a Tailscale hostname. Updates retain saved selections.
Registry-qualified image overrides are persisted; local image overrides are one-off selections.
There is no migration from the previous Kintsugi installation layout.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system-image|--app-image|--action|--access-mode|--source-repository|--tailscale-hostname|--registry-config|--storage-driver|--public-origin|--preview-ports|--ui-publish|--admin-proxy-publish|--admin-proxy-port|--admin-bootstrap|--admin-token-output|--result-file)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$1" in
        --system-image) system_image="$2"; system_image_override="$2" ;;
        --app-image) app_image="$2"; app_image_override="$2" ;;
        --source-repository) source_repository="$2" ;;
        --tailscale-hostname) tailscale_hostname="$2" ;;
        --storage-driver) storage_override="$2"; storage_driver="$2" ;;
        --registry-config) registry_config="$2" ;;
        --action) action="$2" ;;
        --access-mode) access_mode="$2" ;;
        --public-origin) public_origin="$2" ;;
        --preview-ports) preview_ports="$2"; preview_override="$2" ;;
        --ui-publish) ui_publish="$2" ;;
        --admin-proxy-publish) admin_proxy_publish="$2" ;;
        --admin-proxy-port) admin_proxy_port="$2" ;;
        --admin-bootstrap) admin_bootstrap="$2" ;;
        --admin-token-output) admin_token_output="$2" ;;
        --result-file) result_file="$2" ;;
      esac
      shift 2 ;;
    --admin-publish)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires IP:HOST_PORT:ADMIN_PORT"
      admin_publish+=("$2"); shift 2 ;;
    --non-interactive) non_interactive=1; shift ;;
    --confirm-replace) confirm_replace=1; shift ;;
    --no-updater) no_updater=1; shift ;;
    --preserve-release-selection) preserve_release_selection=1; shift ;;
    --confirm-delete) confirm_delete=1; shift ;;
    --install-docker) install_docker=1; shift ;;
    --acknowledge-lan-trust) lan_trust=1; shift ;;
    --no-admin-publish) admin_publish_disabled=1; shift ;;
    --allow-admin-all-interfaces) admin_allow_all=1; shift ;;
    --uninstall) uninstall_requested=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
if [ "$uninstall_requested" -eq 1 ]; then
  [ -z "$action" ] || fail "--uninstall cannot be combined with --action"
  action=uninstall
fi
case "$action" in ""|install|update|rollback|connect|open|uninstall) ;; *) fail "unknown action: $action" ;; esac
case "$access_mode" in ""|localhost|proxy|tailscale) ;; *) fail "unknown access mode: $access_mode" ;; esac
case "$storage_driver" in erofs|overlayfs) ;; *) fail "Storage driver must be erofs or overlayfs" ;; esac
for reference in "$app_image_override" "$system_image_override"; do
  [ -z "$reference" ] || [[ "$reference" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$ ]] || fail "Invalid explicit image reference"
done
# Validate unattended intent before any package, kernel or Docker mutation.
if [ "$non_interactive" -eq 1 ]; then
  [ -n "$action" ] || fail "--non-interactive requires --action"
  case "$action" in
    update|rollback) [ "$confirm_replace" -eq 1 ] || fail "Unattended replacement requires --confirm-replace" ;;
    uninstall) [ "$confirm_delete" -eq 1 ] || fail "Unattended uninstall requires --confirm-delete" ;;
    install)
      [ -n "$access_mode" ] && [ -n "$storage_override" ] && [ -n "$tailscale_hostname" ] || fail "Unattended install requires --access-mode, --storage-driver and --tailscale-hostname"
      [ -n "$source_repository" ] || { [ -n "$app_image_override" ] && [ -n "$system_image_override" ]; } || fail "Unattended install requires --source-repository or both image overrides"
      ;;
  esac
fi
exec 3>&1
if [ -n "$result_file" ] || [ "$admin_token_output" = - ]; then
  exec 1>&2
  interactive=0
  if [ -n "$result_file" ] && [ "$result_file" != - ]; then (umask 077; set -o noclobber; : > "$result_file") || fail "Result file must be a new writable file"; fi
fi
[ "$admin_token_output" != - ] || [ "$result_file" != - ] || fail "Token and result cannot both use stdout"
if [ -n "$admin_bootstrap" ]; then
  [ -f "$admin_bootstrap" ] && [ -r "$admin_bootstrap" ] || fail "Admin bootstrap file must be readable"
  [ -n "$admin_token_output" ] || fail "--admin-bootstrap requires --admin-token-output"
  if [ "$admin_token_output" != - ]; then
    [ ! -e "$admin_token_output" ] && [ ! -L "$admin_token_output" ] || fail "Token output must be a new file"
  fi
else
  [ -z "$admin_token_output" ] || fail "--admin-token-output requires --admin-bootstrap"
fi
validate_proxy_publish() {
  local mapping="$1" target="$2" ip port actual octet
  [[ "$mapping" =~ ^127\.([0-9]{1,3}\.){2}[0-9]{1,3}:[0-9]{1,5}:$target$ ]] || fail "Proxy publications require a loopback IPv4 IP:HOST_PORT:$target"
  IFS=: read -r ip port actual <<<"$mapping"
  for octet in ${ip//./ }; do [ "$((10#$octet))" -le 255 ] || fail "Invalid loopback publication IP"; done
  [ "$((10#$port))" -ge 1024 ] && [ "$((10#$port))" -le 65535 ] || fail "Invalid proxy publication port"
}
if [ -n "$ui_publish" ]; then validate_proxy_publish "$ui_publish" 3081; fi
if [ -n "$admin_proxy_publish" ]; then validate_proxy_publish "$admin_proxy_publish" 3082; fi
if [ -n "$preview_override" ]; then
  [[ "$preview_override" =~ ^41[0-9]{3}:41[0-9]{3}$ ]] && [ "${preview_override%:*}" -le "${preview_override#*:}" ] || fail "Preview ports must be FIRST:LAST within 41000–41999"
fi
if [ -n "$public_origin" ]; then
  [ "$lan_trust" -eq 1 ] || fail "Proxy UI access trusts every reachable client; requires --acknowledge-lan-trust"
  [[ "$public_origin" =~ ^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?$ ]] || fail "Use a canonical HTTP(S) public origin without a path or credentials"
  [[ "$preview_ports" =~ ^41[0-9]{3}:41[0-9]{3}$ ]] || fail "Preview ports must be FIRST:LAST within 41000–41999"
  preview_first="${preview_ports%:*}"; preview_last="${preview_ports#*:}"
  [ "$preview_first" -le "$preview_last" ] || fail "Invalid preview port range"
  [[ "$admin_proxy_port" =~ ^[0-9]{4,5}$ ]] || fail "Invalid admin proxy port"
  proxy_admin=""; if [ -n "$admin_proxy_publish" ]; then proxy_admin=',"adminPort":'"$admin_proxy_port"; fi
  proxy_config='{ "origin":"'"$public_origin"'", "previewPorts":{"start":'"$preview_first"',"end":'"$preview_last"'}'"$proxy_admin"'}'
fi
if [ "$access_mode" = proxy ] && [ "$action" = install ]; then
  [ -n "$public_origin" ] && [ -n "$ui_publish" ] || fail "Fresh proxy access requires --public-origin and --ui-publish"
fi
validate_admin_publish() {
  local mapping="$1" ip host_port container_port octet
  local -a octets
  [[ "$mapping" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}:[0-9]{1,5}$ ]] || fail "--admin-publish requires an explicit IPv4 IP:HOST_PORT:ADMIN_PORT"
  IFS=: read -r ip host_port container_port <<<"$mapping"
  IFS=. read -r -a octets <<<"$ip"
  for octet in "${octets[@]}"; do [ "$((10#$octet))" -le 255 ] || fail "Invalid admin publication IP"; done
  host_port=$((10#$host_port)); container_port=$((10#$container_port))
  [ "$host_port" -ge 1024 ] && [ "$host_port" -le 65535 ] && [ "$container_port" -ge 1024 ] && [ "$container_port" -le 65535 ] || fail "Admin ports must be between 1024 and 65535"
  case "$container_port" in 2999|3000|3001|3080|3081|3082|24800) fail "Cannot publish an internal management or gateway port as an admin listener" ;; esac
  [ "$container_port" -lt 41000 ] || [ "$container_port" -gt 41999 ] || fail "Cannot publish a workspace preview port as an admin listener"
}
[ "$admin_publish_disabled" -eq 0 ] || [ "${#admin_publish[@]}" -eq 0 ] || fail "--no-admin-publish cannot be combined with --admin-publish"
for mapping in "${admin_publish[@]}"; do
  validate_admin_publish "$mapping"
  if [[ "$mapping" == 0.0.0.0:* ]]; then
    [ "$admin_allow_all" -eq 1 ] || fail "0.0.0.0 exposes all host interfaces; requires --allow-admin-all-interfaces"
    printf 'Warning: admin publication covers all interfaces, possibly public. Docker publication may bypass host firewall rules.\n' >&2
  fi
done
# stdin may carry the script itself (curl | bash). With sudo's use_pty option,
# /dev/tty is sudo's relay PTY and receives no input when sudo itself was piped.
# SUDO_TTY names the caller's terminal, which remains available for prompts.
prompt_input="${SUDO_TTY:-/dev/tty}"
if [ "$non_interactive" -eq 0 ]; then
{ [ -t 0 ]; } 2>/dev/null <"$prompt_input" ||
  fail "Interactive setup requires a terminal. Run this installer from a terminal, or use --non-interactive."
fi

host_os="$(uname -s)"
desktop=0
if [ "$host_os" = Darwin ] || { [ "$host_os" = Linux ] && grep -qi microsoft /proc/sys/kernel/osrelease; }; then desktop=1; fi
case "$host_os" in
  Linux) ;;
  Darwin)
    # Docker Desktop belongs to the logged-in user, including when the installer
    # was invoked with sudo. Keep that user's Docker context and credentials.
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
      docker_binary="$(command -v docker)" || fail "install and start Docker Desktop first"
      docker() { sudo -H -u "$SUDO_USER" "$docker_binary" "$@"; }
    fi ;;
  *) fail "Kintsugi System requires Linux or macOS with Docker Desktop" ;;
esac

root_required=0
docker_via_sudo=0
request_root() {
  if [ "$(id -u)" -ne 0 ] && [ "$root_required" -eq 0 ]; then
    command -v sudo >/dev/null || fail "sudo is required for Linux host setup; install sudo or run as root"
    finish_line
    printf '  Kintsugi needs administrator access to prepare this Linux host.\n'
    # Command-specific NOPASSWD rules can allow operations while rejecting sudo -v.
    # Test each actual command without allowing an unattended password prompt.
    root_required=1
  fi
}

run_root() {
  if [ "$root_required" -eq 1 ]; then
    if ! sudo -n "$@"; then
      [ "$non_interactive" -eq 0 ] || fail "Administrator access required for $1; run the reviewed installer as root or allow this command with NOPASSWD"
      sudo "$@" || fail "Administrator access was not granted for $1"
    fi
  else "$@"; fi
}

log_file="$(mktemp /tmp/kintsugi-install.XXXXXX)"
printf "\n  %sLet's get your Kintsugi setup!%s\n\n" "$violet" "$reset"
status "Preparing your server"
if ! command -v docker >/dev/null; then
  [ "$non_interactive" -eq 0 ] || [ "$install_docker" -eq 1 ] || fail "Docker is missing; install it first or explicitly allow --install-docker"
  [ "$action" != uninstall ] || fail "Docker is not installed; no installation can be inspected or removed"
  [ "$host_os" != Darwin ] || fail "install and start Docker Desktop first, then run this installer again"
  request_root
  if command -v apt-get >/dev/null; then
    run_quiet "Preparing your server · installing Docker" run_root apt-get update
    run_quiet "Preparing your server · installing Docker" run_root apt-get install -y docker.io
  elif command -v dnf >/dev/null; then
    run_quiet "Preparing your server · installing Docker" run_root dnf install -y docker
  else
    fail "install Docker first; automatic Docker installation supports apt-get and dnf"
  fi
  run_quiet "Starting Docker" run_root systemctl enable --now docker
fi
if [ "$host_os" = Linux ] && [ "$(id -u)" -ne 0 ] && ! docker info >>"$log_file" 2>&1; then
  request_root
  docker_binary="$(command -v docker)"
  docker() { sudo -n "$docker_binary" "$@"; }
  docker_via_sudo=1
fi
run_quiet "Checking Docker" docker info

installed=0
if docker container inspect "$system_name" >/dev/null 2>&1; then installed=1; fi
if [ "$installed" -eq 1 ]; then
  saved_storage_driver="$(docker inspect --format '{{index .Config.Labels "kintsugi.storage-driver"}}' "$system_name")"
  case "$saved_storage_driver" in ""|"<no value>") saved_storage_driver=erofs ;; erofs|overlayfs) ;; *) fail "Invalid saved storage driver" ;; esac
  [ -z "$storage_override" ] || [ "$storage_override" = "$saved_storage_driver" ] || fail "Cannot change an existing installation's storage driver; use a fresh installation"
  storage_driver="$saved_storage_driver"
fi
# Nested daemons share the host kernel; privileged containers cannot supply
# filesystem drivers missing from that kernel.
if [ "$action" != uninstall ] && [ "$host_os" = Linux ] && [ "$desktop" -eq 0 ]; then
  request_root
  filesystems=(overlay)
  if [ "$storage_driver" = erofs ]; then filesystems=(erofs overlay); fi
  for filesystem in "${filesystems[@]}"; do
    if ! grep -qw "$filesystem" /proc/filesystems; then
      if ! command -v modprobe >/dev/null || ! run_root modprobe "$filesystem"; then
        fail "The Linux kernel that powers your Docker does not have $filesystem, which Kintsugi requires."
      fi
      grep -qw "$filesystem" /proc/filesystems || fail "The Linux kernel that powers your Docker does not have $filesystem, which Kintsugi requires."
    fi
  done
  run_root mkdir -p /etc/modules-load.d
  printf '%s\n' "${filesystems[@]}" | run_root tee /etc/modules-load.d/kintsugi-system.conf >/dev/null
fi

# Upstream installations belong to their own installer; never delete their data.
if [ "$action" = uninstall ]; then
  new_volume="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
  legacy_system=0
  if docker container inspect atelier-system >/dev/null 2>&1; then legacy_system=1; fi
  legacy_volume="$(docker volume ls --format '{{.Name}}' --filter 'name=^atelier-system$')"
  legacy_container=0
  if docker container inspect atelier >/dev/null 2>&1; then legacy_container=1; fi
  if [ "$installed" -eq 1 ] || [ -n "$new_volume" ]; then
    if [ "$legacy_system" -eq 1 ] || [ -n "$legacy_volume" ] || [ "$legacy_container" -eq 1 ]; then
      printf '\n  Removing Kintsugi only. Atelier will remain; use its own installer to remove it.\n'
    fi
  elif [ "$legacy_system" -eq 1 ] || [ -n "$legacy_volume" ]; then
    fail "An upstream Atelier installation is present. Use its own uninstaller; Kintsugi has retained all of its data."
  elif [ "$legacy_container" -eq 1 ]; then
    fail "The old atelier container predates Atelier System. Automatic uninstall is not supported for that layout; its container and data have been retained."
  fi
fi
if [ "$action" != uninstall ] && { docker container inspect atelier-system >/dev/null 2>&1 || docker container inspect atelier >/dev/null 2>&1; }; then
  fail "Atelier is installed. Use its own installer to remove it; Kintsugi starts fresh and does not import Atelier data."
fi
if [ "$installed" -eq 0 ] && docker container inspect kintsugi >/dev/null 2>&1; then
  fail "an old Kintsugi container exists; this installer does not migrate old installations"
fi
if [ "$installed" -eq 0 ]; then
  case "$action" in
    uninstall) ;; # A previous removal may have left only the outer volume.
    ""|install|update) action=install ;;
    *) fail "Kintsugi System is not installed" ;;
  esac
elif [ "$action" = install ]; then
  fail "Kintsugi System is already installed; use --action update"
fi

# The supervisor owns app lifecycle and routing. Query locally so the host
# does not need tailnet access, curl, or a JSON parser.
supervisor_status() {
  docker exec "$system_name" bun -e '
    const r = await fetch("http://127.0.0.1:3001/status", {signal: AbortSignal.timeout(3000)});
    if (!r.ok) throw new Error(`Supervisor status: ${r.status}`);
    const clean = (text) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const url = (value) => {
      if (value === undefined) return "";
      if (typeof value !== "string" || !/^https?:$/.test(new URL(value).protocol) || /[\x00-\x20\x7f]/.test(value))
        throw new Error("Invalid System destination");
      return value;
    };
    try {
      const s = await r.json();
      const a = s.activity;
      if (!["starting", "ready", "failed"].includes(s.state) ||
          typeof a?.description !== "string" || !a.description.trim() ||
          (a.percent !== undefined && (typeof a.percent !== "number" ||
            !Number.isFinite(a.percent) || a.percent < 0 || a.percent > 100))) {
        throw new Error("Invalid supervisor status contract");
      }
      const appUrl = url(s.appUrl);
      if (s.state === "ready" && !appUrl) throw new Error("Ready without an app destination");
      console.log([
        s.state, clean(a.description), a.percent === undefined ? "" : Math.floor(a.percent),
        appUrl, clean(s.action?.description ?? ""), url(s.action?.url),
        ...(s.diagnostics?.lines ?? []).map(clean),
      ].join("\n"));
    } catch (error) {
      console.error(error);
      process.exit(2);
    }
  '
}
supervisor_connect() {
  docker exec "$system_name" bun -e '
    const r = await fetch("http://127.0.0.1:3001/connect", {
      method: "POST", signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`System connection request: ${r.status}`);
  '
}
check_system_running() {
  local state
  state="$(docker inspect --format '{{.State.Status}}' "$system_name" 2>>"$log_file")"
  if [ "$state" != running ]; then
    finish_line
    docker logs --tail 40 "$system_name" 2>&1 | tee -a "$log_file" >&2
    fail "Kintsugi services are $state. Container logs are shown above."
  fi
}
wait_for_system() {
  stop_on_failure=1
  local reply previous="" activity_start=$SECONDS start=$SECONDS description="Waiting for the supervisor" percent="" code pid status_file tick
  status_file="${log_file}.status"
  local request_connect=0 last_action="" current_action app_url
  local -a fields
  if [ "$action" = connect ] && [ "$access_mode" != localhost ]; then request_connect=1; fi
  while true; do
    check_system_running
    if [ "$request_connect" -eq 1 ]; then
      if supervisor_connect >>"$log_file" 2>&1; then request_connect=0; fi
    fi
    supervisor_status >"$status_file" 2>>"$log_file" &
    pid=$!
    active_pid=$pid
    while kill -0 "$pid" 2>/dev/null; do
      status "$description" "$((SECONDS-activity_start))s" "$percent"
      sleep 0.1
    done
    active_pid=""
    code=0
    wait "$pid" || code=$?
    reply="$(cat "$status_file")"
    if [ "$code" -eq 0 ]; then
      fields=()
      while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
      description="${fields[1]}"
      percent="${fields[2]:-}"
      app_url="${fields[3]:-}"
      current_action="${fields[4]:-}"$'\n'"${fields[5]:-}"
      if [ "${fields[0]}" != failed ] && [ -n "${fields[4]:-}" ] && [ "$current_action" != "$last_action" ]; then
        finish_line
        printf '\n  %s\n' "${fields[4]}"
        [ -z "${fields[5]:-}" ] || printf '\n  %s\n\n' "${fields[5]}"
        last_action="$current_action"
      fi
      if [ "$non_interactive" -eq 1 ] && [ -n "${fields[4]:-}" ]; then break; fi
      case "${fields[0]}" in
        ready) [ "$request_connect" -ne 0 ] || break ;;
        failed)
          finish_line
          printf '\n  %s! %s%s\n' "$amber" "$description" "$reset" >&2
          if [ "${#fields[@]}" -gt 6 ]; then printf '  %s\n' "${fields[@]:6}" >&2; fi
          exit 1 ;;
      esac
    else
      [ "$code" -ne 2 ] || fail "The supervisor returned an invalid status."
      description="Waiting for the supervisor"; percent=""
    fi
    if [ "${description%% · *}" != "$previous" ]; then activity_start=$SECONDS; previous="${description%% · *}"; fi
    status "$description" "$((SECONDS-activity_start))s" "$percent"
    [ "$((SECONDS-start))" -lt 2400 ] || fail "Kintsugi did not finish starting within 40 minutes."
    for ((tick=0; tick<10; tick++)); do
      status "$description" "$((SECONDS-activity_start))s" "$percent"
      sleep 0.1
    done
  done
  rm "$status_file"
  finish_line
  printf '  %s✓ %s%s\n\n  Open %s\n\n' "$green" "$description" "$reset" "$app_url"
}

uninstall_system() {
  local start=$SECONDS code reply token workspace_count state description remaining
  local -a fields
  if [ "$installed" -eq 1 ]; then
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      run_quiet "Starting System to inspect the uninstall inventory" docker start "$system_name"
    fi
    while true; do
      check_system_running
      code=0
      reply="$(docker exec --user root "$system_name" bun -e '
        let response;
        try {
          response = await fetch("http://supervisor/uninstall", {unix:"/run/kintsugi-system/uninstall.sock", signal:AbortSignal.timeout(3000)});
        } catch (error) { console.error(error); process.exit(75); }
        if (response.status === 503) process.exit(75);
        if (!response.ok) { console.error(await response.text()); process.exit(2); }
        const plan = await response.json();
        if (!Number.isSafeInteger(plan.workspaceCount) || plan.workspaceCount < 0 ||
            typeof plan.token !== "string" || !/^[a-f0-9]{64}$/.test(plan.token)) process.exit(2);
        console.log(`${plan.workspaceCount}\n${plan.token}`);
      ' 2>>"$log_file")" || code=$?
      case "$code" in
        0) break ;;
        75) ;;
        *) fail "Could not read workspace inventory. Nothing has been deleted. See the bootstrap log." ;;
      esac
      status "Waiting for System's uninstall inventory" "$((SECONDS-start))s"
      [ "$((SECONDS-start))" -lt 240 ] || fail "System's uninstall inventory is unavailable. Update System with --action update first. Nothing has been deleted."
      sleep 1
    done
    fields=()
    while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
    workspace_count="${fields[0]}"; token="${fields[1]}"
    finish_line
    printf '\n  %s workspaces will be permanently deleted, including parked workspaces.\n' "$workspace_count"
  else
    remaining="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
    if [ -z "$remaining" ]; then
      finish_line
      printf '\n  No installation container or volume remains. Nothing to uninstall.\n'
      return
    fi
    finish_line
    printf '\n  System was already removed, but its installation volume remains.\n  Workspace count unavailable: all remaining installation data will be deleted.\n'
  fi
  printf '\n  This also deletes workspace files, conversations, nested Docker data,\n  shared /persistent files, projects, settings, and locally saved credentials.\n  Nothing is imported into a new installation. Save anything you need first.\n\n'
  if [ "$non_interactive" -eq 1 ]; then answer="DELETE KINTSUGI"; else prompt answer "  Type DELETE KINTSUGI to confirm, or anything else to cancel: "; fi
  if [ "$answer" != "DELETE KINTSUGI" ]; then
    printf '\n  Uninstall cancelled. No data was deleted.\n'
    return
  fi
  if [ "$host_os" = Linux ] && [ "$no_updater" -eq 0 ] && [ -f /etc/systemd/system/kintsugi-updater.service ]; then
    run_root systemctl disable --now kintsugi-updater.service
  fi
  if [ "$installed" -eq 1 ]; then
    docker exec --user root "$system_name" bun -e '
      const response = await fetch("http://supervisor/uninstall", {
        unix:"/run/kintsugi-system/uninstall.sock", method:"POST",
        headers:{"content-type":"application/json"}, body:JSON.stringify({token:process.argv[1]}),
        signal:AbortSignal.timeout(3000),
      });
      if (response.status !== 202) throw new Error(`Uninstall request: ${response.status} ${await response.text()}`);
    ' "$token" >>"$log_file" 2>&1 || fail "System did not accept uninstall. Its container and volume have not been removed."
    start=$SECONDS
    while true; do
      check_system_running
      reply="$(docker exec --user root "$system_name" bun -e '
        const response = await fetch("http://127.0.0.1:3001/status", {signal:AbortSignal.timeout(3000)});
        if (!response.ok) throw new Error(`Uninstall status: ${response.status}`);
        const {uninstall} = await response.json();
        if (!["running","failed","complete"].includes(uninstall?.state) || typeof uninstall.description !== "string")
          throw new Error("Invalid uninstall status contract");
        console.log(`${uninstall.state}\n${uninstall.description.replace(/[\x00-\x1f\x7f-\x9f]/g," ")}`);
      ' 2>>"$log_file")" || fail "Could not read uninstall status. System and its volume were retained; run --uninstall again."
      fields=()
      while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
      state="${fields[0]}"; description="${fields[1]}"
      case "$state" in
        complete) break ;;
        failed) fail "Uninstall failed: $description System and its installation volume were retained; run --uninstall again." ;;
      esac
      status "$description" "$((SECONDS-start))s"
      [ "$((SECONDS-start))" -lt 2400 ] || fail "Uninstall did not finish within 40 minutes. System and its volume were retained."
      sleep 1
    done
    run_quiet "Stopping System" docker stop --time 120 "$system_name"
    run_quiet "Removing System" docker rm "$system_name"
  fi
  remaining="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
  if [ -n "$remaining" ]; then run_quiet "Deleting installation storage" docker volume rm "$system_name"; fi
  if [ "$host_os" = Linux ] && [ "$no_updater" -eq 0 ]; then
    request_root
    run_root rm -f /etc/tmpfiles.d/kintsugi-updater.conf
    run_root rm -rf /var/lib/kintsugi-updater
  fi
  remaining="$(docker ps -a --format '{{.Names}}' --filter "name=^${system_name}$")"
  [ -z "$remaining" ] || fail "System container still exists"
  remaining="$(docker volume ls --format '{{.Name}}' --filter "name=^${system_name}$")"
  [ -z "$remaining" ] || fail "Installation volume still exists"
  if [ "$host_os" = Linux ] && [ -f /etc/modules-load.d/kintsugi-system.conf ]; then
    request_root
    run_root rm /etc/modules-load.d/kintsugi-system.conf
  fi
  finish_line
  printf '\n  %s✓ Uninstalled. System and all installation data have been removed.%s\n  Docker and unrelated host resources were left installed.\n\n' "$green" "$reset"
}

if [ "$action" = uninstall ]; then
  uninstall_system
  exit 0
fi

if [ -z "$action" ]; then
  finish_line
  printf '  Welcome back.\n'
  prompt action "  Choose: open, update, rollback, connect, or quit: "
  [ "$action" != quit ] || exit 0
  case "$action" in connect|update|rollback|open) ;; *) fail "unknown action: $action" ;; esac
fi

if [ -n "$source_repository$tailscale_hostname$registry_config$app_image_override$system_image_override" ]; then
  case "$action" in install|update) ;; *) fail "Source, hostname, registry and image options require install or update" ;; esac
fi

if [ -n "$storage_override" ]; then
  case "$action" in install|update|rollback) ;; *) fail "--storage-driver requires install, update or rollback" ;; esac
fi

if [ -n "$proxy_config$preview_override$ui_publish$admin_proxy_publish$admin_bootstrap" ]; then
  case "$action" in install|update) ;; *) fail "Proxy/bootstrap options require install or update" ;; esac
fi
if [ "${#admin_publish[@]}" -gt 0 ] || [ "$admin_publish_disabled" -eq 1 ] || [ "$admin_allow_all" -eq 1 ]; then
  case "$action" in install|update) ;; *) fail "Admin publication options require --action install or update; Docker ports require container replacement" ;; esac
fi

# This portable Bun helper also runs in older System images, without app/module dependencies.
release_config_script="$(cat <<'INSTALLER_CONFIG_JS'
const [operation, sourceOverride, appOverride, systemOverride, hostnameOverride, systemId, preparedApp, credentialFile, previousSystemId, storageOverride, proxyOverride, accessOverride, previewOverride] = process.argv.slice(1);
const fs = await import('node:fs/promises');
const repositoryPattern = /^(?:ghcr\.io|docker\.io)\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const versionPattern = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|sha256:[a-f0-9]{64})$/;
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
async function read(path) {
  try { const value = JSON.parse(await fs.readFile(path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid installation settings'); return value; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw Error('Cannot read installation settings; refusing another source'); }
}
let settings = await read('/data/app/update.json');
const state = await read('/data/supervisor/state.json');
const history = await read('/data/supervisor/installer.json');
const previousProxy = state.proxy;
if (proxyOverride) state.proxy = JSON.parse(proxyOverride);
const rangeOverride = previewOverride && !['preserve-selection','normal-selection'].includes(previewOverride) ? previewOverride : '';
if (rangeOverride) {
  if (!state.proxy) throw Error('Preview port changes require saved proxy configuration or --public-origin');
  if (!/^41[0-9]{3}:41[0-9]{3}$/.test(rangeOverride)) throw Error('Invalid preview port range');
  const [start,end]=rangeOverride.split(':').map(Number);
  state.proxy={...state.proxy,previewPorts:{start,end}};
} else if (!proxyOverride && !operation.startsWith('rollback') && state.proxy?.previewPorts?.start===41000 && state.proxy.previewPorts.end===41009) {
  state.proxy={...state.proxy,previewPorts:{start:41000,end:41999}};
}
if (previousProxy && state.proxy && (state.proxy.previewPorts.start>previousProxy.previewPorts.start || state.proxy.previewPorts.end<previousProxy.previewPorts.end)) throw Error('Preview ranges can only expand; retained and retired origins must be preserved');
if (state.proxy) {
  const p=state.proxy; const url=new URL(p.origin);
  if (!['http:','https:'].includes(url.protocol) || url.origin !== p.origin || url.username || url.password || url.hostname.startsWith('[') || !p.previewPorts || !Number.isInteger(p.previewPorts.start) || !Number.isInteger(p.previewPorts.end) || p.previewPorts.start < 41000 || p.previewPorts.end > 41999 || p.previewPorts.end < p.previewPorts.start || Number(url.port)>=41000 && Number(url.port)<=41999 || Object.keys(p).some(k=>!['origin','previewPorts','adminPort'].includes(k))) throw Error('Invalid proxy configuration');
  if (p.adminPort !== undefined && (!Number.isInteger(p.adminPort) || p.adminPort < 1024 || p.adminPort>65535 || [2999,3000,3001,3080,3081,3082,24800].includes(p.adminPort) || p.adminPort>=41000 && p.adminPort<=41999)) throw Error('Invalid proxy admin port');
}
if (accessOverride) { if (!['localhost','proxy','tailscale'].includes(accessOverride)) throw Error('Invalid access mode'); state.accessMode=accessOverride; }
if (state.accessMode==='proxy' && !state.proxy) throw Error('Proxy mode requires --public-origin');
let storage;
try {
  storage = JSON.parse(await fs.readFile('/data/supervisor/storage.json','utf8'));
  if (!storage || typeof storage !== 'object' || Array.isArray(storage) || Object.keys(storage).length !== 1 || !['erofs','overlayfs'].includes(storage.driver)) throw Error('Invalid storage settings');
} catch(error) { if(error.code !== 'ENOENT') throw Error('Cannot read storage settings; nothing was replaced'); }
const storageDriver = storageOverride || storage?.driver || 'erofs';
if (!['erofs','overlayfs'].includes(storageDriver) || (storage && storage.driver !== storageDriver)) throw Error('Invalid or changed storage driver; nothing was replaced');
if (settings.releaseSelection !== undefined && !['stable','latest','custom'].includes(settings.releaseSelection)) throw Error('Invalid release selection');
if (settings.releaseChannel !== undefined && !['stable','latest'].includes(settings.releaseChannel)) throw Error('Invalid release channel');
if (settings.releaseMode !== undefined && !['upstream','custom'].includes(settings.releaseMode)) throw Error('Invalid release mode');
function validSource(source) {
  return source && typeof source === 'object' && !Array.isArray(source) && typeof source.appRepository === 'string' && typeof source.systemRepository === 'string' && Object.keys(source).every(key => ['appRepository','systemRepository','appVersion','systemVersion'].includes(key)) && repositoryPattern.test(source.appRepository ?? '') && repositoryPattern.test(source.systemRepository ?? '') && ['appVersion','systemVersion'].every(key => source[key] === undefined || typeof source[key] === 'string' && versionPattern.test(source[key]));
}
if (settings.releaseSource !== undefined && !validSource(settings.releaseSource)) throw Error('Invalid release source; refusing upstream fallback');
if (settings.releaseMode === 'custom' && !settings.releaseSource) throw Error('Custom source is missing');
const defaults = {appRepository:'ghcr.io/rcarmo/kintsugi',systemRepository:'ghcr.io/rcarmo/kintsugi-system'};
if (sourceOverride) {
  if (!repositoryPattern.test(sourceOverride)) throw Error('Use a GHCR or Docker Hub app repository');
  settings.releaseSource = {appRepository:sourceOverride,systemRepository:sourceOverride+'-system'};
  settings.releaseMode = sourceOverride === defaults.appRepository ? 'upstream' : 'custom';
}
const preserveSelection = process.argv[process.argv.length-1] === "preserve-selection";
const savedSettings = structuredClone(settings);
const overrides = {app:appOverride,system:systemOverride};
for (const [component, reference] of Object.entries(overrides)) {
  if (!reference) continue;
  if (!imagePattern.test(reference)) throw Error('Invalid explicit image reference');
  if (!/^(ghcr\.io|docker\.io)\//.test(reference)) continue; // Local overrides are deliberate one-off selections.
  const match = /^((?:ghcr\.io|docker\.io)\/[a-z0-9._/-]+)(?::([^/@]+)|@(sha256:[a-f0-9]{64}))?$/.exec(reference);
  if (!match) throw Error('Invalid release image override');
  const source = {...(settings.releaseMode === 'upstream' ? defaults : settings.releaseSource ?? defaults)};
  source[component+'Repository'] = match[1];
  if (match[3] || match[2]) source[component+'Version'] = match[3] || match[2]; else delete source[component+'Version'];
  if (!validSource(source)) throw Error('Invalid release image override');
  settings.releaseSource = source; settings.releaseMode = 'custom'; settings.releaseSelection = 'custom';
}
const source = settings.releaseMode === 'upstream' ? defaults : settings.releaseSource ?? defaults;
function reference(component) {
  if (overrides[component]) return overrides[component];
  const version = source[component+'Version'] ?? settings.releaseChannel ?? 'latest';
  return source[component+'Repository']+(version.startsWith('sha256:')?'@':':')+version;
}
const hostname = hostnameOverride || state.tailscaleHostname || 'kintsugi-system';
if (typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw Error('Use a Tailscale hostname with 1–63 lowercase letters, digits or hyphens');
let registryAuth;
if (credentialFile) {
  let credentials;
  if (credentialFile === '-') {
    try { credentials = JSON.parse(await new Response(Bun.stdin.stream()).text()); }
    catch { throw Error('Cannot read registry credentials'); }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw Error('Invalid registry credentials');
  } else credentials = await read(credentialFile);
  registryAuth = credentials.auths?.['ghcr.io']?.auth;
  if (Object.keys(credentials).some(key => key !== 'auths') || typeof registryAuth !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(registryAuth)) throw Error('Registry config must contain inline GHCR auth only, without credential helpers');
}
async function write(path,value,owner) {
  const temporary = path+'.installer-'+crypto.randomUUID();
  await fs.writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});
  if (owner) await fs.chown(temporary,1000,1000);
  await fs.rename(temporary,path);
}
async function writeAuth() {
  await fs.mkdir('/data/supervisor/docker-auth',{recursive:true,mode:0o700}); await fs.chmod('/data/supervisor/docker-auth',0o700);
  await write('/data/supervisor/docker-auth/config.json',{auths:{'ghcr.io':{auth:registryAuth}}},false);
}
if (operation === 'auth-check') {
  const credentials = await read('/data/supervisor/docker-auth/config.json');
  if (credentials.auths?.['ghcr.io']?.auth !== undefined && (typeof credentials.auths['ghcr.io'].auth !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(credentials.auths['ghcr.io'].auth))) throw Error('Invalid saved registry auth');
  console.log(credentials.auths?.['ghcr.io']?.auth ? '1' : '0');
} else if (operation === 'credentials') {
  if (!registryAuth) throw Error('Registry auth is required');
  await writeAuth();
 } else if (operation === 'resource-data-version') {
  let directories;
  try { directories = await fs.readdir('/data/app/workspaces', {withFileTypes:true}); } catch(error) {if(error.code!=='ENOENT')throw error;directories=[];}
  const globalPolicy=await read('/data/app/workspace-resource-policy.json');
  if(Object.keys(globalPolicy).length&&(!Number.isSafeInteger(globalPolicy.version)||globalPolicy.version<2))throw Error('Invalid global resource policy');
  let version=globalPolicy.version??0;
  for(const entry of directories){if(!entry.isDirectory())continue;const marker=await read('/data/app/workspaces/'+entry.name+'/metadata/resource-policy.json');if(!Object.keys(marker).length)continue;if(!Number.isSafeInteger(marker.version)||marker.version<1)throw Error('Invalid resource-policy marker');version=Math.max(version,marker.version);}
  console.log(version);
} else if (operation === 'network-data-version') {
  const policies = await read('/data/supervisor/workspace-networks.json');
  let required = Object.values(policies).some(policy => policy && typeof policy === 'object' && policy.mode === 'hosts') ? 2 : 0;
  let workspaces;
  try { workspaces = (await fs.readdir('/data/app/workspaces', {withFileTypes:true})).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch(error) { if(error.code !== 'ENOENT') throw Error('Cannot inspect network policy compatibility'); workspaces = []; }
  for (const id of workspaces) {
    const saved = await read('/data/app/workspaces/'+id+'/metadata/network.json');
    if (saved.mode === 'hosts' || saved.applied?.mode === 'hosts') required = 2;
  }
  process.stdout.write(String(required)+"\n");
 } else if (operation === 'resource-limits') {
  const limits = await read('/data/supervisor/system-resource-policy.json');
  if (Object.keys(limits).length) {
    if (![limits.memory,limits.memorySwap,limits.nanoCpus,limits.pids].every(n=>Number.isSafeInteger(n)&&n>0) || limits.memorySwap<limits.memory) throw Error('Invalid saved System resource policy');
    console.log([limits.memory,limits.memorySwap,limits.nanoCpus,limits.pids].join(' '));
  }
} else if (operation === 'rollback-plan') {
  if (!imageIdPattern.test(history.previousSystemImage ?? '') || !imageIdPattern.test(history.previousAppImage ?? '')) throw Error('No retained System/app rollback pair');
  console.log([history.previousSystemImage,history.previousAppImage,hostname].join('\n'));
} else if (operation === 'plan') {
  console.log([reference('system'),reference('app'),hostname].join('\n'));
} else if (operation === 'apply' || operation === 'rollback-apply') {
  if (!imageIdPattern.test(systemId)) throw Error('System must be pinned before replacement');
  if (preparedApp && !imageIdPattern.test(preparedApp)) throw Error('App must be pinned before replacement');
  await fs.mkdir('/data/app', {recursive:true}); await fs.mkdir('/data/supervisor', {recursive:true});
  await write('/data/app/update.json',preserveSelection ? savedSettings : settings,true);
  await write('/data/supervisor/storage.json',{driver:storageDriver},false);
  state.tailscaleHostname = hostname;
  const previousAppImage = state.currentImage ?? null;
  if (operation === 'rollback-apply') {
    state.previousImage = state.currentImage;
    state.currentImage = preparedApp;
    delete state.pendingImage;
  } else if (preparedApp) state.pendingImage = preparedApp;
  await write('/data/supervisor/state.json',state,false);
  await write('/data/supervisor/installer.json',{currentSystemImage:systemId,previousSystemImage:previousSystemId || history.currentSystemImage || null,previousAppImage},false);
  if (registryAuth) await writeAuth();
} else throw Error('Unknown installer configuration operation');
INSTALLER_CONFIG_JS
)"
release_plan() {
  if [ -n "$registry_directory" ]; then
    docker run --rm -i --network none --entrypoint bun --mount "source=$system_name,target=/data,readonly" "$1" -e "$release_config_script" "${2:-plan}" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "" "" - "" "$storage_driver" "$proxy_config" "$access_mode" "$preview_override" "$([ "$preserve_release_selection" -eq 1 ] && echo preserve-selection || echo normal-selection)" < "$registry_directory/config.json"
  else
    docker run --rm --network none --entrypoint bun --mount "source=$system_name,target=/data,readonly" "$1" -e "$release_config_script" "${2:-plan}" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "" "" "" "" "$storage_driver" "$proxy_config" "$access_mode" "$preview_override" "$([ "$preserve_release_selection" -eq 1 ] && echo preserve-selection || echo normal-selection)"
  fi
}
host_pull() {
  if [ -z "$registry_directory" ] && [ "$installed" -eq 1 ] && [ "$(id -u)" -eq 0 ]; then
    host_data="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$system_name")"
    if [ -f "$host_data/supervisor/docker-auth/config.json" ]; then docker --config "$host_data/supervisor/docker-auth" pull "$1"; return; fi
  fi
  if [ -n "$registry_directory" ]; then docker --config "$registry_directory" pull "$1"; else docker pull "$1"; fi
}
prepare_installed_app() {
  docker exec "$system_name" bun -e '
    const reference=process.argv[1];
    const driver=process.argv[2];
    const rollback=process.argv[3]==="rollback";
    const deployment=process.argv[4]==="1";
    function compatible(image) { if(driver==="overlayfs" && !image.Config.Labels?.["kintsugi.storage-drivers"]?.split(",").includes(driver)) throw Error("Image does not support overlayfs; existing services were retained"); }
    async function docker(...args) {
      const p=Bun.spawn(["docker","--config","/data/supervisor/docker-auth",...args],{stdout:"pipe",stderr:"pipe"});
      const deadline=setTimeout(()=>p.kill(),1800000);
      const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
      clearTimeout(deadline);
      if(code!==0)throw new Error("Cannot prepare the selected app or its dependencies; existing services were retained");
      return out.trim();
    }
    if(!rollback && /^(ghcr\.io|docker\.io)\//.test(reference)) await docker("pull",reference);
    const image=JSON.parse(await docker("image","inspect",reference))[0];
    compatible(image);
    if(deployment && image.Config.Labels?.["kintsugi.deployment-config"]!=="1") throw Error("Selected app lacks deployment configuration support; nothing was replaced");
    const dependencies=JSON.parse(image.Config.Labels?.["eagerly-preload"]??"[]");
    if(!Array.isArray(dependencies)||dependencies.length>100||dependencies.some(ref=>typeof ref!=="string"||! /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(ref)))throw new Error("Invalid workspace dependency references");
    for(const dependency of dependencies){
      if(!rollback && /^(ghcr\.io|docker\.io)\//.test(dependency))await docker("pull",dependency);
      compatible(JSON.parse(await docker("image","inspect",dependency))[0]);
    }
    console.log(image.Id);
  ' "$app_image" "$storage_driver" "$action" "$deployment_required"
}

case "$action" in
  install|update|rollback)
    if [ "$installed" -eq 1 ]; then
      finish_line
      printf '  %sUpdating interrupts running workspaces.%s\n' "$amber" "$reset"
      if [ "$non_interactive" -eq 1 ]; then [ "$confirm_replace" -eq 1 ] || fail "Replacement requires --confirm-replace"; answer=yes; else prompt answer "  Continue? [y/N]: "; fi
      case "$answer" in y|Y|yes) ;; *) exit 0 ;; esac
    fi
    if [ "$installed" -eq 0 ] && [ -z "$access_mode" ]; then
      if [ "$desktop" -eq 1 ]; then access_mode=localhost; else access_mode=tailscale; fi
      finish_line
      local_caption="Installation computer only — Tailscale stays off"
      remote_caption="Devices on your Tailscale network — including the installation computer"
      if [ "$access_mode" = localhost ]; then
        first_caption="$local_caption"; second_caption="$remote_caption"; alternate_mode=tailscale
      else
        first_caption="$remote_caption"; second_caption="$local_caption"; alternate_mode=localhost
      fi
      printf '  1. %s\n' "$first_caption"
      printf '  %s2. %s%s\n' "$dim" "$second_caption" "$reset"
      prompt answer "  Choose [1]: "
      case "${answer:-1}" in 1) ;; 2) access_mode="$alternate_mode" ;; *) fail "choose 1 or 2" ;; esac
    fi
    if [ "$installed" -eq 0 ]; then
      if [ -z "$source_repository" ] && [ -n "$app_image_override" ] && [ -n "$system_image_override" ]; then source_repository=ghcr.io/rcarmo/kintsugi; fi
      if [ -z "$source_repository" ]; then
        prompt source_repository "  Release image repository [ghcr.io/rcarmo/kintsugi]: "
        source_repository="${source_repository:-ghcr.io/rcarmo/kintsugi}"
      fi
      if [ -z "$tailscale_hostname" ]; then
        prompt tailscale_hostname "  Tailscale hostname [kintsugi-system]: "
        tailscale_hostname="${tailscale_hostname:-kintsugi-system}"
      fi
      [[ "$source_repository" =~ ^(ghcr\.io|docker\.io)/[a-z0-9]+([._-][a-z0-9]+)*/[a-z0-9]+([._/-][a-z0-9]+)*$ ]] || fail "Use a GHCR or Docker Hub app repository"
      [[ "$tailscale_hostname" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "Invalid Tailscale hostname"
      system_image="${system_image_override:-$source_repository-system:latest}"
      app_image="${app_image_override:-$source_repository:latest}"
    else
      old_system_image="$(docker inspect --format '{{.Image}}' "$system_name")"
      network_data_version="$(release_plan "$old_system_image" network-data-version 2>>"$log_file")" || fail "Cannot verify network policy compatibility; nothing was replaced"
      case "$network_data_version" in 0|2) ;; *) fail "Invalid network policy compatibility state; nothing was replaced" ;; esac
      resource_data_version="$(release_plan "$old_system_image" resource-data-version 2>>"$log_file")" || fail "Cannot verify resource policy compatibility; nothing was replaced"
      case "$resource_data_version" in 0|1|2|3) ;; *) fail "Resource settings require a newer installer; nothing was replaced" ;; esac
      plan_operation=plan; if [ "$action" = rollback ]; then plan_operation=rollback-plan; fi
      plan="$(release_plan "$old_system_image" "$plan_operation" 2>>"$log_file")" || fail "Cannot read the saved release source; nothing was replaced"
      plan_fields=(); while IFS= read -r field; do plan_fields+=("$field"); done <<<"$plan"
      [ "${#plan_fields[@]}" -eq 3 ] || fail "Invalid saved release plan; nothing was replaced"
      system_image="${plan_fields[0]}"; app_image="${plan_fields[1]}"; tailscale_hostname="${plan_fields[2]}"
    fi
    if [ -z "$registry_config" ] && [ "$installed" -eq 1 ] && [ "$action" != rollback ]; then
      auth_present="$(release_plan "$old_system_image" auth-check 2>>"$log_file")" || fail "Cannot inspect saved registry access"
      case "$auth_present" in
        1)
          registry_directory="$(mktemp -d /tmp/kintsugi-registry.XXXXXX)"; chmod 700 "$registry_directory"
          if [ "$host_os" = Darwin ] && [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then chown "$SUDO_USER" "$registry_directory"; fi
          docker cp "$system_name:/data/supervisor/docker-auth/config.json" "$registry_directory/config.json" >>"$log_file" 2>&1 || fail "Cannot read saved registry access"
          chmod 600 "$registry_directory/config.json" ;;
        0) ;;
        *) fail "Invalid saved registry access status" ;;
      esac
    fi
    if [ -n "$registry_config" ]; then
      [ -f "$registry_config" ] || fail "Registry config file not found"
      registry_directory="$(mktemp -d /tmp/kintsugi-registry.XXXXXX)"
      chmod 700 "$registry_directory"
      cp "$registry_config" "$registry_directory/config.json"; chmod 600 "$registry_directory/config.json"
    fi
    if [ -n "$registry_directory" ] && [ "$host_os" = Darwin ] && [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
      chown "$SUDO_USER" "$registry_directory" "$registry_directory/config.json"
    fi
    # Preserve existing publications unless the caller explicitly replaces/removes them.
    admin_port_args=()
    if [ "$installed" -eq 1 ] && [ "${#admin_publish[@]}" -eq 0 ] && [ "$admin_publish_disabled" -eq 0 ]; then
      saved_publications="$(docker inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{if and (ne $port "3080/tcp") (ne $port "3081/tcp") (ne $port "3082/tcp")}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}:{{$port}}{{println}}{{end}}{{end}}{{end}}' "$system_name")"
      while IFS= read -r mapping; do
        [ -n "$mapping" ] || continue
        port="${mapping##*:}"; address="${mapping%:*}"
        host_port="${address##*:}"; host_ip="${address%:*}"
        if [[ "$host_ip" == *:* ]]; then host_ip="[$host_ip]"; fi
        # Explicit proxy mappings replace legacy sidecar bindings at the same host endpoint.
        if [[ "$ui_publish" == "$host_ip:$host_port:"* || "$admin_proxy_publish" == "$host_ip:$host_port:"* ]]; then continue; fi
        admin_port_args+=(--publish "$host_ip:$host_port:$port")
      done <<<"$saved_publications"
    fi
    for mapping in "${admin_publish[@]}"; do admin_port_args+=(--publish "$mapping"); done
    # Docker persists explicit resource intent; preserve it across replacement and rollback.
    # Previously unbounded installs receive a finite budget, leaving a quarter of Docker-host RAM/CPU outside System.
    resource_args=()
    host_memory="$(docker info --format '{{.MemTotal}}')"
    host_cpus="$(docker info --format '{{.NCPU}}')"
    [[ "$host_memory" =~ ^[1-9][0-9]*$ && "$host_cpus" =~ ^[1-9][0-9]*$ ]] || fail "Cannot determine Docker host resource capacity; nothing was replaced"
    memory_limit=0; swap_limit=0; nano_cpus=0; pid_limit=0
    if [ "$installed" -eq 1 ]; then
      saved_limits="$(docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}} {{if .HostConfig.PidsLimit}}{{.HostConfig.PidsLimit}}{{else}}0{{end}}' "$system_name")"
      read -r memory_limit swap_limit nano_cpus pid_limit <<< "$saved_limits"
      if [ "$memory_limit" = 0 ]; then
        remembered_limits="$(release_plan "$old_system_image" resource-limits)" || fail "Cannot read saved System resource policy; nothing was replaced"
        if [ -n "$remembered_limits" ]; then
          read -r remembered_memory remembered_swap remembered_cpu remembered_pids <<< "$remembered_limits"
          memory_limit="$remembered_memory"
          [ "$swap_limit" -ne 0 ] || swap_limit="$remembered_swap"
          [ "$nano_cpus" -ne 0 ] || nano_cpus="$remembered_cpu"
          [ "$pid_limit" -gt 0 ] || pid_limit="$remembered_pids"
        fi
      fi
      [[ "$memory_limit" =~ ^[0-9]+$ && "$swap_limit" =~ ^-?[0-9]+$ && "$nano_cpus" =~ ^[0-9]+$ && "$pid_limit" =~ ^-?[0-9]+$ ]] || fail "Cannot read saved System limits; nothing was replaced"
    fi
    if [ "$memory_limit" -eq 0 ]; then
      available_memory="$host_memory"
      if [ "$host_os" = Linux ] && [ -r /proc/meminfo ]; then
        available_memory="$(awk '/^MemAvailable:/ {printf "%.0f", $2 * 1024}' /proc/meminfo)"
        [[ "$available_memory" =~ ^[1-9][0-9]*$ ]] || fail "Cannot read available host memory; nothing was replaced"
        if [ "$installed" -eq 1 ]; then
          current_percent="$(docker stats --no-stream --format '{{.MemPerc}}' "$system_name")"
          current_percent="${current_percent%%%}"
          [[ "$current_percent" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "Cannot sample existing System memory; nothing was replaced"
          available_memory="$(awk -v free="$available_memory" -v total="$host_memory" -v percent="$current_percent" 'BEGIN {printf "%.0f", free + total * percent / 100}')"
        fi
      fi
      if [ "$available_memory" -gt "$host_memory" ]; then available_memory="$host_memory"; fi
      memory_limit=$((available_memory * 3 / 4)); swap_limit="$memory_limit"
    fi
    [ "$memory_limit" -ge 3221225472 ] || fail "System needs 3 GiB within its resource budget; free or increase Docker host memory before updating"
    [ "$memory_limit" -le "$host_memory" ] || fail "Saved System RAM limit exceeds Docker host capacity; nothing was replaced"
    if [ "$swap_limit" -eq 0 ]; then swap_limit="$memory_limit"; fi
    [ "$swap_limit" -ne -1 ] || fail "System has unlimited swap; select a finite Docker memory-swap limit before updating"
    [ "$swap_limit" -ge "$memory_limit" ] || fail "Saved memory-swap limit is smaller than RAM; nothing was replaced"
    if [ "$nano_cpus" -eq 0 ]; then nano_cpus=$((host_cpus * 750000000)); fi
    if [ "$pid_limit" -le 0 ]; then pid_limit=8192; fi
    [ "$pid_limit" -ge 2048 ] || fail "System requires at least 2048 processes; nothing was replaced"
    resource_args=(--memory "$memory_limit" --memory-swap "$swap_limit" --cpus "$(printf '%d.%09d' "$((nano_cpus / 1000000000))" "$((nano_cpus % 1000000000))")" --pids-limit "$pid_limit")
    # Proxy mappings have their own reserved ports; never discard them with --no-admin-publish.
    proxy_port_args=()
    saved_proxy=""
    if [ "$installed" -eq 1 ]; then
      saved_proxy="$(docker inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{if or (eq $port "3081/tcp") (eq $port "3082/tcp")}}{{range $bindings}}{{.HostIp}}:{{.HostPort}}:{{$port}}{{println}}{{end}}{{end}}{{end}}' "$system_name")"
      while IFS= read -r mapping; do
        [ -n "$mapping" ] || continue
        case "$mapping" in *:3081/tcp) [ -n "$ui_publish" ] || proxy_port_args+=(--publish "$mapping") ;; *:3082/tcp) [ -n "$admin_proxy_publish" ] || proxy_port_args+=(--publish "$mapping") ;; esac
      done <<<"$saved_proxy"
    fi
    [ -z "$ui_publish" ] || proxy_port_args+=(--publish "$ui_publish")
    [ -z "$admin_proxy_publish" ] || proxy_port_args+=(--publish "$admin_proxy_publish")
    deployment_required=0
    if [ -n "$proxy_config$admin_bootstrap" ] || [ "$access_mode" = proxy ] || [ "${#proxy_port_args[@]}" -gt 0 ]; then deployment_required=1; fi
    if [ "$host_os" = Linux ] && [ "$no_updater" -eq 0 ]; then
      command -v systemctl >>"$log_file" 2>&1 || fail "Host updater requires systemd; use --no-updater only for an app-only installation"
      systemctl show-environment >>"$log_file" 2>&1 || fail "Host updater requires a running systemd manager; use --no-updater for an app-only installation"
    fi
    if [ "$host_os" = Linux ] && [ "$no_updater" -eq 0 ]; then
      # tmpfiles runs before Docker at boot; the updater itself must stay after Docker.
      run_root install -d -m 755 /etc/tmpfiles.d
      run_root install -m 644 -o root -g root /dev/stdin /etc/tmpfiles.d/kintsugi-updater.conf <<'UPDATER_TMPFILES'
d /run/kintsugi-updater 0700 root root -
UPDATER_TMPFILES
      run_root systemd-tmpfiles --create /etc/tmpfiles.d/kintsugi-updater.conf
      updater_mount=(--mount "type=bind,source=/run/kintsugi-updater,target=/run/kintsugi-updater,readonly")
    fi
    pull_log_start="$(($(wc -l <"$log_file") + 1))"
    if [ "$action" = rollback ]; then
      docker image inspect "$system_image" >>"$log_file" 2>&1 || fail "Previous System image is no longer retained; nothing was replaced"
    fi
    if [[ "$system_image" == ghcr.io/* || "$system_image" == docker.io/* ]] || ! docker image inspect "$system_image" >>"$log_file" 2>&1; then
    if ! run_quiet_status "Downloading Kintsugi services" host_pull "$system_image"; then
      fail "Cannot pull the selected System image. Check the repository and Docker registry login; no upstream fallback was attempted. See the bootstrap log."
    fi
    fi
    requested_system_image="$system_image"
    system_image="$(docker image inspect --format '{{.Id}}' "$system_image")"
    [[ "$system_image" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "System image was not pinned; nothing was replaced"
    if [ "$action" != rollback ]; then
      capability="$(docker image inspect --format '{{index .Config.Labels "kintsugi.installer-config"}}' "$system_image")"
      [ "$capability" = 1 ] || fail "The selected System image does not support this installer. Use a System image built from the fork release-source branch; nothing was replaced"
    fi
    if [ "$storage_driver" = overlayfs ]; then
      storage_capability="$(docker image inspect --format '{{index .Config.Labels "kintsugi.storage-drivers"}}' "$system_image")"
      [[ ",$storage_capability," == *,overlayfs,* ]] || fail "The selected System image does not support overlayfs; nothing was replaced"
    fi
    if [ "$deployment_required" -eq 1 ]; then
      [ "$(docker image inspect --format '{{index .Config.Labels "kintsugi.deployment-config"}}' "$system_image")" = 1 ] || fail "Selected System lacks deployment configuration support; nothing was replaced"
    fi
    if [ "$host_os" = Linux ] && [ "$no_updater" -eq 0 ] && [ "$action" != rollback ]; then
      [ "$(docker image inspect --format '{{index .Config.Labels "kintsugi.host-updater"}}' "$system_image")" = 1 ] || fail "Selected System lacks the default host updater; use a matching new release"
    fi
    if [ "$host_os" = Linux ] && [ "$no_updater" -eq 0 ] && [ "$action" != rollback ]; then
  updater_files="$(mktemp -d /tmp/kintsugi-updater.XXXXXX)"
  updater_container="$(docker create --entrypoint /bin/true "$system_image")"
  if ! { docker cp "$updater_container:/usr/local/bin/bun" "$updater_files/bun" && docker cp "$updater_container:/opt/kintsugi-system/host-updater.js" "$updater_files/updater.js" && docker cp "$updater_container:/opt/kintsugi-system/install.sh" "$updater_files/install.sh"; }; then
    docker rm "$updater_container" >>"$log_file" 2>&1
    fail "Could not extract the host updater"
  fi
  docker rm "$updater_container" >>"$log_file" 2>&1
  chmod 755 "$updater_files/bun"
  "$updater_files/bun" --version >>"$log_file" 2>&1 || fail "Packaged updater runtime cannot run on this host"
    fi
    # Validate the persisted plan with the exact selected image before stopping anything.
    plan="$(release_plan "$system_image" "${plan_operation:-plan}" 2>>"$log_file")" || fail "The selected System image cannot validate this installation"
    plan_fields=(); while IFS= read -r field; do plan_fields+=("$field"); done <<<"$plan"
    [ "${#plan_fields[@]}" -eq 3 ] && [ "${plan_fields[0]}" = "$requested_system_image" ] || fail "Release settings changed during preparation; nothing was replaced"
    app_image="${plan_fields[1]}"; tailscale_hostname="${plan_fields[2]}"
    if [ "$installed" -eq 1 ]; then
      if [ "$action" != rollback ] && [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
        run_quiet "Starting System to prepare the selected app" docker start "$system_name"
      fi
      if [ -n "$registry_directory" ]; then
        run_quiet "Preparing private registry access" docker run --rm -i --network none --entrypoint bun --mount "source=$system_name,target=/data" "$system_image" -e "$release_config_script" credentials "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "" "" - "" "$storage_driver" "$proxy_config" "$access_mode" "$preview_override" "$([ "$preserve_release_selection" -eq 1 ] && echo preserve-selection || echo normal-selection)" < "$registry_directory/config.json"
      fi
      if [ "$action" = rollback ]; then
        pinned_app="$app_image"
        if [ "$storage_driver" = overlayfs ]; then
          [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" = true ] || run_quiet "Starting System to validate rollback images" docker start "$system_name"
          pinned_app="$(prepare_installed_app 2>>"$log_file")" || fail "Previous images do not support overlayfs; nothing was replaced"
        fi
      else
        for ((attempt=0; attempt<60; attempt++)); do
          if docker exec "$system_name" docker info >>"$log_file" 2>&1; then break; fi
          sleep 1
        done
        [ "$attempt" -lt 60 ] || fail "Inner Docker is unavailable; existing System was not replaced"
        pinned_app="$(prepare_installed_app 2>>"$log_file")" || fail "Cannot prepare the selected app; existing System was not replaced"
      fi
      [[ "$pinned_app" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "App image was not pinned; nothing was replaced"
    fi
    if [ "$installed" -eq 1 ] && [ "${network_data_version:-0}" -gt 0 ]; then
      target_network_version="$(docker image inspect --format '{{index .Config.Labels "org.kintsugi.system-version"}}' "$system_image")"
      [[ "$target_network_version" =~ ^[1-9][0-9]{0,9}$ ]] && [ "$target_network_version" -le 2147483647 ] && [ "$target_network_version" -ge "$network_data_version" ] || fail "Listed-host settings require compatible installation images. Apply Off before downgrading; nothing was replaced"
      if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" = true ]; then
        target_app_network_version="$(docker exec "$system_name" docker image inspect --format '{{index .Config.Labels "org.kintsugi.network-policy-version"}}' "$pinned_app")" || fail "Cannot inspect app network compatibility; nothing was replaced"
        [[ "$target_app_network_version" =~ ^[1-9][0-9]{0,9}$ ]] && [ "$target_app_network_version" -le 2147483647 ] && [ "$target_app_network_version" -ge "$network_data_version" ] || fail "Listed-host settings require compatible app images. Apply Off before downgrading; nothing was replaced"
      fi
      # Offline recovery is allowed only with a compatible System; it validates app/data before activation.
    fi
    if [ "$installed" -eq 1 ] && [ "${resource_data_version:-0}" -gt 0 ]; then
      resource_system_version="$(docker image inspect --format '{{index .Config.Labels "org.kintsugi.system-version"}}' "$system_image")"
      required_resource_system=3
      if [ "$resource_data_version" -ge 3 ]; then required_resource_system=5; elif [ "$resource_data_version" -ge 2 ]; then required_resource_system=4; fi
      [[ "$resource_system_version" =~ ^[0-9]+$ ]] && [ "$resource_system_version" -ge "$required_resource_system" ] || fail "Saved resource limits require resource-aware installation images; nothing was replaced"
      if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" = true ]; then
        resource_app_version="$(docker exec "$system_name" docker image inspect --format '{{index .Config.Labels "org.kintsugi.resource-policy-version"}}' "$pinned_app")" || fail "Cannot inspect resource reader compatibility; nothing was replaced"
        [[ "$resource_app_version" =~ ^[0-9]+$ ]] && [ "$resource_app_version" -ge "$resource_data_version" ] || fail "Saved resource limits require a resource-aware app image; nothing was replaced"
      fi
    fi
    if [ "$installed" -eq 1 ] && [ -n "$admin_bootstrap" ]; then
      docker exec -i "$system_name" docker run --rm -i --network none --mount type=bind,source=/data/app,target=/data/app,readonly --entrypoint bun "$pinned_app" /app/apps/web/scripts/admin-bindings.ts bootstrap --file /dev/stdin --check < "$admin_bootstrap" >>"$log_file" 2>&1 || fail "Invalid admin bootstrap; existing services were retained"
    fi
    if [ "$installed" -eq 1 ]; then
      run_quiet "Stopping Kintsugi services" docker stop --time 120 "$system_name"
      run_quiet "Replacing Kintsugi services" docker rm "$system_name"
    fi
    apply_operation=apply; if [ "$action" = rollback ]; then apply_operation=rollback-apply; fi
    if [ -n "$registry_directory" ]; then
      run_quiet "Saving installation source and hostname" docker run --rm -i --network none --entrypoint bun --mount "source=$system_name,target=/data" "$system_image" -e "$release_config_script" "$apply_operation" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "$system_image" "$pinned_app" - "$old_system_image" "$storage_driver" "$proxy_config" "$access_mode" "$preview_override" "$([ "$preserve_release_selection" -eq 1 ] && echo preserve-selection || echo normal-selection)" < "$registry_directory/config.json"
    else
      run_quiet "Saving installation source and hostname" docker run --rm --network none --entrypoint bun --mount "source=$system_name,target=/data" "$system_image" -e "$release_config_script" "$apply_operation" "$source_repository" "$app_image_override" "$system_image_override" "$tailscale_hostname" "$system_image" "$pinned_app" "" "$old_system_image" "$storage_driver" "$proxy_config" "$access_mode" "$preview_override" "$([ "$preserve_release_selection" -eq 1 ] && echo preserve-selection || echo normal-selection)"
    fi
    stop_on_failure=1
    run_quiet "Starting Kintsugi services" docker run -d --name "$system_name" --label "kintsugi.storage-driver=$storage_driver" --hostname "$tailscale_hostname" --privileged --cgroupns=host --restart unless-stopped \
      --stop-timeout 120 "${resource_args[@]}" --tmpfs /run --mount "source=$system_name,target=/data" --publish 127.0.0.1:3080:3080 "${admin_port_args[@]}" "${proxy_port_args[@]}" "${updater_mount[@]}" \
      "$system_image" --app-image "$app_image" --access-mode "${access_mode:-tailscale}"
    ;;
  connect)
    access_mode="${access_mode:-tailscale}"
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      stop_on_failure=1
      run_quiet "Starting Kintsugi services" docker start "$system_name"
    fi
    ;;
  open) ;;
esac
if [ "$action" = install ] || [ "$action" = update ] || [ "$action" = rollback ] || [ "$action" = connect ] || [ -n "$access_mode" ]; then
  local_port="$(docker inspect --format '{{(index (index .HostConfig.PortBindings "3080/tcp") 0).HostPort}}' "$system_name")"
  for ((attempt=0; attempt<60; attempt++)); do
    check_system_running
    if docker exec "$system_name" bun -e '
      const [localPort, mode] = process.argv.slice(1);
      const response = await fetch("http://127.0.0.1:3001/access", {
        method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({localPort:Number(localPort), ...(mode ? {mode} : {})}),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`System access setup: ${response.status}`);
    ' "$local_port" "$access_mode" >>"$log_file" 2>&1; then break; fi
    sleep 1
  done
  [ "$attempt" -lt 60 ] || fail "Could not configure access"
fi
wait_for_system
if [ -n "$admin_bootstrap" ]; then
  # Secrets travel only to an exclusive private file or the caller's stdout, never the bootstrap log.
  {
    docker cp "$admin_bootstrap" "$system_name:/data/app/.installer-admin-bootstrap.json"
    docker exec "$system_name" chown 1000:1000 /data/app/.installer-admin-bootstrap.json
    docker exec "$system_name" chmod 600 /data/app/.installer-admin-bootstrap.json
  } >>"$log_file" 2>&1
  docker exec "$system_name" docker exec --user 1000:1000 kintsugi bun /app/apps/web/scripts/admin-bindings.ts bootstrap --file /data/app/.installer-admin-bootstrap.json --check >>"$log_file" 2>&1 || fail "Invalid admin bootstrap; settings were not changed"
  if [ "$admin_token_output" = - ]; then
    docker exec "$system_name" docker exec --user 1000:1000 kintsugi bun /app/apps/web/scripts/admin-bindings.ts bootstrap --file /data/app/.installer-admin-bootstrap.json --token-output - >&3
  else
    (umask 077; set -o noclobber; docker exec "$system_name" docker exec --user 1000:1000 kintsugi bun /app/apps/web/scripts/admin-bindings.ts bootstrap --file /data/app/.installer-admin-bootstrap.json --token-output - > "$admin_token_output") || fail "Admin bootstrap or secure token delivery failed"
  fi
  docker exec "$system_name" rm /data/app/.installer-admin-bootstrap.json >>"$log_file" 2>&1
  run_quiet "Restarting app for admin bindings" docker exec "$system_name" bun -e 'const r=await fetch("http://127.0.0.1:3001/restart",{method:"POST"});if(r.status!==202)throw Error("Supervisor rejected app restart");'
  wait_for_system
  if [ "$admin_token_output" != - ] && [ -n "$admin_proxy_publish" ]; then
    for ((attempt=0; attempt<30; attempt++)); do
      if docker exec -i "$system_name" bun -e 'const issued=JSON.parse(await new Response(Bun.stdin.stream()).text()); const r=await fetch("http://127.0.0.1:"+process.argv[1]+"/openapi.json",{headers:{authorization:"Bearer "+issued.secret},signal:AbortSignal.timeout(3000)});process.exit(r.ok?0:1);' "$admin_proxy_port" < "$admin_token_output" >>"$log_file" 2>&1; then admin_ready=true; break; fi
      sleep 1
    done
    [ "$admin_ready" = true ] || fail "Admin token was delivered but authenticated API is not ready; inspect bindings and TLS before retrying bootstrap"
  fi
fi
if [ -n "$result_file" ]; then
  report_result() {
    docker exec "$system_name" bun -e '
      const r=await fetch("http://127.0.0.1:3001/status"); const s=await r.json();
      const a=await (await fetch("http://127.0.0.1:3001/access")).json();
      const settings=JSON.parse(await Bun.file("/data/supervisor/storage.json").text());
      console.log(JSON.stringify({state:s.state,systemImage:process.argv[1],appImage:s.currentImage,storageDriver:settings.driver,accessMode:a.mode,uiUrl:a.origin,admin:{authenticatedApiReady:process.argv[2]==="true",portPublished:process.argv[3]==="true",tls:"External proxy/client trust must be verified separately"},pendingActions:[...(s.action?[{description:s.action.description}]:[]),...(a.mode==="proxy"?[{description:"Configure external Caddy, LAN DNS/listeners and client CA trust; verify from a separate physical client"}]:[])],verification:"Service health is not remote LAN or workspace lifecycle acceptance"}));
    ' "$(docker inspect --format '{{.Image}}' "$system_name")" "$admin_ready" "$([ -n "$admin_proxy_publish" ] && echo true || echo false)"
  }
  if [ "$result_file" = - ]; then report_result >&3; else report_result > "$result_file"; fi
fi


# Install the narrowly scoped host service after health checks, never mount host Docker in System.
if [ "$host_os" = Linux ] && [ "$no_updater" -eq 0 ] && { [ "$action" = install ] || [ "$action" = update ]; }; then
  run_root install -d -m 755 /usr/local/lib/kintsugi-updater
  run_root install -d -m 700 /var/lib/kintsugi-updater
  for updater_file in bun updater.js install.sh; do
    run_root install -m 755 "$updater_files/$updater_file" "/usr/local/lib/kintsugi-updater/$updater_file.next"
    run_root mv "/usr/local/lib/kintsugi-updater/$updater_file.next" "/usr/local/lib/kintsugi-updater/$updater_file"
  done
  rm -rf "$updater_files"
  run_root tee /etc/systemd/system/kintsugi-updater.service >/dev/null <<'UPDATER_UNIT'
[Unit]
Description=Kintsugi installation updater
After=docker.service
Requires=docker.service
[Service]
Type=simple
User=root
UMask=0077
RuntimeDirectory=kintsugi-updater
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
ExecStart=/usr/bin/flock -n /run/kintsugi-updater/service.lock /usr/local/lib/kintsugi-updater/bun /usr/local/lib/kintsugi-updater/updater.js
Restart=always
RestartSec=2
TimeoutStopSec=3000
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UPDATER_UNIT
  run_root systemctl daemon-reload
  run_root systemctl enable --now kintsugi-updater.service
fi
