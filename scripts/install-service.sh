#!/usr/bin/env bash
#
# install-service.sh - keep `engram start` running across logins: write a per-user
# supervisor, then load it.
#   macOS -> ~/Library/LaunchAgents/com.engram.daemon.plist
#   linux -> ~/.config/systemd/user/engram.service
#
#   bash scripts/install-service.sh               # install (idempotent)
#   bash scripts/install-service.sh --force       # replace a file it did not write
#   bash scripts/install-service.sh --uninstall   # remove it again
#
# the safety rules matter more than the template. every file this writes carries a
# marker; a target without one is reported, never touched, because a hand-written plist
# can hold env keys that are invisible from outside (llm url, key, model, digest budget)
# and dropping them degrades features. --force backs such a file up first, prints the
# keys it drops and the commands that restore it, and never overwrites a backup. a job
# this script did not start is never stopped or deleted, --uninstall included. a rerun
# with identical bytes is a true no-op.
#
# paths come from $HOME and `command -v` at install time: launchd does not expand ~, so
# the plist carries absolute paths, while the systemd unit uses %h. no secret is read.
#
# a taken port would make the daemon exit at once, so restarts are throttled rather
# than looping forever (macOS ThrottleInterval, Linux StartLimitBurst)

set -euo pipefail

LABEL='com.engram.daemon'
UNIT_NAME='engram.service'
# written into every file this script generates; its absence marks a foreign file. kept
# on one line so `grep -F` finds it in either format.
MARKER_TOKEN='engram-generated-by-install-service.sh'

say() { printf '%s\n' "$*" || true; }
warn() { printf 'WARNING: %s\n' "$*" >&2 || true; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: bash scripts/install-service.sh [--force] [--uninstall]

  (no arguments)  write and load a login-time supervisor for `engram start`
  --force         replace a supervisor file this script did not write, and stop
                  a job this script did not start (backup + restore steps printed)
  --uninstall     stop it and remove the supervisor file

Supported: macOS (launchd user agent), Linux (systemd --user). No sudo.
USAGE
}

MODE='install'
FORCE=0
for arg in "$@"; do
  case "$arg" in
    '') ;;
    '--uninstall'|-u) MODE='uninstall' ;;
    '--force'|-f) FORCE=1 ;;
    '-h'|'--help') usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $arg" ;;
  esac
done

case "$(uname -s)" in
  Darwin) PLATFORM='darwin' ;;
  Linux) PLATFORM='linux' ;;
  *)
    die "unsupported platform '$(uname -s)'. This script handles macOS (launchd) and Linux (systemd --user); on anything else, run 'engram start' under your own supervisor."
    ;;
esac

# this script's own directory. `dirname ''` prints '.', so a naive guard cd's into the
# cwd: fail loudly, since the Undo hint and the ENTRY fallback both derive from
# a wrong SCRIPT_DIR points at the wrong file.
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_BASENAME="${SCRIPT_PATH##*/}"
if [ -z "$SCRIPT_PATH" ] || [ -z "$SCRIPT_BASENAME" ]; then
  die "cannot determine this script's own path (\$0 and \${BASH_SOURCE[0]} are both empty).
Run it from a checkout or an installed package, e.g.
    bash scripts/install-service.sh
    bash \"\$(npm root -g)/@loccx/engram/scripts/install-service.sh\""
fi
SCRIPT_DIRNAME="${SCRIPT_PATH%/*}"
if [ "$SCRIPT_DIRNAME" = "$SCRIPT_PATH" ]; then
  # no '/' in the path: invoked from the current directory
  SCRIPT_DIRNAME='.'
fi
SCRIPT_DIR="$(cd -- "$SCRIPT_DIRNAME" >/dev/null 2>&1 && pwd -P)" || die "cannot resolve the directory of $SCRIPT_PATH"
if [ ! -f "$SCRIPT_DIR/$SCRIPT_BASENAME" ]; then
  die "resolved '$SCRIPT_PATH' to '$SCRIPT_DIR/$SCRIPT_BASENAME', which does not exist.
Re-run the script by path, e.g. bash scripts/install-service.sh"
fi
SELF_COMMAND="bash \"$SCRIPT_DIR/$SCRIPT_BASENAME\""

