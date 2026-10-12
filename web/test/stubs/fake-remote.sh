#!/bin/bash
trap 'stty size' WINCH
echo READY
while IFS= read -r line; do
  case "$line" in
    burst)
      head -c 2097152 /dev/zero | tr '\0' 'x'
      echo
      echo BURST_DONE
      ;;
    exit) exit 3 ;;
    *) echo "echo:$line" ;;
  esac
done
