#!/usr/bin/env bash
# Do-SOUL Alaya local uninstaller.
#
# Usage:
#   bash scripts/uninstall.sh           # remove install dir + bin symlink, keep ~/.config/alaya
#   bash scripts/uninstall.sh --purge   # also remove ~/.config/alaya (DURABLE MEMORY + AUDIT LOG)
#
# Environment overrides:
#   ALAYA_HOME           default: $HOME/.local/share/do-soul-alaya
#   ALAYA_BIN_DIR        default: $HOME/.local/bin
#   ALAYA_CONFIG_DIR     default: $HOME/.config/alaya
#   ALAYA_PURGE_YES      set to 1 to skip the interactive PURGE confirmation
#                        (use only in scripted CI / test contexts)
#   ALAYA_DETACH_TARGETS default: "codex claude-code"
set -euo pipefail

ALAYA_HOME="${ALAYA_HOME:-${HOME}/.local/share/do-soul-alaya}"
ALAYA_BIN_DIR="${ALAYA_BIN_DIR:-${HOME}/.local/bin}"
ALAYA_CONFIG_DIR="${ALAYA_CONFIG_DIR:-${HOME}/.config/alaya}"
ALAYA_DETACH_TARGETS="${ALAYA_DETACH_TARGETS:-codex claude-code}"
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *) printf 'unknown arg: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '\033[32m+\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

bold "Do-SOUL Alaya uninstaller"

# --- detach attached agent profiles, one explicit target at a time --------
# `alaya detach` requires a target (the CLI rejects bare invocations).
detach_failures=()
if command -v alaya >/dev/null 2>&1; then
  for target in $ALAYA_DETACH_TARGETS; do
    info "running alaya detach ${target} (best effort)..."
    if ! alaya detach "$target"; then
      warn "detach ${target} failed (continuing)"
      detach_failures+=("$target")
    fi
  done
else
  info "alaya not on PATH — skipping detach (manually edit ~/.claude.json or ~/.codex/config.toml if needed)"
fi

# --- remove install dir + .bak --------------------------------------------
for d in "$ALAYA_HOME" "${ALAYA_HOME}.bak"; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    ok "removed $d"
  fi
done

# --- remove bin symlink ---------------------------------------------------
if [ -L "${ALAYA_BIN_DIR}/alaya" ] || [ -e "${ALAYA_BIN_DIR}/alaya" ]; then
  rm -f "${ALAYA_BIN_DIR}/alaya"
  ok "removed ${ALAYA_BIN_DIR}/alaya"
fi

# --- config / data dir ----------------------------------------------------
if [ -d "$ALAYA_CONFIG_DIR" ]; then
  if [ "$PURGE" -eq 1 ]; then
    if [ "${ALAYA_PURGE_YES:-0}" != "1" ]; then
      size=$(du -sh "$ALAYA_CONFIG_DIR" 2>/dev/null | awk '{print $1}')
      bold ""
      bold "ABOUT TO PURGE: ${ALAYA_CONFIG_DIR} (${size:-unknown size})"
      info "This deletes the durable memory database (alaya.db) AND the audit log."
      info "Backups taken via 'alaya backup' are NOT in this directory and remain."
      info "This is irreversible."
      printf '   Type \033[1mPURGE\033[0m to confirm (anything else aborts): '
      read -r reply || reply=""
      if [ "$reply" != "PURGE" ]; then
        warn "purge aborted; ${ALAYA_CONFIG_DIR} kept"
        if [ "${#detach_failures[@]}" -gt 0 ]; then
          warn "manual cleanup required for failed detach targets: ${detach_failures[*]}"
        fi
        exit 1
      fi
    fi
    rm -rf "$ALAYA_CONFIG_DIR"
    ok "purged $ALAYA_CONFIG_DIR (durable memory + audit log removed)"
  else
    info "kept $ALAYA_CONFIG_DIR (durable memory + audit log preserved)"
    info "  re-run with --purge to remove."
  fi
fi

if [ "${#detach_failures[@]}" -gt 0 ]; then
  warn "detach failed for: ${detach_failures[*]}"
  warn "manually review ~/.claude.json and ~/.codex/config.toml for stale alaya entries"
fi

bold ""
bold "Done."