HOME_DIR="${HOME:-}"
[ -n "$HOME_DIR" ] || die "HOME is not set; cannot pick a per-user supervisor location."


NODE_BIN=''
if command -v node >/dev/null 2>&1; then
  candidate="$(command -v node)"
  [ -x "$candidate" ] && NODE_BIN="$candidate"
fi
[ -n "$NODE_BIN" ] || die "node was not found on PATH. Install Node 20.19 or newer, then re-run this script."

ENTRY=''
if command -v engram >/dev/null 2>&1; then
  candidate="$(command -v engram)"
  [ -f "$candidate" ] && ENTRY="$candidate"
fi
if [ -z "$ENTRY" ]; then
  candidate="$SCRIPT_DIR/../dist/index.js"
  if [ -f "$candidate" ]; then
    ENTRY="$(cd -- "$(dirname -- "$candidate")" && pwd -P)/$(basename -- "$candidate")"
  fi
fi
if [ -z "$ENTRY" ]; then
  die "the 'engram' command is not installed and $SCRIPT_DIR/../dist/index.js does not exist.
Install it first, then re-run:

    npm install -g @loccx/engram

(The unscoped npm package named 'engram' is a different, unrelated package.)"
fi

# the unscoped 'engram' package on npm is a different, older project, so never abort on
# it, only say so loudly.
reported_version="$("$NODE_BIN" "$ENTRY" --version 2>/dev/null || true)"
if [ "$reported_version" = '0.0.1' ]; then
  warn "'$ENTRY' reports version 0.0.1 - that is the unrelated unscoped npm package 'engram'."
  warn "Fix the command that owns the name: npm uninstall -g engram && npm install -g @loccx/engram"
elif [ -z "$reported_version" ]; then
  warn "'$ENTRY --version' printed nothing; make sure this really is @loccx/engram."
fi

NODE_DIR="$(dirname -- "$NODE_BIN")"
ENTRY_DIR="$(dirname -- "$ENTRY")"

# the node dir first, so a version manager's node (nvm/fnm/asdf) still resolves, then the
# usual system locations. deduped.
SERVICE_PATH=''
for dir in "$NODE_DIR" "$ENTRY_DIR" /usr/local/bin /opt/homebrew/bin /usr/bin /bin /usr/sbin /sbin; do
  case ":$SERVICE_PATH:" in
    *":$dir:"*) ;;
    *) SERVICE_PATH="${SERVICE_PATH:+$SERVICE_PATH:}$dir" ;;
  esac
done

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}


file_has_marker() {
  [ -f "$1" ] && grep -q -F -- "$MARKER_TOKEN" "$1" 2>/dev/null
}

# file mode (644) in a portable way: bsd and gnu stat disagree
file_mode() {
  if stat -f %Lp "$1" >/dev/null 2>&1; then
    stat -f %Lp "$1"
  else
    stat -c %a "$1" 2>/dev/null || printf ''
  fi
}

file_hash() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  else
    printf '(sha256 unavailable)'
  fi
}

# env var names inside a plist's EnvironmentVariables dict. the generated files put one
# element per line; anything else falls through to the generic sweep in env_keys_of().
plist_env_keys() {
  awk '
    BEGIN { depth = 0; inenv = 0; want = 0 }
    /<key>EnvironmentVariables<\/key>/ { want = 1; next }
    want && /<dict>/ { inenv = 1; want = 0; depth = 1; next }
    inenv && /<dict>/ { depth++ }
    inenv && /<\/dict>/ { depth--; if (depth == 0) { inenv = 0 }; next }
    inenv && match($0, /<key>[^<]+<\/key>/) { print substr($0, RSTART + 5, RLENGTH - 11) }
  ' "$1" 2>/dev/null || true
}

unit_env_keys() {
  grep -o '^Environment=[^"]*' "$1" 2>/dev/null | sed 's/^Environment=//' | tr ' ' '\n' \
    | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' || true
}

