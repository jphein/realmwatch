"""Synthetic event generators for testing and training dungeons.

Migrated from os.realm.watch/servers/replay/generators.py 2026-05-19.
Pure functions — no external dependencies. Each returns a dict shaped like
the realm-engine event envelope (event_type, source_system, severity,
confidence, payload). Pair with ``harness.py`` to inject into game.db.
"""
from __future__ import annotations


def generate_cpu_spike(host: str = "katana", value: int = 95) -> dict:
    return {
        "event_type": "cpu_spike",
        "source_system": "synthetic",
        "severity": 3 if value < 95 else 4,
        "confidence": 90,
        "payload": {"host": host, "value": value, "metric": "cpu_percent"},
    }


def generate_port_scan(source_ip: str = "10.0.4.5", target_ip: str = "10.0.6.1", ports: int = 100) -> dict:
    return {
        "event_type": "port_scan",
        "source_system": "synthetic",
        "severity": 3 if ports < 500 else 4,
        "confidence": 85,
        "payload": {"source_ip": source_ip, "target_ip": target_ip, "ports_scanned": ports},
    }


def generate_new_device(mac: str = "aa:bb:cc:dd:ee:ff", ip: str = "10.0.6.99", vlan: str = "VLAN 6") -> dict:
    return {
        "event_type": "new_device",
        "source_system": "synthetic",
        "severity": 2,
        "confidence": 70,
        "payload": {"mac": mac, "ip": ip, "vlan": vlan},
    }


def generate_memory_critical(host: str = "jellyfin", percent: int = 98) -> dict:
    return {
        "event_type": "memory_critical",
        "source_system": "synthetic",
        "severity": 4,
        "confidence": 95,
        "payload": {"host": host, "value": percent, "metric": "memory_percent"},
    }


def generate_latency_spike(host: str = "gatekeeper", latency_ms: int = 500) -> dict:
    return {
        "event_type": "latency_spike",
        "source_system": "synthetic",
        "severity": 3,
        "confidence": 80,
        "payload": {"host": host, "value": latency_ms, "metric": "rtt_ms"},
    }


def generate_brute_force(source_ip: str = "10.0.4.5", target: str = "gatekeeper",
                         attempts: int = 47) -> dict:
    return {
        "event_type": "brute_force",
        "source_system": "synthetic",
        "severity": 4,
        "confidence": 90,
        "payload": {"source_ip": source_ip, "target": target,
                    "attempts": attempts, "service": "ssh"},
    }


def generate_dns_poisoning(target_domain: str = "vault.jphe.in",
                           spoofed_ip: str = "10.99.0.1") -> dict:
    return {
        "event_type": "dns_poisoning",
        "source_system": "synthetic",
        "severity": 4,
        "confidence": 75,
        "payload": {"target_domain": target_domain, "spoofed_ip": spoofed_ip,
                    "resolver": "gatekeeper"},
    }


def generate_ddos(source: str = "10.0.4.0/24", target_ip: str = "10.0.6.1",
                  pps: int = 12000) -> dict:
    return {
        "event_type": "ddos",
        "source_system": "synthetic",
        "severity": 5,
        "confidence": 85,
        "payload": {"source": source, "target_ip": target_ip,
                    "packets_per_second": pps},
    }


def generate_unknown_device(mac: str = "de:ad:be:ef:00:01", ip: str = "10.0.6.200",
                            vlan: str = "VLAN 6") -> dict:
    return {
        "event_type": "unknown_device",
        "source_system": "synthetic",
        "severity": 3,
        "confidence": 60,
        "payload": {"mac": mac, "ip": ip, "vlan": vlan},
    }


# Registry — keep in sync with the generator functions above. Used by
# harness.py --generate <name> so the CLI doesn't need to import each
# generator by name.
GENERATORS = {
    "cpu_spike": generate_cpu_spike,
    "port_scan": generate_port_scan,
    "new_device": generate_new_device,
    "memory_critical": generate_memory_critical,
    "latency_spike": generate_latency_spike,
    "brute_force": generate_brute_force,
    "dns_poisoning": generate_dns_poisoning,
    "ddos": generate_ddos,
    "unknown_device": generate_unknown_device,
}


if __name__ == "__main__":
    # Print every generator's default output as JSON so users can pipe one
    # into harness.py or eyeball the event shape.
    import json
    for name, fn in GENERATORS.items():
        print(f"# {name}")
        print(json.dumps(fn(), indent=2))
