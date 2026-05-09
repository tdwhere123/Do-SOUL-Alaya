#!/usr/bin/env bash
# Do-SOUL Alaya local installer.
#
# Usage (env vars MUST come after the pipe so `bash` sees them, not `curl`):
#   curl -fsSL https://raw.githubusercontent.com/tdwhere123/Do-SOUL-Alaya/main/scripts/install.sh | bash
#   curl -fsSL ... | ALAYA_VERSION=v0.1.2 bash
#   curl -fsSL ... | ALAYA_HOME=/opt/alaya ALAYA_BIN_DIR=/usr/local/bin bash
#
# Environment overrides:
#   ALAYA_VERSION   default: latest GitHub release tag (e.g. v0.1.2)
#   ALAYA_HOME      default: $HOME/.local/share/do-soul-alaya
#   ALAYA_BIN_DIR   default: $HOME/.local/bin
#   ALAYA_REPO      default: tdwhere123/Do-SOUL-Alaya
#   ALAYA_TARBALL   override the asset name (advanced; rarely needed)
#
# What it does:
#   1. checks node >= 20.19, ensures pnpm 9 (corepack); rejects pnpm major != 9
#   2. resolves the requested release tag and validates strict semver shape
#   3. downloads the release tarball + SHA256SUMS over HTTPS-pinned curl
#   4. verifies sha256 (anchored match) + rejects unsafe paths inside tarball
#   5. extracts to a STAGING dir and runs pnpm install + pnpm build there
#   6. on success, atomically swaps STAGING -> $ALAYA_HOME (old install -> .bak)
#   7. symlinks $ALAYA_HOME/bin/alaya.mjs into $ALAYA_BIN_DIR/alaya
set -euo pipefail

REPO="${ALAYA_REPO:-tdwhere123/Do-SOUL-Alaya}"
ALAYA_HOME="${ALAYA_HOME:-${HOME}/.local/share/do-soul-alaya}"
ALAYA_BIN_DIR="${ALAYA_BIN_DIR:-${HOME}/.local/bin}"
TMP_DIR="$(mktemp -d -t alaya-install-XXXXXX)"
STAGING_DIR="${ALAYA_HOME}.staging-$$"
trap 'rm -rf "$TMP_DIR" "$STAGING_DIR"' EXIT

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '\033[32m+\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31mx\033[0m %s\n' "$*" >&2; exit 1; }

bold "Do-SOUL Alaya installer"

