---
layout: default
title: AP failsafe recovery
---

# AP Failsafe Recovery Runbook

When a remote `uci` change locks you out of an OpenWrt AP — fw4 reload rejected
input, network restart killed dhcp lease renewal, wrong zone bound, whatever
the cause — this runbook gets you back in.

Born from the **2026-05-21 fleet firewall standardization incident**, when
two APs (`east-cabinette`, `north-path`) became unreachable and the supposed
deferred-rollback safety net silently failed (the script used `nohup`, which
is not in busybox).

## When to use this

Use this when an OpenWrt AP:

- Responds to ARP (still alive on the L2 segment)
- Refuses ICMP and all TCP ports (firewall wedged)
- Or has lost its management IP entirely (network restart failed)
- And you can't `ssh` into it any more

If the AP is fully off the network (no ARP), the problem isn't a config
lockout — check power and uplink first.

## Pre-recovery sanity

From a known-good host (e.g. `gatekeeper`):

```sh
ip neigh show <ap_ip>          # REACHABLE / STALE / FAILED — is L2 alive?
ping -c 3 -W 2 <ap_ip>         # does any ICMP get through?
nc -zv <ap_ip> 22              # is dropbear refusing or timing out?
logread | grep <ap_mac>        # any recent DHCP renewals?
```

If ARP says REACHABLE but TCP says "connection refused" and ICMP fails: the
AP is alive but its firewall is rejecting input. That's the lockout pattern
this runbook fixes.

## Failsafe boot procedure

Failsafe is an OpenWrt early-boot mode that brings the AP up on
`192.168.1.1/24` with `dropbear` listening **and no password**, regardless
of what's in `/etc/config/`. It runs from RAM (overlay not mounted), so you
can read/edit the real config files via `mount_root`.

### 1. Get a laptop wired to the AP

```sh
# On the laptop's Ethernet (e.g. eno2):
sudo ip addr add 192.168.1.2/24 dev eno2
sudo ip link set eno2 up
```

Plug Ethernet directly into the AP's LAN port. WAN port also works on dumb-AP
configs (because the OpenWrt default brings up `wan` as DHCP and `lan` as
192.168.1.1 — both reachable in failsafe).

### 2. Trigger failsafe at boot

The trigger varies by model. Look at the AP first.

| AP family | Trigger button | LED indicator |
|---|---|---|
| Most TP-Link (Archer, EAP, WR-series) | **Reset** | rapid POWER flash |
| Netgear WNDR/Nighthawk on OpenWrt | **WPS** (NOT reset — reset = factory reset) | rapid POWER flash |
| GL.iNet (AR300M, MT3000, etc.) | **Reset** (small pinhole) | front LED rapid flash |
| Extreme WS-AP3825i on OpenWrt | **Reset** | rapid POWER/STATUS flash |
| Older swconfig devices | **Reset** | model-specific |

When in doubt: look at the bottom-of-case label or check `/sys/class/leds/`
in a sibling AP of the same model to find the failsafe LED name.

Sequence:

1. Power off the AP (unplug)
2. Wait 5 seconds
3. Power back on
4. **Within 2–5 seconds**, watch the LEDs — when they flash all-together
   once, OR a specific LED blinks rapidly (model-dependent), press and hold
   the trigger button for ~3 seconds
5. Failsafe LED pattern starts (rapid blinking of a particular LED, usually
   power or status)
6. Release the button

If you miss the window, power-cycle and try again. The window is narrow.

### 3. Get a shell

```sh
ssh root@192.168.1.1     # no password in failsafe; ED25519 host key has changed
# if ssh refuses: telnet root@192.168.1.1  (some builds run telnetd in failsafe)
```

If ssh complains about a host key mismatch from a prior failsafe session,
clear the known_hosts entry first:

```sh
ssh-keygen -f ~/.ssh/known_hosts -R "192.168.1.1"
```

### 4. Mount the overlay (real config)

In failsafe, the rootfs is read-only and the overlay isn't mounted. To
inspect or fix the real `/etc/config/`:

```sh
mount_root
# overlay now mounted — /etc/config/ shows the actual on-disk config
```

### 5. Diagnose