# every environment-looking key in a supervisor file, tolerant of formatting
env_keys_of() {
  local file="$1" keys='' sweep=''
  case "$PLATFORM" in
    darwin) keys="$(plist_env_keys "$file")" ;;
    linux) keys="$(unit_env_keys "$file")" ;;
  esac
  if [ -z "$keys" ] && [ "$PLATFORM" = 'darwin' ]; then
    # a plist formatted differently (single line, no indent): uppercase
    # assignment-shaped keys, which is what any daemon setting is
    sweep="$(grep -o -E '<key>[A-Z][A-Z0-9_]*</key>' "$file" 2>/dev/null | sed -e 's|<key>||' -e 's|</key>||' || true)"
    keys="$sweep"
  fi
  printf '%s\n' "$keys" | sed '/^$/d' | sort -u
}

report_replaced_file() {
  local file="$1" keys
  keys="$(env_keys_of "$file" | tr '\n' ' ')"
  say "Found an existing file this script did not write:"
  say "    Path:     $file"
  say "    Size:     $(wc -c < "$file" | tr -d ' ') bytes"
  say "    sha256:   $(file_hash "$file")"
  say "    Modified: $(date -r "$file" 2>/dev/null || printf 'unknown')"
  say "    Env keys: ${keys:-none found}"
  say "    (no '$MARKER_TOKEN' marker, so it was written by hand or by another tool)"
}

# a backup path that never overwrites an existing backup
backup_path_for() {
  local dest="$1" stamp candidate n=1
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  candidate="$dest.bak.$stamp"
  while [ -e "$candidate" ]; do
    n=$((n + 1))
    candidate="$dest.bak.$stamp.$n"
  done
  printf '%s' "$candidate"
}

# the env keys the new file drops, printed after the replacement together with the exact
# commands that put the old file back
report_dropped_env() {
  local old="$1" new="$2" dropped=''
  dropped="$(comm -23 <(env_keys_of "$old") <(env_keys_of "$new") | sed '/^$/d')"
  if [ -z "$dropped" ]; then
    say "Environment variables dropped by the replacement: none."
  else
    say "Environment variables dropped by the replacement (present in the replaced file, absent from the new one):"
    printf '    - %s\n' $dropped
    warn "the daemon started from the new file will not see these; if you need them, add them to the new file by hand"
  fi
}

print_restore_commands_if_backup() {
  [ -n "$BACKUP_PATH" ] || return 0
  say ""
  say "The file that was replaced is backed up at: $BACKUP_PATH"
  print_restore_commands "$BACKUP_PATH" "$1"
}

print_restore_commands() {
  local backup="$1" dest="$2"
  say "Restore the replaced configuration:"
  case "$PLATFORM" in
    darwin)
      say "    launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true"
      say "    cp -p \"$backup\" \"$dest\""
      say "    launchctl bootstrap gui/$(id -u) \"$dest\""
      ;;
    linux)
      say "    systemctl --user disable --now $UNIT_NAME 2>/dev/null || true"
      say "    cp -p \"$backup\" \"$dest\""
      say "    systemctl --user daemon-reload && systemctl --user enable --now $UNIT_NAME"
      ;;
  esac
}


LAUNCH_AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
MAC_LOG_DIR="$HOME_DIR/Library/Logs"
MAC_OUT_LOG="$MAC_LOG_DIR/engram.out.log"
MAC_ERR_LOG="$MAC_LOG_DIR/engram.err.log"

render_plist() {
  local e_node e_entry e_path e_home
  e_node="$(xml_escape "$NODE_BIN")"
  e_entry="$(xml_escape "$ENTRY")"
  e_path="$(xml_escape "$SERVICE_PATH")"
  e_home="$(xml_escape "$HOME_DIR")"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- $MARKER_TOKEN: generated file, do not edit by hand -->
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$e_node</string>
		<string>$e_entry</string>
		<string>start</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$e_path</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>15</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>WorkingDirectory</key>
	<string>$e_home</string>
	<key>StandardOutPath</key>
	<string>$e_home/Library/Logs/engram.out.log</string>
	<key>StandardErrorPath</key>
	<string>$e_home/Library/Logs/engram.err.log</string>
</dict>
</plist>
PLIST
}

macos_job_loaded() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1
}

