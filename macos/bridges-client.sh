#!/bin/bash
# Uses macOS built-ins only. Each profile binds one Windows endpoint and permanent device grant.
set -euo pipefail
umask 077
BRIDGES_PROFILE="${BRIDGES_PROFILE:-windows-primary}"
[[ "$BRIDGES_PROFILE" =~ ^[A-Za-z0-9_-]+$ ]] || { echo 'Invalid profile name.' >&2; exit 2; }
BRIDGES_CONFIG="$HOME/Library/Application Support/Bridges/profiles/$BRIDGES_PROFILE"
BRIDGES_WORK="$HOME/Projects/Bridges/profiles/$BRIDGES_PROFILE"
/bin/mkdir -p "$BRIDGES_CONFIG" "$BRIDGES_WORK/tmp" "$BRIDGES_WORK/deployments"
/bin/chmod 700 "$BRIDGES_CONFIG"
BRIDGES_URL_FILE="$BRIDGES_CONFIG/windows-url.txt"
BRIDGES_COOKIE="$BRIDGES_CONFIG/pairing-cookie.txt"
BRIDGES_DEVICE_AUTH="$BRIDGES_CONFIG/device-auth.curl"

valid_url() {
  [[ "$1" =~ ^https://[A-Za-z0-9.-]+\.ts\.net(:[0-9]+)?/?$ ]] || [[ "$1" =~ ^http://127\.0\.0\.1:[0-9]+/?$ ]]
}
load_url() {
  [[ -f "$BRIDGES_URL_FILE" ]] || { echo 'Run setup first.' >&2; exit 2; }
  IFS= read -r BRIDGES_URL < "$BRIDGES_URL_FILE"
  valid_url "$BRIDGES_URL" || { echo 'Invalid saved Windows URL.' >&2; exit 2; }
  BRIDGES_URL="${BRIDGES_URL%/}"
}
request() {
  local auth_config=/dev/null
  if [[ -f "$BRIDGES_DEVICE_AUTH" ]]; then auth_config="$BRIDGES_DEVICE_AUTH"; fi
  /usr/bin/curl --disable --config "$auth_config" --noproxy '*' --silent --show-error --fail --connect-timeout 10 --max-time 65 \
    --cookie "$BRIDGES_COOKIE" --cookie-jar "$BRIDGES_COOKIE" --header 'X-Bridges-Client: 1' "$@"
}
save_device_auth() {
  local response="$1" token temporary
  token=$(/usr/bin/plutil -extract deviceToken raw -o - "$response") || { echo 'Windows has not issued a permanent device grant; update the Windows service.' >&2; return 1; }
  [[ "$token" =~ ^dev1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$ ]] || { echo 'Invalid device authorization response.' >&2; return 1; }
  temporary=$(/usr/bin/mktemp "$BRIDGES_CONFIG/device-auth.XXXXXX") || return 1
  if ! printf 'header = "Authorization: Bearer %s"\n' "$token" > "$temporary" ||
     ! /bin/chmod 600 "$temporary" || ! /bin/mv -f "$temporary" "$BRIDGES_DEVICE_AUTH"; then
    /bin/rm -f "$temporary"; echo 'Could not save device authorization; the previous credential was preserved.' >&2; return 1
  fi
  unset token
}
reuse_device() {
  local response authenticated
  response=$(/usr/bin/mktemp "$BRIDGES_CONFIG/session.XXXXXX") || return 2
  if ! request "$BRIDGES_URL/api/session" --output "$response"; then /bin/rm -f "$response"; return 2; fi
  if ! authenticated=$(/usr/bin/plutil -extract authenticated raw -o - "$response"); then
    /bin/rm -f "$response"; echo 'Invalid session response from Windows; no pairing was attempted.' >&2; return 2
  fi
  [[ "$authenticated" == true || "$authenticated" == false ]] || { /bin/rm -f "$response"; echo 'Invalid session status.' >&2; return 2; }
  if [[ "$authenticated" != true ]]; then /bin/rm -f "$response"; return 1; fi
  if [[ ! -f "$BRIDGES_DEVICE_AUTH" ]]; then
    if ! request --request POST --header 'Content-Type: application/json' --data "{\"deviceName\":\"Neo/$BRIDGES_PROFILE\"}" "$BRIDGES_URL/api/device/remember" --output "$response"; then
      /bin/rm -f "$response"; return 2
    fi
    if ! save_device_auth "$response"; then /bin/rm -f "$response"; return 2; fi
  fi
  /bin/rm -f "$response"
}
ensure_authorized() {
  local result
  if reuse_device; then return 0; else result=$?; fi
  if [[ "$result" -eq 1 ]]; then
    echo 'No active device authorization. Run setup once; normal deployments reuse the saved grant.' >&2
  else
    echo 'Windows is unreachable or returned an invalid response. The saved authorization was kept; retry when connected.' >&2
  fi
  return "$result"
}
valid_id() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,100}$ ]] || { echo 'Invalid identifier.' >&2; exit 2; }; }
download() {
  local job="$1" status sha stage archive part actual state
  valid_id "$job"
  stage="$BRIDGES_WORK/deployments/$job"
  /bin/mkdir -p "$stage"
  status="$stage/status.json"
  request "$BRIDGES_URL/api/builds/$job" --output "$status"
  state=$(/usr/bin/plutil -extract state raw -o - "$status")
  [[ "$state" == ready ]] || { echo "Build state: $state. Artifact not downloaded." >&2; exit 1; }
  sha=$(/usr/bin/plutil -extract receipt.sha256 raw -o - "$status")
  [[ "$sha" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid artifact checksum.' >&2; exit 1; }
  archive="$stage/deployment.zip"
  if [[ -f "$archive" ]]; then
    actual=$(/usr/bin/shasum -a 256 "$archive"); actual="${actual%% *}"
    [[ "$actual" == "$sha" ]] || { echo 'Existing download differs; preserved without overwriting.' >&2; exit 1; }
  else
    part="$stage/deployment.zip.partial"
    actual=''
    if [[ -f "$part" ]]; then actual=$(/usr/bin/shasum -a 256 "$part"); actual="${actual%% *}"; fi
    if [[ "$actual" != "$sha" ]]; then request --continue-at - "$BRIDGES_URL/api/builds/$job/artifact" --output "$part"; fi
    actual=$(/usr/bin/shasum -a 256 "$part"); actual="${actual%% *}"
    [[ "$actual" == "$sha" ]] || { echo 'SHA-256 mismatch; partial file preserved for diagnosis.' >&2; exit 1; }
    /bin/mv -n "$part" "$archive"
  fi
  printf '%s\n' "$archive"
}

case "${1:-help}" in
  setup)
    BRIDGES_INPUT_URL="${2:-}"
    if [[ -z "$BRIDGES_INPUT_URL" ]]; then printf 'Windows Bridges HTTPS URL: '; IFS= read -r BRIDGES_INPUT_URL; fi
    valid_url "$BRIDGES_INPUT_URL" || { echo 'Use a Tailscale HTTPS URL or an SSH-forwarded localhost URL.' >&2; exit 2; }
    if [[ -f "$BRIDGES_URL_FILE" ]]; then
      IFS= read -r BRIDGES_PREVIOUS_URL < "$BRIDGES_URL_FILE"
      [[ "${BRIDGES_PREVIOUS_URL%/}" == "${BRIDGES_INPUT_URL%/}" ]] || { echo 'This profile belongs to another endpoint. Use a different BRIDGES_PROFILE.' >&2; exit 2; }
    fi
    printf '%s\n' "$BRIDGES_INPUT_URL" > "$BRIDGES_URL_FILE"
    load_url
    if reuse_device; then
      printf 'Saved device authorization is valid. No pairing code is needed.\n'
      exit 0
    else
      BRIDGES_REUSE_RESULT=$?
      [[ "$BRIDGES_REUSE_RESULT" -eq 1 ]] || exit "$BRIDGES_REUSE_RESULT"
    fi
    printf 'Enter the one-time pairing code shown on Windows: '
    IFS= read -rs BRIDGES_PAIR_CODE; printf '\n'
    [[ "$BRIDGES_PAIR_CODE" =~ ^[0-9]{8}$ ]] || { echo 'Expected an eight-digit pairing code.' >&2; exit 2; }
    BRIDGES_PAIR_RESPONSE=$(/usr/bin/mktemp "$BRIDGES_CONFIG/pairing.XXXXXX")
    if ! request --request POST --header 'Content-Type: application/json' --data "{\"code\":\"$BRIDGES_PAIR_CODE\",\"persistent\":true,\"deviceName\":\"Neo/$BRIDGES_PROFILE\"}" "$BRIDGES_URL/api/login" --output "$BRIDGES_PAIR_RESPONSE"; then
      /bin/rm -f "$BRIDGES_PAIR_RESPONSE"; unset BRIDGES_PAIR_CODE; exit 1
    fi
    if ! save_device_auth "$BRIDGES_PAIR_RESPONSE"; then /bin/rm -f "$BRIDGES_PAIR_RESPONSE"; exit 1; fi
    /bin/rm -f "$BRIDGES_PAIR_RESPONSE"
    /bin/chmod 600 "$BRIDGES_COOKIE"
    unset BRIDGES_PAIR_CODE
    printf 'Device remembered until revoked on Windows. GPT account credentials remain separate.\n'
    ;;
  status|projects|deployables)
    load_url
    BRIDGES_ENDPOINT="$1"
    request "$BRIDGES_URL/api/$BRIDGES_ENDPOINT"; printf '\n'
    ;;
  files|read)
    load_url; valid_id "${2:?project id required}"
    BRIDGES_ENDPOINT=files; [[ "$1" != read ]] || BRIDGES_ENDPOINT=preview
    request --get --data-urlencode "path=${3:-}" "$BRIDGES_URL/api/projects/$2/$BRIDGES_ENDPOINT"; printf '\n'
    ;;
  build)
    load_url; valid_id "${2:?recipe id required}"
    request --request POST --header 'Content-Type: application/json' --data "{\"recipe\":\"$2\"}" "$BRIDGES_URL/api/builds"; printf '\n'
    ;;
  build-status)
    load_url; valid_id "${2:?job id required}"; request "$BRIDGES_URL/api/builds/$2"; printf '\n'
    ;;
  download)
    load_url; download "${2:?job id required}"
    ;;
  install)
    load_url; BRIDGES_JOB="${2:?job id required}"; valid_id "$BRIDGES_JOB"
    BRIDGES_ARCHIVE=$(download "$BRIDGES_JOB")
    BRIDGES_TARGET="$BRIDGES_WORK/deployments/$BRIDGES_JOB/unpacked"
    [[ ! -e "$BRIDGES_TARGET" ]] || { echo "Already extracted; preserved: $BRIDGES_TARGET" >&2; exit 1; }
    /bin/mkdir "$BRIDGES_TARGET"
    /usr/bin/ditto -x -k "$BRIDGES_ARCHIVE" "$BRIDGES_TARGET"
    BRIDGES_APP=''
    for BRIDGES_CANDIDATE in "$BRIDGES_TARGET"/*/*.app; do
      if [[ -d "$BRIDGES_CANDIDATE" ]]; then
        [[ -z "$BRIDGES_APP" ]] || { echo 'More than one application was found.' >&2; exit 1; }
        BRIDGES_APP="$BRIDGES_CANDIDATE"
      fi
    done
    [[ -n "$BRIDGES_APP" ]] || { echo 'No application was found in the deployment package.' >&2; exit 1; }
    BRIDGES_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BRIDGES_APP/Contents/Info.plist")
    [[ "$BRIDGES_BUNDLE_ID" == org.sail.dumbo.groundstation ]] || { echo 'Unexpected application identity.' >&2; exit 1; }
    if [[ -f "$BRIDGES_CONFIG/current-groundstation-app.txt" ]]; then
      /bin/cp -p "$BRIDGES_CONFIG/current-groundstation-app.txt" "$BRIDGES_WORK/deployments/$BRIDGES_JOB/previous-app-path.txt"
    fi
    printf '%s\n' "$BRIDGES_APP" > "$BRIDGES_CONFIG/current-groundstation-app.txt"
    printf 'Installed in a new directory: %s\n' "$BRIDGES_TARGET"
    printf 'Existing applications and application data have not been replaced.\n'
    ;;
  open)
    BRIDGES_POINTER="$BRIDGES_CONFIG/current-groundstation-app.txt"
    [[ -f "$BRIDGES_POINTER" ]] || { echo 'No deployment has been selected.' >&2; exit 1; }
    IFS= read -r BRIDGES_APP < "$BRIDGES_POINTER"
    case "$BRIDGES_APP" in "$BRIDGES_WORK"/deployments/*/*.app) ;; *) echo 'Application path is outside this profile.' >&2; exit 1 ;; esac
    [[ -d "$BRIDGES_APP" ]] || { echo 'Application is missing.' >&2; exit 1; }
    if /usr/bin/curl --noproxy '*' --silent --fail --max-time 2 --output /dev/null 'http://127.0.0.1:8870/api/health'; then
      printf 'New version is installed. An existing ground-station service is running; no second service was started.\n'
      printf 'New application: %s\n' "$BRIDGES_APP"
    else
      /usr/bin/open "$BRIDGES_APP"
      printf 'Launch requested: %s\n' "$BRIDGES_APP"
    fi
    ;;
  deploy)
    load_url; BRIDGES_RECIPE="${2:-octopus-groundstation}"; valid_id "$BRIDGES_RECIPE"
    ensure_authorized
    BRIDGES_RESPONSE=$(/usr/bin/mktemp "$BRIDGES_WORK/tmp/request.XXXXXX")
    request --request POST --header 'Content-Type: application/json' --data "{\"recipe\":\"$BRIDGES_RECIPE\"}" "$BRIDGES_URL/api/builds" --output "$BRIDGES_RESPONSE"
    BRIDGES_JOB=$(/usr/bin/plutil -extract id raw -o - "$BRIDGES_RESPONSE"); valid_id "$BRIDGES_JOB"
    printf 'Windows build started: %s\n' "$BRIDGES_JOB"
    BRIDGES_BUILD_STATE=running
    for (( BRIDGES_ATTEMPT=0; BRIDGES_ATTEMPT<120; BRIDGES_ATTEMPT++ )); do
      request "$BRIDGES_URL/api/builds/$BRIDGES_JOB" --output "$BRIDGES_RESPONSE"
      BRIDGES_BUILD_STATE=$(/usr/bin/plutil -extract state raw -o - "$BRIDGES_RESPONSE")
      [[ "$BRIDGES_BUILD_STATE" == running ]] || break
      printf 'Windows is building; source files remain on Windows.\n'
      /bin/sleep 5
    done
    [[ "$BRIDGES_BUILD_STATE" == ready ]] || { /bin/cat "$BRIDGES_RESPONSE"; echo 'Build is not ready; no installation performed.' >&2; exit 1; }
    printf 'Build verified. Downloading the deployment archive.\n'
    BRIDGES_PROFILE="$BRIDGES_PROFILE" /bin/bash "$0" install "$BRIDGES_JOB"
    BRIDGES_PROFILE="$BRIDGES_PROFILE" /bin/bash "$0" open
    ;;
  *)
    printf '%s\n' 'Bridges client — process on Windows, download only the deployment artifact.' \
      'Commands:' '  setup [https://windows-host.ts.net:8443]' '  status | projects | deployables' \
      '  files PROJECT_ID [relative/path]' '  read PROJECT_ID relative/file' \
      '  deploy [octopus-groundstation]' '  build octopus-groundstation' '  build-status JOB_ID' '  download JOB_ID' '  install JOB_ID | open'
    ;;
esac
