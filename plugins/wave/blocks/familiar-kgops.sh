#!/bin/bash
# SSH wrapper for wave-block custom mode.
# Usage: wave-block.py custom --title "FAMILIAR KGOPS" --cmd "bash plugins/wave/blocks/familiar-kgops.sh" --interval 5
# Mirrors familiar-sysmon.sh — collector script lives in familiar.realm.watch and is Syncthing'd to familiar.
ssh familiar "python3 /home/jp/Projects/familiar.realm.watch/ops/scripts/kgops-collect.py"