# the plist launchd says the loaded job came from. the match is anywhere on the line, so
# it works for launchd's own output and for the `label = { path = /x.plist }` one-liner.
macos_loaded_plist_path() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null \
    | awk '{ if (match($0, /path = [^ }]+/)) { print substr($0, RSTART + 7, RLENGTH - 7); exit } }' || true
}

# reload the agent: 0 = loaded, 1 = load failed, 2 = skipped, because the running job was
# not started by this script
macos_reload() {
  local domain loaded_path foreign=''
  domain="gui/$(id -u)"
  if macos_job_loaded; then
    loaded_path="$(macos_loaded_plist_path)"
    if [ "$OWNED" != '1' ]; then
      foreign="the file it came from carries no '$MARKER_TOKEN' marker"
    elif [ -n "$loaded_path" ] && [ "$loaded_path" != "$PLIST_PATH" ]; then
      foreign="it is loaded from $loaded_path, not from $PLIST_PATH"
    fi
    if [ -n "$foreign" ]; then
      if [ "$FORCE" = '1' ]; then
        warn "$LABEL is already loaded and this script did not start it ($foreign);"
        warn "--force given: stopping and replacing that job."
      else
        warn "$LABEL is already running and this script did not start it ($foreign)."
        warn "Not stopping it: your daemon keeps running, and the file just written takes effect"
        warn "the next time that job is stopped. Stop it yourself with:"
        warn "    launchctl bootout $domain/$LABEL"
        warn "then re-run: $SELF_COMMAND"
        warn "Or re-run with --force to let this script stop and replace that job."
        return 2
      fi
    fi
  fi
  # idempotent: drop any previous copy of the job, then load the file this script wrote
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$domain" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  if launchctl bootstrap "$domain" "$PLIST_PATH" >/dev/null 2>&1; then
    return 0
  fi
  if launchctl load -w "$PLIST_PATH" >/dev/null 2>&1; then
    warn "'launchctl bootstrap' was unavailable; loaded with the legacy 'launchctl load -w' path."
    return 0
  fi
  return 1
}

macos_unload() {
  local domain
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$domain" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  return 0
}


UNIT_DIR="$HOME_DIR/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
LINUX_LOG_DIR='%h/.local/state/engram'

render_unit() {
  local e_node e_entry e_path
  e_node="$(printf '%s' "$NODE_BIN" | sed -e 's/%/%%/g')"
  e_entry="$(printf '%s' "$ENTRY" | sed -e 's/%/%%/g')"
  e_path="$(printf '%s' "$SERVICE_PATH" | sed -e 's/%/%%/g')"
  cat <<UNIT
# $MARKER_TOKEN: generated file, do not edit by hand
[Unit]
Description=Engram local memory daemon (MCP over HTTP)
After=network.target
# crash guard: stop restarting after 5 failures in 60s (a port already taken by a daemon
# started by hand, say) and leave the unit failed
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p $LINUX_LOG_DIR
ExecStart=$e_node $e_entry start
Environment=PATH=$e_path
Restart=on-failure
RestartSec=5
StandardOutput=append:$LINUX_LOG_DIR/daemon.out.log
StandardError=append:$LINUX_LOG_DIR/daemon.err.log

[Install]
WantedBy=default.target
UNIT
}

linux_systemctl() {
  command -v systemctl >/dev/null 2>&1 || return 127
  systemctl --user "$@" 2>&1 || return 1
  return 0
}

linux_job_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null
}

# as macos_reload(): 0 = enabled and started, 1 = activation failed, 2 = skipped because
# the running service was not started by this script
linux_reload() {
  if linux_job_active; then
    if [ "$OWNED" != '1' ]; then
      if [ "$FORCE" = '1' ]; then
        warn "$UNIT_NAME is already active and this script did not start it (its file carries no"
        warn "'$MARKER_TOKEN' marker); --force given: restarting it."
      else
        warn "$UNIT_NAME is already active and this script did not start it."
        warn "Not stopping it. Stop it yourself (systemctl --user disable --now $UNIT_NAME),"
        warn "then re-run: $SELF_COMMAND"
        warn "Or re-run with --force to let this script replace that service."
        return 2
      fi
    fi
  fi
  if linux_systemctl daemon-reload; then
    if linux_systemctl enable --now "$UNIT_NAME"; then
      return 0
    fi
    warn "'systemctl --user enable --now $UNIT_NAME' did not succeed; the unit is installed but not running."
    warn "Start it by hand: systemctl --user daemon-reload && systemctl --user enable --now $UNIT_NAME"
    return 1
  fi
  warn "systemctl --user is unavailable (no user session bus?). The unit is installed but not running."
  warn "Start it by hand: systemctl --user daemon-reload && systemctl --user enable --now $UNIT_NAME"
  return 1
}