# --- path safety ----------------------------------------------------------
# Reject targets that, if mv'd to .bak, would clobber unrelated user state.
# This guard runs against ALAYA_HOME (where the install body lives) AND
# against ALAYA_BIN_DIR (where the alaya symlink lives).
reject_unsafe_path() {
  local label="$1" raw="$2"
  local abs
  abs="$(readlink -f "$raw" 2>/dev/null || echo "$raw")"
  case "$abs" in
    "" | /) err "${label} resolves to '${abs}' (root). Refusing." ;;
    /root|/root/*|/usr|/usr/*|/etc|/etc/*|/var|/var/*|/bin|/bin/*|/sbin|/sbin/*)
      err "${label} points at a system path: ${abs}. Refusing." ;;
    /boot|/boot/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*)
      err "${label} points at a kernel/system path: ${abs}. Refusing." ;;
    # /home and /Users without a sub-account would clobber every user's home.
    /home|/Users) err "${label} cannot be the multi-user root '${abs}'. Refusing." ;;
    # /mnt /opt /srv as bare top-level dirs typically host shared content.
    /mnt|/opt|/srv) err "${label} cannot be a bare top-level shared dir '${abs}'. Refusing." ;;
  esac
  printf '%s' "$abs"
}
abs_alaya_home="$(reject_unsafe_path 'ALAYA_HOME' "$ALAYA_HOME")"
abs_home="$(readlink -f "$HOME" 2>/dev/null || echo "$HOME")"
[ "$abs_alaya_home" = "$abs_home" ] \
  && err "ALAYA_HOME cannot be \$HOME (would clobber on upgrade)."
case "$abs_home" in
  "$abs_alaya_home"/*) err "\$HOME is inside ALAYA_HOME (${abs_alaya_home}); refusing." ;;
esac
abs_bin_dir="$(reject_unsafe_path 'ALAYA_BIN_DIR' "$ALAYA_BIN_DIR")"
case "$abs_bin_dir" in
  /etc|/etc/*) err "ALAYA_BIN_DIR cannot be under /etc. Refusing." ;;
esac

# --- prerequisites --------------------------------------------------------
for cmd in curl tar node; do
  command -v "$cmd" >/dev/null 2>&1 || err "missing required command: $cmd"
done

node_major=$(node -p 'process.versions.node.split(".")[0]')
node_minor=$(node -p 'process.versions.node.split(".")[1]')
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 19 ]; }; then
  err "node >= 20.19 required (current: $(node -v)). Install via nvm or your system package manager."
fi
ok "node $(node -v)"

# pnpm 9 enforced (lockfile is v9.0). If user has pnpm 8 in PATH, switch
# to corepack-managed pnpm@9 inside this shell.
need_corepack_switch=0
if command -v pnpm >/dev/null 2>&1; then
  pnpm_major=$(pnpm --version 2>/dev/null | cut -d. -f1 || echo 0)
  if [ "$pnpm_major" != "9" ]; then
    info "found pnpm ${pnpm_major}; this project requires pnpm 9 (lockfile v9.0). switching..."
    need_corepack_switch=1
  fi
else
  need_corepack_switch=1
fi
if [ "$need_corepack_switch" = "1" ]; then
  command -v corepack >/dev/null 2>&1 \
    || err "pnpm 9 required but corepack is not available. Install pnpm 9 manually: npm install -g pnpm@9"
  info "enabling pnpm 9 via corepack..."
  corepack enable >/dev/null 2>&1 || warn "corepack enable failed (try: sudo corepack enable)"
  corepack prepare pnpm@9 --activate >/dev/null 2>&1 \
    || err "corepack prepare pnpm@9 failed; install pnpm 9 manually"
fi
pnpm_major=$(pnpm --version 2>/dev/null | cut -d. -f1 || echo 0)
[ "$pnpm_major" = "9" ] \
  || err "pnpm 9 required (got: $(pnpm --version 2>/dev/null || echo 'none'))"
ok "pnpm $(pnpm --version)"

# sha256 checker
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CHECK="sha256sum -c"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CHECK="shasum -a 256 -c"
else
  err "neither sha256sum nor shasum found"
fi

# --- resolve version ------------------------------------------------------
VERSION_TAG="${ALAYA_VERSION:-}"
if [ -z "$VERSION_TAG" ]; then
  info "resolving latest release tag from github.com/${REPO}..."
  api_resp="$(curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
    "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)" \
    || err "GitHub API request failed (rate-limited?). Set ALAYA_VERSION=vX.Y.Z to bypass."
  VERSION_TAG=$(printf '%s' "$api_resp" \
    | grep -m1 '"tag_name":' \
    | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')
  [ -z "$VERSION_TAG" ] \
    && err "could not parse latest release tag for ${REPO}. Set ALAYA_VERSION=vX.Y.Z to bypass."
fi
# Strict semver guard (regex, not glob — globs accept v0.1.2.3, v0.1.2x,
# and any tail after a digit, which is too permissive for an unsanitized env).
if [[ ! "$VERSION_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  err "ALAYA_VERSION must look like v0.1.2 or v0.1.2-rc.1 (got: ${VERSION_TAG})"
fi
VERSION="${VERSION_TAG#v}"
ok "version: ${VERSION_TAG}"

# --- download + verify ----------------------------------------------------
ASSET_BASE="https://github.com/${REPO}/releases/download/${VERSION_TAG}"
TARBALL_NAME="${ALAYA_TARBALL:-do-soul-alaya-${VERSION}.tar.gz}"

CURL_OPTS=(-fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3)

info "downloading ${TARBALL_NAME}..."
curl "${CURL_OPTS[@]}" -o "${TMP_DIR}/${TARBALL_NAME}" "${ASSET_BASE}/${TARBALL_NAME}" \
  || err "tarball download failed: ${ASSET_BASE}/${TARBALL_NAME}"

info "downloading SHA256SUMS..."
curl "${CURL_OPTS[@]}" -o "${TMP_DIR}/SHA256SUMS" "${ASSET_BASE}/SHA256SUMS" \
  || err "SHA256SUMS download failed: ${ASSET_BASE}/SHA256SUMS"

info "verifying checksum..."
# Anchored match: line must end with the exact tarball name.
if ! grep -E "[ *]${TARBALL_NAME}\$" "${TMP_DIR}/SHA256SUMS" >"${TMP_DIR}/sums.filtered"; then
  err "SHA256SUMS does not contain an entry for ${TARBALL_NAME}"
fi
( cd "$TMP_DIR" && $SHA_CHECK "sums.filtered" ) || err "checksum verification failed"
ok "checksum ok"

# Reject unsafe paths inside the tarball before extraction.
info "scanning tarball for unsafe paths..."
if tar -tzf "${TMP_DIR}/${TARBALL_NAME}" \
  | awk '/^\// || /(^|\/)\.\.($|\/)/ { bad=1 } END { exit bad ? 1 : 0 }'; then
  ok "tarball entries are sandboxed"
else
  err "tarball contains absolute or .. paths; refusing to extract"
fi

# --- staged install (atomic swap on success) ------------------------------
info "extracting into staging (${STAGING_DIR})..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
tar -xzf "${TMP_DIR}/${TARBALL_NAME}" -C "$STAGING_DIR" \
  --strip-components=1 \
  --no-same-owner \
  --no-same-permissions

cd "$STAGING_DIR"
info "installing dependencies (pnpm install --frozen-lockfile)..."
pnpm install --frozen-lockfile
info "building (pnpm build)..."
pnpm build

# Sanity: the bin shim must be runnable.
if ! node ./bin/alaya.mjs --help >/dev/null 2>&1; then
  err "post-build sanity check failed: \`node ./bin/alaya.mjs --help\` did not exit 0"
fi
ok "post-build sanity check passed"

# Atomic swap.
if [ -d "$ALAYA_HOME" ]; then
  warn "existing install at ${ALAYA_HOME} -> ${ALAYA_HOME}.bak"
  rm -rf "${ALAYA_HOME}.bak"
  mv "$ALAYA_HOME" "${ALAYA_HOME}.bak"
fi
mv "$STAGING_DIR" "$ALAYA_HOME"

# --- link bin -------------------------------------------------------------
mkdir -p "$ALAYA_BIN_DIR"
ALAYA_BIN_LINK="${ALAYA_BIN_DIR}/alaya"
if [ -e "$ALAYA_BIN_LINK" ] && [ ! -L "$ALAYA_BIN_LINK" ]; then
  warn "${ALAYA_BIN_LINK} exists as a regular file/dir (not a symlink) — overwriting"
fi
ln -sfn "${ALAYA_HOME}/bin/alaya.mjs" "$ALAYA_BIN_LINK"
chmod +x "${ALAYA_HOME}/bin/alaya.mjs" 2>/dev/null || true
ok "linked: ${ALAYA_BIN_LINK} -> ${ALAYA_HOME}/bin/alaya.mjs"

case ":${PATH}:" in
  *":${ALAYA_BIN_DIR}:"*)
    ok "${ALAYA_BIN_DIR} is on PATH"
    ;;
  *)
    warn "${ALAYA_BIN_DIR} is not on PATH"
    info "Add this line to your shell rc (~/.bashrc, ~/.zshrc, ...):"
    info '  export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac

bold ""
bold "Installed Do-SOUL Alaya ${VERSION_TAG}."
info ""
info "Next steps:"
info "  alaya doctor          # verify runtime"
info "  alaya install         # attach to your CLI agent (codex / claude code / ...)"
info "  alaya inspect --open  # open the Memory Inspector UI"
info ""
info "Uninstall: bash ${ALAYA_HOME}/scripts/uninstall.sh   (add --purge to remove ~/.config/alaya)"
