# OpenWrt fleet updates — Phase B design

**Status:** implemented (PR #49 follow-up to #47/#48).
**Issue:** [#49](https://github.com/jphein/realmwatch/issues/49).

Phase A landed the unified `realm update` verb against Ubuntu hosts only.
Phase B extends the same verb to OpenWrt fleet members (APs, gatekeeper
router pair, OpenWrt-flashed switches) so a single command covers the
whole realm.

## Routing

`fleet.yaml` carries an optional per-entry block:

```yaml
realm_update:
  enabled: true
  os: openwrt        # explicit override
```

`scripts/lib/emit-update-eligible.py` reads it directly (bypassing the
typed lexicon model so we can ship per-node config without a schema bump).
The OS field resolution chain:

1. **Explicit** `realm_update.os: ubuntu|openwrt` from fleet.yaml.
2. **Category inference** (when the field is absent):
   - `category in {ap, router, switch_openwrt}` → `openwrt`
   - everything else → `ubuntu` (back-compat default)
3. **Vendor inference** as a second-tier hint: `vendor` starting with
   "openwrt" forces `openwrt`.

`scripts/cli/realm-update.sh` then asks the emitter for the JSON manifest,
buckets the requested hosts by `os`, and dispatches one ansible run per
bucket: `update-ubuntu.yml` and `update-openwrt.yml`. Buckets run
sequentially; a failure in one bucket fails the verb (mirrors Phase A
semantics on `--all-nodes`).

## Why `ansible.builtin.raw` + Dropbear, not `python3-light`

OpenWrt hosts come in two transport flavors for Ansible:

| Approach | Pros | Cons |
|---|---|---|
| Install `python3-light` via opkg, use `ansible.builtin.apt`-equivalents | Native module ergonomics; structured return values; idempotency from ansible's own state-tracking | Adds ~3 MB to the overlay on flash-constrained APs; another package to keep up to date; failure modes during `opkg upgrade` of python itself; not all APs ship with enough free overlay to install it safely |
| `ansible.builtin.raw` over Dropbear SSH | Zero footprint on target — just runs shell commands; works identically on tiny APs and beefier x86 OpenWrt routers; matches what an operator would type manually | No structured return — we parse stdout; ansible cannot do "diff-aware" idempotency; have to write our own change/failed detection |

The `raw` approach wins for our fleet because:
- The smallest box in scope (TP-Link AP) has ~200 KB free overlay;
  installing python would brick it.
- `opkg`'s output is stable enough to grep reliably for "Upgrading…",
  "reboot needed", "Collected errors".
- We already use `raw` in `plugins/ansible/playbooks/backup-openwrt.yml`
  and it has been reliable for ~6 months.

## Safety contract for `update-openwrt.yml`

- `opkg update` always runs (cheap).
- `opkg list-upgradable` is informational — we count and report.
- `opkg upgrade` is **gated behind `do_upgrade=true`**. A plain
  `realm update --node ap-…` is dry-run-equivalent: it tells you what
  would change without touching the box.
  - Apply with: `realm ansible-update --hosts ap-foo
    --playbook update-openwrt.yml -- --extra-vars do_upgrade=true`.
- Never reboots. If any task output contains "reboot" or "kernel" we
  surface `reboot needed: true` in the per-host summary; humans pick the
  maintenance window.
- No kernel-image upgrades. OpenWrt routes those through sysupgrade
  images, not the opkg release feed — out of scope for this play.

## VRRP / HA pair serialization

The issue calls out the `gatekeeper` / `gatekeeper-bak` VRRP pair: they
must never be updated simultaneously or we lose the gateway VIP. Phase B
**does not** implement automatic serialization — the design intent is an
`update_group` field on each fleet.yaml entry that the bucketer treats as
a serial barrier. That work is deferred:

- For now, operators target one half of the pair at a time
  (`realm update --node gatekeeper`).
- A future patch will add `update_group: gateway` to both entries and
  teach the bucketer to drain a group sequentially.

This is acceptable because today the OpenWrt path defaults to dry-run
(`do_upgrade=false`), so multi-host parallelism only refreshes opkg
indices — not service-affecting.

## Migration

No flags removed; nothing to migrate. Existing `realm update --node` calls
auto-route to the right playbook based on category/vendor inference.
Operators can pin behavior per-entry with `realm_update.os` when the
inference is wrong.
