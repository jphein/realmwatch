---
layout: default
title: AP RX-deaf diagnosis
---

# AP RX-Deaf Diagnosis Runbook

When an OpenWrt AP comes up **transmitting fine but receiving nothing** on its
ethernet uplink, it keeps beaconing at full strength and every client that
associates lands in a black hole. This runbook identifies that state, tells the
two failure modes apart with switch-internal counters, and lists what is safe to
do about it.

Born from the **2026-08-13 power-outage incident**, when `north-office`
(TP-Link OnHub TGR1900, ipq806x/chromium) cold-booted RX-deaf and looked for
several hours like a broken DHCP server.

Primary target: the OnHub fleet (`north-office`, `north-pumphouse`,
`north-bedroom`, `north-closet`, `east-willows-cabin`) and anything else on
**ipq806x with a QCA8337 switch**. The diagnosis method generalises to any DSA
board; the hazards in *Known hazards* are ipq806x-specific.

## Symptom signature

All three together mean RX-deaf. Any one alone means something else.

- **On gatekeeper:** endless `dnsmasq-dhcp` **DISCOVER → OFFER** pairs with no
  **REQUEST/ACK**, from many unrelated clients, all on the VLANs one AP serves.
  Handshakes complete normally on other APs and other VLANs.
- **On the AP:** it transmits fine — its own DHCP DISCOVERs reach gatekeeper,
  which OFFERs back in under a millisecond — and it receives nothing back.
- **Multicast is silent too:** from gatekeeper, `ping6 -c3 ff02::1%br-lan.6`
  gets no reply from the AP's EUI-64 link-local, while other APs answer.
  This is the cheapest single test, and it distinguishes RX-deaf from a
  unicast-only forwarding fault.
- Radios keep beaconing at full strength. Clients associate happily. Nothing
  in `logread` on the AP looks wrong, because from the AP's point of view the
  network has simply gone quiet.

### Why gatekeeper always looks guilty

The DISCOVER/OFFER loop is a *server-side-looking* log signature produced by a
*client-side* fault. Resist it. The first check is always: **are ACKs
completing anywhere?** If any VLAN or any AP is finishing handshakes, dnsmasq
is fine and the problem is one link.

```sh
ssh root@gatekeeper "logread | grep dnsmasq-dhcp | grep -c ACK"   # >0 → server is fine
ssh root@gatekeeper "logread | grep dnsmasq-dhcp | tail -40"      # which br-lan.N is stuck?
```

Then find the AP requesting its own management IP inside the stuck set — fleet
MACs come from `realm topology --json`.

## Step 0 — Do NOT soft-reboot the AP