```sh
# What's the trusted firewall zone?
uci show firewall.@zone[0]

# What are the defaults?
uci show firewall.@defaults[0]

# Network interfaces — does network.admin exist? network.lan an orphan?
uci show network | grep -E "^network\.(lan|admin|loopback)\."
```

### 6. Restore from a recent backup OR rebuild

#### Option A — Restore from a backup left by the standardize tool

If the AP was wedged by `realm fleet ap-firewall-standardize --commit`,
backups live at `/root/firewall.pre-std.<TS>` and `/root/network.pre-std.<TS>`:

```sh
ls -la /root/*.pre-std.* /root/std-disarm-*

# Pick the most recent backup:
cp /root/firewall.pre-std.1234567890 /etc/config/firewall
cp /root/network.pre-std.1234567890  /etc/config/network
```

#### Option B — Rebuild to the realm standard

If no backup is around (e.g. the wedge predated the standardize tool), write
the canonical realm-standard firewall:

```sh
cat > /etc/config/firewall <<'EOF'
config defaults
    option syn_flood '1'
    option input 'REJECT'
    option output 'ACCEPT'
    option forward 'REJECT'

config zone
    option name 'admin'
    list network 'admin'
    option input 'ACCEPT'
    option output 'ACCEPT'
    option forward 'REJECT'

config zone
    option name 'wan'
    list network 'wan'
    list network 'wan6'
    option input 'REJECT'
    option output 'ACCEPT'
    option forward 'REJECT'
    option masq '1'
    option mtu_fix '1'

config forwarding
    option src 'admin'
    option dest 'wan'

config rule
    option name 'Allow-DHCP-Renew'
    option src 'wan'
    option proto 'udp'
    option dest_port '68'
    option target 'ACCEPT'
    option family 'ipv4'

config rule
    option name 'Allow-Ping'
    option src 'wan'
    option proto 'icmp'
    option icmp_type 'echo-request'
    option family 'ipv4'
    option target 'ACCEPT'
EOF
```

Ensure `network.admin` exists with the right device for this AP:

```sh
uci -q delete network.lan   # drop any orphan
uci set network.admin=interface
uci set network.admin.device='br-lan.6'   # OR 'br-admin' on swconfig APs
uci set network.admin.proto='dhcp'
uci commit network
uci commit firewall
```

### 7. Reboot back into normal mode

```sh
reboot
```

The AP boots into the real config (now fixed), DHCPs onto VLAN 6, and reappears
in `realm fleet ap-firewall-audit`.

### 8. Verify

From your normal workstation (after the AP gets its DHCP lease):

```sh
realm fleet ap-firewall-audit <ap_name>
# Expected: ✓ PASS
```

And update `fleet.yaml` — set `status` back to `curated` from `locked-out`,
update `last_seen`, replace the lockout note with a brief recovery note.

## Lessons learned (2026-05-21)

1. **`nohup` is not in busybox.** Any deferred-rollback script that uses
   `nohup` or `disown` silently fails to detach across SSH disconnect, so
   the rollback never arms. Use **`setsid sh -c '...' </dev/null >/dev/null 2>&1 &`**
   instead — `setsid` is in busybox and actually detaches.
2. **`/tmp` is tmpfs on OpenWrt.** Backups and disarm files written to
   `/tmp/` disappear on reboot. Use `/root/` for anything that should survive.
3. **Test the safety net before trusting it.** Run a deliberate
   never-disarmed timer on a sacrificial AP first to confirm it actually
   fires. Don't ship rollback logic that hasn't been verified.
4. **Default to dry-run for destructive ops.** `realm fleet ap-firewall-standardize`
   defaults to dry-run; `--commit` mutates. This stops casual mistakes.
5. **`option input 'ACCEPT'` defaults are a security hole.** Some APs in
   the 2026-05-21 sweep had been left with permissive defaults; the
   realm-standard `REJECT` is fail-closed but means **every zone must have
   a valid `network` binding**, otherwise the AP locks itself out.

## References

- [realm fleet ap-firewall-audit](https://github.com/jphein/realmwatch/blob/master/scripts/ap-firewall-audit.sh)
- [realm fleet ap-firewall-standardize](https://github.com/jphein/realmwatch/blob/master/scripts/ap-firewall-standardize.sh)
- [OpenWrt failsafe docs](https://openwrt.org/docs/guide-user/troubleshooting/failsafe_and_factory_reset)