TMP_FILE=''
cleanup() { [ -n "$TMP_FILE" ] && rm -f "$TMP_FILE" || true; }
trap cleanup EXIT

# set by the ownership check below: 1 = the file on disk is this script's, so reloading
# that job is safe. 0 = a foreign file, replaced only under --force.
OWNED=1
BACKUP_PATH=''

write_atomically() {
  # $1 = destination, $2 = renderer function
  local dest="$1" renderer="$2" dir kept_mode replaced_mode
  dir="$(dirname -- "$dest")"
  mkdir -p "$dir" || die "cannot create $dir"
  TMP_FILE="$(mktemp "$dir/.engram-service.XXXXXX")" || die "mktemp failed"
  "$renderer" > "$TMP_FILE"
  if [ "$PLATFORM" = 'darwin' ] && command -v plutil >/dev/null 2>&1; then
    plutil -lint "$TMP_FILE" >/dev/null 2>&1 || die "the generated plist is malformed - this is a bug in install-service.sh"
  fi
  if [ -f "$dest" ] && cmp -s "$TMP_FILE" "$dest"; then
    # byte-identical: leave the file alone, and let the caller skip the reload too, so a
    # rerun that changes nothing cannot kick a healthy daemon
    rm -f "$TMP_FILE"
    TMP_FILE=''
    REPLACED=0
    return 0
  fi
  REPLACED=1
  mv -f "$TMP_FILE" "$dest" || die "cannot write $dest"
  TMP_FILE=''
  # 644 for a file this script owns. when --force replaced someone else's file, keep THAT
  # mode: a hand-written plist is often 600 because it points at a credential file, and
  # widening it to 644 is the same class of harm as dropping env keys.
  kept_mode='644'
  if [ -n "$BACKUP_PATH" ] && [ -f "$BACKUP_PATH" ]; then
    replaced_mode="$(file_mode "$BACKUP_PATH")"
    if [ -n "$replaced_mode" ]; then
      kept_mode="$replaced_mode"
    fi
  fi
  chmod "$kept_mode" "$dest"
}

# refuses to touch a supervisor file this script did not write; under --force it reports
# what it found, backs it up and lets the caller proceed
preflight_destination() {
  local dest="$1"
  OWNED=1
  [ -f "$dest" ] || return 0
  if file_has_marker "$dest"; then
    return 0
  fi
  OWNED=0
  say ""
  report_replaced_file "$dest"
  if [ "$FORCE" != '1' ]; then
    say ""
    say "Refusing to overwrite it: nothing was written and no service was stopped."
    say "  * To keep it exactly as it is, do nothing (you do not need this script)."
    say "  * To replace it anyway - a timestamped backup is taken first, and you are told"
    say "    which environment keys the replacement drops - re-run with --force:"
    say "        $SELF_COMMAND --force"
    exit 1
  fi
  BACKUP_PATH="$(backup_path_for "$dest")"
  cp -p "$dest" "$BACKUP_PATH" || die "cannot write the backup $BACKUP_PATH"
  say "Backup written before replacing it: $BACKUP_PATH"
  say "--force given: replacing it."
  return 0
}

REPLACED=0