**On ipq806x, a soft reboot can leave the switch deader than a cold boot.**
[openwrt#7379 / FS#2168](https://github.com/openwrt/openwrt/issues/7379)
documents an EA8500 where the QCA8337 was fine after a power cycle and
**missing entirely** after `reboot` — `MDIO device at address 0 is missing`,
with the `ipq806x-gmac-dwmac` DMA reset bit never clearing.

Consequences for this runbook:

- Never arm `watchcat mode=ping_reboot` on an ipq806x AP. A reboot loop can
  convert a recoverable wedge into a dead AP, and beacons a black hole on
  every boot in the meantime.
- If a reboot is genuinely needed, prefer a **physical power cycle** (or a
  switched PDU) over `reboot`.
- Capture the evidence in Step 1 *before* any recovery attempt. Every fix
  destroys the state that identifies the cause, and this failure is rare
  enough that you will not get many chances.

## Step 1 — Capture evidence before touching anything

The QCA8337's MIB counters are read **over MDIO**, on a completely separate
path from the ethernet data plane. They keep working when the data path is
dead — which is exactly what makes them decisive here.

Get a shell on the AP (serial console, or the working path you still have —
see [AP failsafe recovery](ap-failsafe-recovery.md) if you have none), then:

```sh
# 1. Which port is the uplink? (north-office: 'wan'. lan1 is empty.)
for p in lan1 wan; do echo "$p carrier=$(cat /sys/class/net/$p/carrier 2>/dev/null)"; done

UP=wan                                    # <-- the one with carrier=1

# 2. Switch-internal RX on the uplink port, sampled twice
ethtool -S $UP | grep -E 'RxGoodByte|RxBroad|RxMulti|RXUnicast|RxOverFlow|Filtered'
sleep 10
ethtool -S $UP | grep -E 'RxGoodByte|RxBroad|RxMulti|RXUnicast|RxOverFlow|Filtered'

# 3. Both CPU-port conduits (this board has TWO — see Known hazards)
cat /sys/class/net/eth0/statistics/rx_packets    # CPU port 0, RGMII
cat /sys/class/net/eth1/statistics/rx_packets    # CPU port 6, SGMII
sleep 10
cat /sys/class/net/eth0/statistics/rx_packets
cat /sys/class/net/eth1/statistics/rx_packets

# 4. Supporting detail
ip -d link show $UP | grep -iE 'dsa|conduit|master'
ip -s -s link show eth0 | grep -A2 RX
ethtool -S eth0 | grep -iE 'rx_pkt_n|rx_missed|watchdog|fifo'
dmesg | grep -iE 'stmmac|dwmac|qca8k|mdio'
```

Append it to `/root/uplink-watchdog-evidence.log` — `/root`, not `/tmp`,
because tmpfs does not survive the reboot you are about to consider.

## Step 2 — The decision table

**Healthy baseline on the OnHub: `eth0` *and* `eth1` rx_packets both climb.**
Kernel patch `711-02` floods broadcast, multicast, IGMP and unknown-unicast to
*all* CPU ports, and both conduits are up, so a healthy AP receives on both.
A single flat conduit is a fault; both flat is a different fault.

| Switch MIB on uplink port | `eth0` rx | `eth1` rx | Verdict |
|---|---|---|---|
| climbing | **flat** | **flat** | **H1 — switch-side wedge.** Both CPU links dying at once points at one common cause: flood-mask / `LOOKUP_MEMBER` / ATU misprogramming inside the QCA8337, not two simultaneous analog faults. |
| climbing | **flat** | climbing | **H2 — CPU-link wedge on conduit 0** (gmac0, RGMII, `37000000.ethernet`). |
| climbing | climbing | **flat** | **H2 variant on conduit 6** (gmac2, SGMII, `37400000.ethernet`). |
| climbing | climbing | climbing | **Not RX-deaf.** The conduits are fine — look above them: bridge-VLAN tagging, `br-lan.N`, FDB, or the wifi side. |
| **flat** | flat | flat | Frames never reached the switch — external cable, PHY, or the upstream switch port. Verify with `switch-mac-locate.exp` / `switch-port-bounce.exp`. |
| **`ethtool -S` errors, or every counter is zero/frozen** | — | — | **The bit-banged MDIO bus itself is dead** (gpio0/gpio1). This is the [#7379](https://github.com/openwrt/openwrt/issues/7379) class — `MDIO device at address 0 is missing`. Nothing in software can reach the switch. Power cycle. |

Two corroborating tells:

- `Filtered` and/or `RxOverFlow` climbing *alongside* `RxGoodByte` strengthens
  **H1** — the switch is receiving frames and discarding them internally.
- `rx_missed_errors` on `eth0` climbing while `rx_packets` is flat points at
  **H2** — the MAC is seeing something it cannot deliver.

> **Note if conduit pinning has been applied.** If someone has run
> `ip link set dev <port> type dsa master eth0` on this AP, `eth1` is *expected*
> to be flat and the two-CPU-port rows above collapse to the single-conduit
> case. Check `ip -d link show $UP` before reading the table.

**Neither H1 nor H2 has been observed with evidence yet.** The 2026-08-13
incident was power-cycled before anyone captured counters. Whoever runs this
table first should record the answer here.

## Step 3 — Escalation ladder

Applied in order, cheapest and least destructive first. This is what the
deployed watchdog automates.

| Elapsed deafness | Action | Rationale |
|---|---|---|
| 0–120 s | nothing | transients, DHCP renewals, STP convergence |
| ~120 s | `ip link set eth0 down; sleep 2; ip link set eth0 up` (and `eth1`), then `/etc/init.d/network restart` | free, non-destructive; recovered the ipq806x wedge in [#18979](https://github.com/openwrt/openwrt/issues/18979) |
| ~300 s | capture MIB evidence to `/root`, then **`wifi down`** | stop being a black hole — clients fail over to healthy APs |
| on recovery | **`wifi up`** | automatic; the check is stateless and re-evaluates every minute |
| never automatic | reboot | see Step 0. A human decides; physical power-cycle is the reliable fix. |

Last resort, **bench-tested units only** — the software equivalent of a power
cycle, which re-runs the stmmac DMA init that [#7379](https://github.com/openwrt/openwrt/issues/7379)
says can fail to clear:

```sh
echo 37000000.ethernet > /sys/bus/platform/drivers/ipq806x-gmac-dwmac/unbind
sleep 2
echo 37000000.ethernet > /sys/bus/platform/drivers/ipq806x-gmac-dwmac/bind
```

Unbinding a DSA conduit can wedge or oops the kernel and will drop the
management path for several seconds. Never do this first, and never remotely on
a production AP.

### Coverage check before killing radios

Clients only fail over cleanly if a healthy AP covers the same space. During the
2026-08-13 incident the two other north APs (`north-closet`, `north-bedroom`)
were powered off, so radios-down on `north-office` would have left that area
with **no coverage at all**. Before relying on the watchdog in an area, confirm
a neighbour AP is actually up:

```sh
realm fleet list          # who should be up
realm latency             # who actually is
```

## The watchdog

**`/usr/sbin/uplink-watchdog`**, driven by a `* * * * *` cron entry.
Deployed and verified on **`north-office` only** as of 2026-08-13 — not yet
fleet-wide.

What it does:

- **Deafness signal = the sum of `eth0` + `eth1` `rx_packets` frozen while
  `carrier=1`.** The sum, not either alone, because `711-02` floods to both
  conduits and both legitimately receive.
- Uses **RX counters, not ping, as the primary signal.** A ping-based check
  false-positives during a gatekeeper reboot or VRRP failover and would take
  *every* AP's radios down at once. RX-counter deafness is specific to this
  fault. A ping to the VIP plus a second always-on host is the backstop only.
- Runs the escalation ladder above; captures MIB evidence to
  **`/root/uplink-watchdog-evidence.log`** before dropping radios.
- **Stateless.** Runtime state lives in `/tmp` *deliberately*, so it resets on
  reboot; every run re-evaluates from scratch. Nothing to remember, nothing to
  leave stuck — if it dies mid-outage, the next minute's run picks up cleanly,
  and radios cannot get stranded down after the uplink returns.

> ⚠️ **Interaction with the nightly radio reload.** OnHubs carry
> `10 4 * * * wifi` ("preventive radio reload, broadcast-wedge prophylaxis").
> During an outage that brings radios back up at 04:10; the watchdog takes them
> down again within a minute, so the exposure is bounded but real. Gate the
> nightly reload on the same health check if this becomes a nuisance.

Verify it is armed and healthy:

```sh
ssh root@<ap> "crontab -l | grep uplink-watchdog; logread | grep uplink-watchdog | tail"
ssh root@<ap> "tail -20 /root/uplink-watchdog-evidence.log"
```

## Known hazards — both still present on 25.12.5

`north-office` was sysupgraded to **25.12.5** on 2026-08-13. WiFi works: the
ath10k caldata blocker recorded in `openwrt-upgrade-map.md` is dead
([PR #22951](https://github.com/openwrt/openwrt/pull/22951), merged to main
as `a94c020f3`, on the `openwrt-25.12` branch as backport `b36e1168` — cite
the latter when checking release contents; the main merge commit is not an
ancestor of 25.12). **The upgrade is a WiFi and security win. It fixes
neither hazard below.** Keep the watchdog.

### H1 — multi-CPU-port qca8k, unguarded

The OnHub has **two CPU ports**: switch port 0 → `gmac0`/`eth0` (RGMII) and
switch port 6 → `gmac2`/`eth1` (SGMII). Patch `711-02` floods unknown, IGMP,
broadcast and multicast frames to *both*, and its own commit message states the
safety contract:

> "Each CPU port should have correct LOOKUP MEMBER configuration to prevent
> receiving duplicate packets from user ports."

The patches written to keep that contract — `711-04`, `711-06`, `711-07`,
`711-08` — are **main-only**. Verified 2026-08-13: the `openwrt-25.12` branch
carries only `711-01/02/03` and `712`, identical to `openwrt-24.10`. So both
releases enable the multi-CPU behaviour and ship none of the 2026 correctness
fixes for it.

Downstream evidence, all on this exact configuration:

- [#17891](https://github.com/openwrt/openwrt/issues/17891) — bridged AP on
  R7800 (ipq806x) with `wan` in `br-lan`, 24.10: "No access from LAN ports to
  the router only from the WAN port".
- [#21317](https://github.com/openwrt/openwrt/issues/21317) — multi-CPU host
  FDB: frames "get a destination they are not allowed to reach, **and are
  dropped**".
- [#23943](https://github.com/openwrt/openwrt/issues/23943) — the follow-up
  regression, reported **explicitly on "TP-Link TGR1900/OnHub"**.
- [#17640](https://github.com/openwrt/openwrt/issues/17640) — *still open*:
  "Dumb AP Google On-hub OpenWrt 24.10RC5", soft-bricks when wan+lan are
  bridged.

**Config-level mitigation (bench first):** a dumb AP with one uplink cable does
not need both ports bridged. On `north-office` the uplink is on **`wan`**, so
the port to remove from `br-lan` — and from every `bridge-vlan` port list — is
**`lan1`**. That removes the entire bug class from the board. Alternatively pin
all user ports to one conduit with
`ip link set dev wan type dsa master eth0` (patch `711-03` *is* present in both
release branches, so this works today) — but see the conduit-pinning note under
Step 2, and test on a bench OnHub, never remotely.

### H2 — the switch has no driver-controlled reset

Verified 2026-08-13 on the `openwrt-25.12` branch: `qcom-ipq8064-onhub.dtsi`
(now under `files-6.12/arch/arm/boot/dts/qcom/`) contains **zero occurrences of
`reset-gpios`**. The QCA8337 reset appears only as a static pinctrl state:

```dts
mdio_pins: mdio_pins {
	mux { pins = "gpio0", "gpio1"; function = "gpio"; ... };
	rst { pins = "gpio26"; output-low; };
};
```

`qca8k` therefore never resets the switch — it inherits whatever state the
bootloader left, which is the textbook mechanism for "comes up wrong on a cold
boot, only a power cycle fixes it". This is the same shape OpenWrt condemned in
[#12027](https://github.com/openwrt/openwrt/issues/12027) when it caused dead
ethernet on the Linksys EAX500 family:

> "This hack implementation was **born to fail from the very start** … the
> switch require at least 10ms to be correctly reset."

Their fix, which the OnHub never received:

```dts
/* Switch from documentation require at least 10ms for reset */
reset-gpios = <&qcom_pinmux 63 GPIO_ACTIVE_HIGH>;
reset-post-delay-us = <12000>;
```

Bus-level `reset-gpios` / `reset-post-delay-us` are handled generically in
`of_mdiobus_register()`, so they work on a bit-banged `mdio-gpio` bus too.
Porting this to the OnHub is worth doing and worth upstreaming — it needs a
custom build.

> ⚠️ **`gpio26`'s polarity, and whether it is truly the QCA8337 reset line, are
> UNVERIFIED.** The DTS label is suggestive, not proof; no schematic was found.
> Wrong polarity holds the switch in reset — a brick recoverable only over
> serial. **Never poke `gpio26` on a live AP.** Bench unit with a serial console
> attached, or not at all.

## Related

- [AP failsafe recovery](ap-failsafe-recovery.md) — when the AP is alive on L2
  but locked out by config (ARP responds, ICMP and TCP do not). Different
  failure: that one is a firewall/config lockout, this one is a dead RX path.
- `~/Projects/openwrt/openwrt-upgrade-map.md` — firmware targets per device.
- Memory: `project_onhub_rx_deaf_blackhole.md` — the 2026-08-13 incident record.
- Research backing this runbook:
  `~/.claude/projects/-home-jp/scratch/dhcp-outage/nebula-onhub.md`.

## References

- [openwrt#7379 / FS#2168 — switch dead after soft reboot on EA8500 (ipq806x)](https://github.com/openwrt/openwrt/issues/7379)
- [openwrt#12027 — fix EAX500 dead ethernet; the "born to fail" reset hack](https://github.com/openwrt/openwrt/issues/12027)
- [openwrt#17640 — Dumb AP Google On-hub 24.10RC5 (open)](https://github.com/openwrt/openwrt/issues/17640)
- [openwrt#17891 — bridged AP broken on R7800 with wan in br-lan, 24.10](https://github.com/openwrt/openwrt/issues/17891)
- [openwrt#18979 — Archer C2600 loses WAN; network restart recovers](https://github.com/openwrt/openwrt/issues/18979)
- [openwrt#21317 — qca8k host FDB on multi-CPU](https://github.com/openwrt/openwrt/issues/21317)
- [openwrt#23943 — qca8k multi-CPU regression, names TGR1900/OnHub](https://github.com/openwrt/openwrt/issues/23943)
- [openwrt PR#22951 — chromium OnHub caldata fix (main `a94c020f3`, 25.12 backport `b36e1168`)](https://github.com/openwrt/openwrt/pull/22951)
- [`711-02-net-dsa-qca8k-enable-flooding-to-both-CPU-port.patch`](https://github.com/openwrt/openwrt/blob/main/target/linux/generic/pending-6.12/711-02-net-dsa-qca8k-enable-flooding-to-both-CPU-port.patch)
- [`qcom-ipq8064-eax500.dtsi` — the fixed `reset-gpios` pattern](https://github.com/openwrt/openwrt/blob/main/target/linux/ipq806x/dts/qcom-ipq8064-eax500.dtsi)
- [`qca8k-common.c` — `ar8327_mib` counter names](https://github.com/torvalds/linux/blob/master/drivers/net/dsa/qca/qca8k-common.c)
