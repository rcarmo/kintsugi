#!/usr/bin/env python3
"""Real nft kernel/atomicity regression; runs on Linux or Docker Desktop/macOS.
Run from the repository root: python3 images/system/firewall-kernel-smoke.py
Uses a disposable privileged container, never the host network namespace.
"""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="kintsugi-firewall-kernel-") as directory:
    path = pathlib.Path(directory)
    for enabled in (True, False):
        source = 'import {workspaceFirewallRules} from "./images/system/src/firewall.ts"; process.stdout.write(workspaceFirewallRules("/system/workloads/build-clients", ["127.0.0.53", "::1"], ' + str(enabled).lower() + '));'
        rules = subprocess.check_output(["bun", "-e", source], cwd=root)
        (path / ("protected.nft" if enabled else "bridge-only.nft")).write_bytes(rules)
    source = '''import {workspaceFirewallRules} from "./images/system/src/firewall.ts";
import {privateNetworkCidrs} from "./packages/shared/src/network-policy.ts";
process.stdout.write(workspaceFirewallRules("/system/workloads/build-clients", [], false, [
{bridge:"atw-11111111111",policy:{mode:"lan",cidrs:["192.168.10.0/24","fd12:aaaa::/64"],dns:["192.168.20.53"],search:[],denied:["172.28.0.0/16"]}},
{bridge:"atw-22222222222",policy:{mode:"private",cidrs:privateNetworkCidrs,dns:["192.168.20.53"],search:[],denied:["172.28.0.0/16"]}}
]));'''
    (path / "lan.nft").write_bytes(subprocess.check_output(["bun", "-e", source], cwd=root))
    script = r'''
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nftables iproute2 python3 >/tmp/install.log
cgroup=$(sed -n 's/^0:://p' /proc/self/cgroup)
relative=${cgroup#/}
level=$(printf '%s' "$relative" | awk -F/ '{print NF}')
sed -e "s|system/workloads/build-clients|$relative|g" -e "s|cgroupv2 level 3 |cgroupv2 level $level |g" /rules/protected.nft >/tmp/protected.nft
cat >/tmp/probe.nft <<EOF
add table inet kintsugi_socket_preflight
add chain inet kintsugi_socket_preflight output { type filter hook output priority -10; policy accept; }
add rule inet kintsugi_socket_preflight output socket cgroupv2 level $level "$relative" counter
EOF
if nft -c -f /tmp/probe.nft 2>/tmp/probe.err; then
  protected=true
else
  cat /tmp/probe.err
  grep -q 'Could not process rule: No such file or directory' /tmp/probe.err
  protected=false
fi
# A check must not have committed its probe table.
if nft list table inet kintsugi_socket_preflight >/dev/null 2>&1; then exit 1; fi
# Always exercise the exact rule set used on kernels without NFT_SOCKET.
nft -f /rules/bridge-only.nft
nft -f /rules/bridge-only.nft
for family in inet ip ip6; do nft list table "$family" kintsugi_workspaces; done
# Atomic failure: an unresolved set reference is accepted by the parser but
# rejected by the kernel. None of the preceding flushes may have committed.
nft add table inet unrelated_docker_fixture
nft -s list ruleset >/tmp/before.nft
cp /rules/bridge-only.nft /tmp/broken.nft
printf '\nadd rule ip kintsugi_workspaces forward ip daddr @missing_set drop\n' >>/tmp/broken.nft
if nft -f /tmp/broken.nft 2>/tmp/broken.err; then exit 1; fi
nft -s list ruleset >/tmp/after.nft
cmp /tmp/before.nft /tmp/after.nft
# Exercise actual packet lookup in both family FIB implementations. A synthetic
# output hook selects this fixture, not management traffic in production.
for family in ip ip6; do
  nft "add chain $family kintsugi_workspaces fib_fixture { type filter hook output priority -12; policy accept; }"
  nft "add rule $family kintsugi_workspaces fib_fixture fib daddr type local counter drop"
done
python3 - <<'PY'
import errno, socket
for family, destination in [(socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')]:
    with socket.socket(family, socket.SOCK_DGRAM) as probe:
        try:
            probe.sendto(b'FIB regression probe', (destination, 54321))
        except OSError as error:
            assert error.errno == errno.EPERM, error
PY
for family in ip ip6; do
  nft list chain "$family" kintsugi_workspaces fib_fixture | grep -E 'counter packets [1-9][0-9]*'
  nft flush chain "$family" kintsugi_workspaces fib_fixture
  nft delete chain "$family" kintsugi_workspaces fib_fixture
done
if [ "$protected" = true ]; then
  nft -f /tmp/protected.nft
  nft -f /tmp/protected.nft
  python3 - <<'PYTEST'
import errno, socket
for family, destination in [(socket.AF_INET, '127.0.0.53'), (socket.AF_INET6, '::1')]:
    for port in (53, 54):
        with socket.socket(family, socket.SOCK_DGRAM) as probe:
            try:
                probe.sendto(b'DNS exception probe', (destination, port))
            except OSError as error:
                assert port == 54 and error.errno == errno.EPERM, error
            else:
                assert port == 53, 'local non-DNS traffic must be dropped'
PYTEST
  for family in ip ip6; do
    nft list chain "$family" kintsugi_workspaces local_destinations | grep -E 'counter packets [1-9][0-9]*.*accept'
    nft list chain "$family" kintsugi_workspaces local_destinations | grep -E 'counter packets [1-9][0-9]*.*drop'
  done
fi
# Real bridge forwarding: three namespaces model independently permissioned
# workspaces. No host network namespace or real LAN is modified.
sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1 net.ipv6.conf.default.forwarding=1
for n in 1 2 3; do
  digits=$(printf '%011d' 0 | tr 0 "$n")
  bridge="atw-$digits"
  ip link add "$bridge" type bridge
  ip addr add "172.28.$n.1/24" dev "$bridge"
  ip -6 addr add "fd12:1:$n::1/64" dev "$bridge" nodad
  ip link set "$bridge" up
  ip netns add "client$n"
  ip link add "peer$n" type veth peer name "child$n"
  ip link set "peer$n" master "$bridge"
  ip link set "peer$n" up
  ip link set "child$n" netns "client$n"
  ip -n "client$n" link set lo up
  ip -n "client$n" link set "child$n" up
  ip -n "client$n" addr add "172.28.$n.2/24" dev "child$n"
  ip -n "client$n" -6 addr add "fd12:1:$n::2/64" dev "child$n" nodad
  ip -n "client$n" route add default via "172.28.$n.1"
  ip -n "client$n" -6 route add default via "fd12:1:$n::1"
done
ip netns add lan
ip link add uplink type veth peer name endpoint
ip link set endpoint netns lan
ip link set uplink up
ip -n lan link set endpoint up
ip -n lan link set lo up
for pair in '192.168.10.1 192.168.10.20' '10.23.0.1 10.23.0.20' '192.168.20.1 192.168.20.53' '8.8.8.1 8.8.8.8'; do
  set -- $pair
  ip addr add "$1/24" dev uplink
  ip -n lan addr add "$2/24" dev endpoint
done
for prefix in fd12:aaaa fd12:bbbb; do
  ip -6 addr add "$prefix::1/64" dev uplink nodad
  ip -n lan -6 addr add "$prefix::20/64" dev endpoint nodad
done
ip -n lan route add default via 192.168.10.1
ip -n lan -6 route add default via fd12:aaaa::1
cat >/tmp/network-server.py <<'PYSERVER'
import socket, threading, time
sockets=[]
def serve(s):
    while True:
        c,_=s.accept()
        with c:c.sendall(b'allowed')
for family,host in [(socket.AF_INET,'0.0.0.0'),(socket.AF_INET6,'::')]:
    for port in [53,54,8080]:
        s=socket.socket(family,socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        if family==socket.AF_INET6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
        s.bind((host,port));s.listen();sockets.append(s)
        threading.Thread(target=serve,args=(s,),daemon=True).start()
time.sleep(120)
PYSERVER
ip netns exec lan python3 /tmp/network-server.py &
python3 /tmp/network-server.py &
for n in 1 2 3; do ip netns exec "client$n" python3 /tmp/network-server.py & done
sleep .5
nft -f /rules/lan.nft
nft -f /rules/lan.nft
cat >/tmp/network-probe.py <<'PYPROBE'
import socket,sys
mode=sys.argv[1]
def probe(host,port,expected):
    s=socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET,socket.SOCK_STREAM)
    s.settimeout(5 if expected else .5)
    try:
        s.connect((host,port));assert s.recv(64)==b'allowed';actual=True
    except (TimeoutError,ConnectionRefusedError,OSError):actual=False
    finally:s.close()
    assert actual==expected,(mode,host,port,expected,actual)
for host in ['192.168.10.20','fd12:aaaa::20']:probe(host,8080,mode!='off')
for host in ['10.23.0.20','fd12:bbbb::20']:probe(host,8080,mode=='private')
probe('8.8.8.8',8080,True)
probe('192.168.20.53',53,mode!='off')
probe('192.168.20.53',54,mode=='private')
# All are real listeners: failure proves isolation rather than a closed port.
probe('172.28.1.1',8080,False)
probe('172.28.2.2' if sys.argv[2]=='1' else '172.28.1.2',8080,False)
probe('fd12:1:1::1',8080,False)
print('PASS kernel LAN forwarding scope:',mode,flush=True)
PYPROBE
ip netns exec client1 python3 /tmp/network-probe.py lan 1 || { nft list table inet kintsugi_workspaces; ip -6 route; ip -6 neigh; ip -n client1 -6 route; ip -n client1 -6 neigh; ip -n lan -6 route; ip -n lan -6 neigh; exit 1; }
ip netns exec client2 python3 /tmp/network-probe.py private 2
ip netns exec client3 python3 /tmp/network-probe.py off 3
# Atomic revocation to the default policy; replacing a snapshot restores it.
nft -f /rules/bridge-only.nft
ip netns exec client1 python3 /tmp/network-probe.py off 1
nft -f /rules/lan.nft
ip netns exec client1 python3 /tmp/network-probe.py lan 1

printf 'PASS: bridge-only rules, IPv4/IPv6 kernel FIB packet lookup, atomic replacement/rollback; NFT_SOCKET=%s\n' "$protected"
'''
    subprocess.run([
        "docker", "run", "--rm", "--privileged", "--cgroupns=host",
        "--mount", f"type=bind,src={path},dst=/rules,readonly",
        "--entrypoint", "sh", "ubuntu:26.04", "-ec", script,
    ], check=True)
