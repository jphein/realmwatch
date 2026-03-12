import time
import json
import os
import sys
from engine import LitRPGEngine

engine = LitRPGEngine()
duration = 180
interval = 10
start_time = time.time()
filename = "monitor_3min.log"

print(f"Starting 3-minute monitor to {filename} at {time.ctime()}")

with open(filename, "w") as f:
    while time.time() - start_time < duration:
        status = engine.get_status()
        log_entry = {
            "timestamp": time.time(),
            "status": status
        }
        f.write(json.dumps(log_entry) + "\n")
        f.flush()
        time.sleep(interval)

print(f"Monitoring complete at {time.ctime()}")
