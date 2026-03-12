#!/bin/bash
# Reset Razer Kiyo Pro USB device when it hangs (UVC -71/-110 errors)
DEV=$(lsusb | grep "Razer.*Kiyo" | sed 's/Bus \([0-9]*\) Device \([0-9]*\).*/\/dev\/bus\/usb\/\1\/\2/')
if [ -z "$DEV" ]; then
  echo "Kiyo Pro not found on USB bus"
  exit 1
fi
echo "Resetting $DEV ..."
sudo python3 -c "import fcntl,os; fd=os.open('$DEV',os.O_WRONLY); fcntl.ioctl(fd,21780,0); os.close(fd)"
echo "Done — camera should re-enumerate"