if [ "$MODE" = 'uninstall' ]; then
  case "$PLATFORM" in
    darwin)
      if [ ! -f "$PLIST_PATH" ]; then
        say "engram service is not installed ($PLIST_PATH does not exist)."
        say "Undo is already complete; nothing to remove."
        exit 0
      fi
      if ! file_has_marker "$PLIST_PATH"; then
        say ""
        report_replaced_file "$PLIST_PATH"
        if [ "$FORCE" != '1' ]; then
          say ""
          say "Refusing to stop or delete it: this script did not write that file, so the"
          say "running daemon may have been started by hand or by another supervisor."
          say "  * Remove it yourself (this also stops the daemon it started):"
          say "        launchctl bootout gui/$(id -u)/$LABEL"
          say "        rm \"$PLIST_PATH\""
          say "  * Or re-run with --force: a backup is taken first and you get the restore commands:"
          say "        $SELF_COMMAND --uninstall --force"
          exit 1
        fi
        BACKUP_PATH="$(backup_path_for "$PLIST_PATH")"
        cp -p "$PLIST_PATH" "$BACKUP_PATH" || die "cannot write the backup $BACKUP_PATH"
        warn "stopping $LABEL, which this script did not start (--force given)."
      fi
      macos_unload
      rm -f "$PLIST_PATH"
      say "Stopped and removed: $PLIST_PATH"
      if [ -n "$BACKUP_PATH" ]; then
        say "Backup of the replaced file: $BACKUP_PATH"
        print_restore_commands "$BACKUP_PATH" "$PLIST_PATH"
      fi
      say "Logs were left in place: $MAC_OUT_LOG and $MAC_ERR_LOG"
      say "Delete them with: rm -f \"$MAC_OUT_LOG\" \"$MAC_ERR_LOG\""
      say "The daemon itself (if you started one by hand) is stopped with: engram stop"
      exit 0
      ;;
    linux)
      if [ ! -f "$UNIT_PATH" ]; then
        say "engram service is not installed ($UNIT_PATH does not exist)."
        say "Undo is already complete; nothing to remove."
        exit 0
      fi
      if ! file_has_marker "$UNIT_PATH"; then
        say ""
        report_replaced_file "$UNIT_PATH"
        if [ "$FORCE" != '1' ]; then
          say ""
          say "Refusing to stop or delete it: this script did not write that unit."
          say "  * Remove it yourself (this also stops the service):"
          say "        systemctl --user disable --now $UNIT_NAME"
          say "        rm \"$UNIT_PATH\""
          say "  * Or re-run with --force: a backup is taken first and you get the restore commands:"
          say "        $SELF_COMMAND --uninstall --force"
          exit 1
        fi
        BACKUP_PATH="$(backup_path_for "$UNIT_PATH")"
        cp -p "$UNIT_PATH" "$BACKUP_PATH" || die "cannot write the backup $BACKUP_PATH"
        warn "stopping $UNIT_NAME, which this script did not start (--force given)."
      fi
      if linux_systemctl disable --now "$UNIT_NAME"; then
        :
      else
        warn "'systemctl --user disable --now $UNIT_NAME' did not succeed (no user D-Bus session? already stopped?); removing the unit anyway."
      fi
      rm -f "$UNIT_PATH"
      linux_systemctl daemon-reload >/dev/null || true
      say "Stopped and removed: $UNIT_PATH"
      if [ -n "$BACKUP_PATH" ]; then
        say "Backup of the replaced file: $BACKUP_PATH"
        print_restore_commands "$BACKUP_PATH" "$UNIT_PATH"
      fi
      say "Logs were left in place: \$HOME/.local/state/engram/daemon.{out,err}.log"
      say "The daemon itself (if you started one by hand) is stopped with: engram stop"
      exit 0
      ;;
  esac
fi

