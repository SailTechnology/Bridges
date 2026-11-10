#!/bin/sh
# Read-only field diagnostics. This helper never opens, flashes, or writes a serial device.
set -eu
case "${1:-health}" in
  health)
    printf 'Host: '; /bin/hostname
    /usr/bin/sw_vers
    printf '\nArchitecture: '; /usr/bin/uname -m
    printf '\nProject directory: %s\n' "$HOME/Projects"
    if [ -d "$HOME/Projects" ]; then /bin/ls -1 "$HOME/Projects"; fi
    printf '\nSSH helper: ready\n'
    ;;
  ports)
    found=0
    for device in /dev/cu.*; do
      if [ -e "$device" ]; then printf '%s\n' "$device"; found=1; fi
    done
    if [ "$found" -eq 0 ]; then printf 'No serial ports enumerated.\n'; fi
    ;;
  ground-station-status)
    if /usr/bin/curl --silent --show-error --fail --max-time 3 --output /dev/null 'http://127.0.0.1:8870/'; then
      printf 'Ground station: reachable at http://127.0.0.1:8870/\n'
    else
      printf 'Ground station: not reachable at http://127.0.0.1:8870/\n'
      exit 1
    fi
    ;;
  *) printf 'Allowed actions: health, ports, ground-station-status\n' >&2; exit 2 ;;
esac
