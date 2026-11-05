#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then set -- bun run apps/web/src/server/main.ts; fi

agent_uid=1000
agent_gid=1000

# The base image may already own these IDs (for example, Ubuntu's default user).
if getent group "$agent_gid" >/dev/null; then
  existing_group="$(getent group "$agent_gid" | cut -d: -f1)"
  [ "$existing_group" = agent ] || groupmod --new-name agent "$existing_group"
else
  groupadd --gid "$agent_gid" agent
fi
if getent passwd "$agent_uid" >/dev/null; then
  existing_user="$(getent passwd "$agent_uid" | cut -d: -f1)"
  [ "$existing_user" = agent ] || usermod --login agent "$existing_user"
  existing_home="$(getent passwd "$agent_uid" | cut -d: -f6)"
  [ "$existing_home" = /home/agent ] || usermod --home /home/agent --move-home agent
else
  useradd --uid "$agent_uid" --gid "$agent_gid" --create-home --shell /bin/bash agent
fi

for socket in /var/run/docker.sock /run/containerd/containerd.sock; do
  [ -S "$socket" ] || continue
  docker_gid="$(stat -c '%g' "$socket")"
  if ! getent group "$docker_gid" >/dev/null; then
    groupadd --gid "$docker_gid" docker-host
  fi
  docker_group="$(getent group "$docker_gid" | cut -d: -f1)"
  usermod -aG "$docker_group" agent
done

# Resolve legacy settings before supplying defaults; never redirect an existing
# installation to a new data directory or namespace because of image defaults.
KINTSUGI_DATA_DIR="${KINTSUGI_DATA_DIR:-${ATELIER_DATA_DIR:-/data/app}}"
KINTSUGI_NAMESPACE="${KINTSUGI_NAMESPACE:-${ATELIER_NAMESPACE:-default}}"
export KINTSUGI_DATA_DIR KINTSUGI_NAMESPACE
kintsugi_data_dir=$KINTSUGI_DATA_DIR
mkdir -p "$kintsugi_data_dir/proxy"
chown "$agent_uid:$agent_gid" "$kintsugi_data_dir" "$kintsugi_data_dir/proxy" /data/erofs-cache

printf '%s ALL=(root) NOPASSWD: /usr/local/bin/kintsugi-tailscale-serve-helper\n' agent >/etc/sudoers.d/kintsugi-tailscale-serve
chmod 440 /etc/sudoers.d/kintsugi-tailscale-serve

HOME=/home/agent
export HOME
exec gosu agent "$@"