# install
case "$PLATFORM" in
  darwin)
    mkdir -p "$MAC_LOG_DIR" || die "cannot create $MAC_LOG_DIR"
    preflight_destination "$PLIST_PATH"
    write_atomically "$PLIST_PATH" render_plist
    if [ -n "$BACKUP_PATH" ]; then
      report_dropped_env "$BACKUP_PATH" "$PLIST_PATH"
    fi
    if [ "$REPLACED" = '0' ]; then
      say "Unchanged: $PLIST_PATH is byte-for-byte identical to what is already installed."
      if macos_job_loaded; then
        say "Nothing to do: the launchd agent is already loaded. The file was not rewritten and"
        say "the service was not restarted."
        say ""
        say "Logs:    $MAC_OUT_LOG"
        say "         $MAC_ERR_LOG"
        say "Status:  launchctl print gui/$(id -u)/$LABEL"
        say "Undo:    $SELF_COMMAND --uninstall"
        print_restore_commands_if_backup "$PLIST_PATH"
        exit 0
      fi
      say "The agent is not loaded right now, so it is being loaded from the unchanged file."
    else
      say "Wrote: $PLIST_PATH"
    fi
    say '--- begin supervisor file ---'
    cat "$PLIST_PATH"
    say '--- end supervisor file ---'
    reload_status=0
    macos_reload || reload_status=$?
    case "$reload_status" in
      0)
        say "Loaded with launchd (RunAtLoad + KeepAlive on unsuccessful exit)."
        ;;
      2)
        say "The file is installed, but the job that is running now was not started by this script."
        say "Your daemon is untouched. See the warnings above for how to switch it over."
        ;;
      *)
        warn "the agent file is installed but launchd did not load it."
        warn "Load it by hand: launchctl bootstrap gui/$(id -u) \"$PLIST_PATH\""
        ;;
    esac
    say ""
    say "Logs:    $MAC_OUT_LOG"
    say "         $MAC_ERR_LOG"
    say "Status:  launchctl print gui/$(id -u)/$LABEL"
    say "Tail:    tail -f \"$MAC_ERR_LOG\""
    say "Undo:    $SELF_COMMAND --uninstall"
    say ""
    say "Note: KeepAlive restarts the daemon only after an unsuccessful exit; 'engram stop' stays stopped."
    say "      If port 8888 is taken by another daemon, this one exits immediately and launchd"
    say "      retries no faster than every 15s (ThrottleInterval); the err log shows the failure."
    print_restore_commands_if_backup "$PLIST_PATH"
    ;;
  linux)
    preflight_destination "$UNIT_PATH"
    write_atomically "$UNIT_PATH" render_unit
    if [ -n "$BACKUP_PATH" ]; then
      report_dropped_env "$BACKUP_PATH" "$UNIT_PATH"
    fi
    if [ "$REPLACED" = '0' ]; then
      say "Unchanged: $UNIT_PATH is byte-for-byte identical to what is already installed."
      if linux_job_active; then
        say "Nothing to do: $UNIT_NAME is already active. The unit was not rewritten and the"
        say "service was not restarted."
        say ""
        say "Logs:    \$HOME/.local/state/engram/daemon.out.log (and daemon.err.log)"
        say "         journalctl --user -u $UNIT_NAME -f"
        say "Status:  systemctl --user status $UNIT_NAME"
        say "Undo:    $SELF_COMMAND --uninstall"
        print_restore_commands_if_backup "$UNIT_PATH"
        exit 0
      fi
      say "The service is not active right now, so it is being started from the unchanged unit."
    else
      say "Wrote: $UNIT_PATH"
    fi
    say '--- begin supervisor file ---'
    cat "$UNIT_PATH"
    say '--- end supervisor file ---'
    reload_status=0
    linux_reload || reload_status=$?
    case "$reload_status" in
      0)
        say "Enabled and started: $UNIT_NAME (systemd --user)"
        ;;
      2)
        say "The unit is installed, but the service that is running now was not started by this script."
        say "Your daemon is untouched. See the warnings above for how to switch it over."
        ;;
      *)
        say "The unit is installed but not running; see the warnings above."
        ;;
    esac
    say ""
    say "Logs:    \$HOME/.local/state/engram/daemon.out.log (and daemon.err.log)"
    say "         journalctl --user -u $UNIT_NAME -f"
    say "Status:  systemctl --user status $UNIT_NAME"
    say "Undo:    $SELF_COMMAND --uninstall"
    say ""
    say "Headless machine (no login session, e.g. a server or SSH-only box): run"
    say "    loginctl enable-linger $(id -un)"
    say "so systemd --user keeps this service running while you are logged out."
    say ""
    say "Note: if port 8888 is taken by another daemon, this one exits immediately; systemd"
    say "      retries 5 times in 60s (StartLimitBurst/StartLimitIntervalSec) and then leaves"
    say "      the unit failed - check 'systemctl --user status $UNIT_NAME'."
    print_restore_commands_if_backup "$UNIT_PATH"
    ;;
esac
