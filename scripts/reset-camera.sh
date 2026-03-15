#!/bin/bash
# USB reset for Razer Kiyo Pro when it hangs with UVC errors.
#
# Usage:
#   ./scripts/reset-camera.sh
#
# Description:
#   Finds the Razer Kiyo Pro on the USB bus via lsusb, then issues a USB
#   reset ioctl (USBDEVFS_RESET = 21780) directly to its device node. The
#   camera re-enumerates without needing a full USB bus reset or reboot.
#   Use when dmesg shows repeated -71 (EPROTO) or -110 (ETIMEDOUT) errors.
#
# Requires: sudo (to open /dev/bus/usb/...), python3, lsusb
DEV=$(lsusb | grep "Razer.*Kiyo" | sed 's/Bus \([0-9]*\) Device \([0-9]*\).*/\/dev\/bus\/usb\/\1\/\2/')
if [ -z "$DEV" ]; then
  echo "Kiyo Pro not found on USB bus"
  exit 1
fi
echo "Resetting $DEV ..."
sudo python3 -c "import fcntl,os; fd=os.open('$DEV',os.O_WRONLY); fcntl.ioctl(fd,21780,0); os.close(fd)"
echo "Done — camera should re-enumerate"
