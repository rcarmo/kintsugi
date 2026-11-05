/** Installed in the workspace image; provisioning and standalone tests share these. */
export function workspaceRuntimeUnits() {
  return {
    "kintsugi-tmux.service": `[Unit]
Description=Kintsugi workspace terminal workloads
[Service]
Type=exec
# All terminal children share the finite container PID budget, not 15% of it.
TasksMax=infinity
User=agent
EnvironmentFile=/.kintsugi/environment
WorkingDirectory=/work
# -D keeps the server in the foreground and disables exit-empty. Use the
# default socket so ordinary tmux commands share this managed server.
ExecStart=/usr/bin/tmux -D
# Do not release initialization until the server accepts commands. -N forbids
# a readiness probe from accidentally starting another server.
ExecStartPost=/bin/sh -ec 'until /usr/bin/tmux -N show-options -g >/dev/null 2>&1; do sleep 0.05; done'
TimeoutStartSec=10s
CPUWeight=10
Nice=10
OOMScoreAdjust=500
# An individual workload OOM must not cause systemd to kill every terminal.
OOMPolicy=continue
Restart=always
RestartSec=1s
TimeoutStopSec=10s
`,
    "kintsugi-init.service": `[Unit]
Description=Kintsugi workspace initialization
[Service]
Type=oneshot
TasksMax=infinity
EnvironmentFile=/.kintsugi/environment
WorkingDirectory=/work
ExecStart=/bin/sh /.kintsugi/init.sh
RemainAfterExit=yes
TimeoutStartSec=infinity
`,
    "kintsugi-gateway.service": `[Unit]
Description=Kintsugi workspace gateway
Requires=kintsugi-init.service
After=kintsugi-init.service
StartLimitIntervalSec=60s
StartLimitBurst=5
[Service]
TasksMax=infinity
EnvironmentFile=/.kintsugi/environment
WorkingDirectory=/work
ExecStart=/usr/local/bin/kintsugi-workspace-gateway
ExecStopPost=/usr/bin/rm -f /.kintsugi/ready
Restart=on-failure
RestartSec=2s
KillMode=mixed
TimeoutStopSec=30s
[Install]
WantedBy=multi-user.target
`,
    "kintsugi-helper.service": `[Unit]
Description=Kintsugi workspace helper
[Service]
# The helper passes this environment on to the processes it runs.
EnvironmentFile=/.kintsugi/environment
WorkingDirectory=/work
# Comes from the tools mount, so it matches the app rather than the image.
ExecStart=/opt/kintsugi/bin/kintsugi-workspace-helper
Restart=always
RestartSec=1s
# Processes the app started, such as servers, outlive a helper restart.
KillMode=process
# Those processes, agents included, count against this unit. systemd's default
# is 15% of the workspace's process limit; the workloads cgroup is the budget.
TasksMax=infinity
[Install]
WantedBy=multi-user.target
`,
    "docker.socket": `[Unit]
Description=Kintsugi Docker API socket
[Socket]
ListenStream=/run/docker.sock
SocketMode=0660
SocketUser=root
SocketGroup=docker
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
`,
    "docker.service": `[Unit]
Description=Kintsugi workspace Docker daemon
Requires=docker.socket containerd.service
After=docker.socket containerd.service
StartLimitIntervalSec=60s
StartLimitBurst=5
[Service]
Type=notify
# System services do not inherit the workspace shell's proxy environment.
EnvironmentFile=/.kintsugi/environment
ExecStart=/usr/local/bin/dockerd --live-restore
Restart=on-failure
RestartSec=2s
TimeoutStartSec=90s
TimeoutStopSec=120s
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
`,
    "containerd.service": `[Unit]
Description=Kintsugi workspace containerd
[Service]
Type=notify
ExecStart=/usr/local/bin/containerd --config /etc/containerd/config.toml
Restart=on-failure
RestartSec=2s
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
`,
  };
}
