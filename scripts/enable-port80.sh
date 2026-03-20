#!/bin/bash
# Allow Realmwatch to bind port 80 as a user service
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
echo "net.ipv4.ip_unprivileged_port_start=80" | sudo tee /etc/sysctl.d/99-realmwatch.conf
echo "Done — port 80 is now available. Restart with: systemctl --user restart realm-map-server"
