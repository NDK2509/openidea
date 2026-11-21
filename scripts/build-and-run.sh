#!/usr/bin/env bash
# Builds OpenIDEA as a desktop app and launches it.
#
# Usage:
#   scripts/build-and-run.sh [options] [-- <app-args>...]
#
# Options:
#   --release      Build and run the release binary without OS installers (default)
#   --debug        Build and run a standalone debug binary (faster compile)
#   --dev          Run in Tauri dev mode with Vite HMR (uses `pnpm tauri dev`)
#   --bundle       Build full OS installer bundles too (`pnpm tauri build`)
#   --build-only   Build the desktop app without launching it
#   --run-only     Launch the previously built desktop binary without rebuilding
#   --install      Force `pnpm install --frozen-lockfile` before building
#   -h, --help     Show this help message
#
# Any positional arguments (or arguments after `--`) are forwarded to OpenIDEA,
# for example:
#   scripts/build-and-run.sh /path/to/project
#   scripts/build-and-run.sh --debug -- /path/to/project

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

mode="release"
bundle=0
build_only=0
run_only=0
force_install=0
app_args=()

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      mode="release"
      shift
      ;;
    --debug)
      mode="debug"
      shift
      ;;
    --dev)
      mode="dev"
      shift
      ;;
    --bundle)
      bundle=1
      shift
      ;;
    --build-only)
      build_only=1
      shift
      ;;
    --run-only)
      run_only=1
      shift
      ;;
    --install)
      force_install=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      app_args+=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      echo "Run '$0 --help' for usage." >&2
      exit 2
      ;;
    *)
      app_args+=("$1")
      shift
      ;;
  esac
done

if [ "$build_only" = 1 ] && [ "$run_only" = 1 ]; then
  echo "Error: --build-only and --run-only cannot be used together." >&2
  exit 2
fi

if [ "$mode" = "dev" ] && { [ "$build_only" = 1 ] || [ "$run_only" = 1 ] || [ "$bundle" = 1 ]; }; then
  echo "Error: --dev cannot be combined with --bundle, --build-only, or --run-only." >&2
  exit 2
fi

log() {
  printf '\033[1;34m==>\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

version_ge() {
  local actual="$1" required="$2"
  local a1 a2 a3 r1 r2 r3
  IFS=. read -r a1 a2 a3 <<<"${actual%%-*}"
  IFS=. read -r r1 r2 r3 <<<"${required%%-*}"
  a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}
  r1=${r1:-0}; r2=${r2:-0}; r3=${r3:-0}
  (( a1 > r1 )) && return 0
  (( a1 < r1 )) && return 1
  (( a2 > r2 )) && return 0
  (( a2 < r2 )) && return 1
  (( a3 >= r3 ))
}

pnpm_shim_dir=""
cleanup() {
  if [ -n "$pnpm_shim_dir" ] && [ -d "$pnpm_shim_dir" ]; then
    rm -rf "$pnpm_shim_dir"
  fi
}
trap cleanup EXIT

resolve_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_cmd=(pnpm)
  elif command -v corepack >/dev/null 2>&1; then
    local corepack_bin
    corepack_bin="$(command -v corepack)"
    pnpm_shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/openidea-pnpm.XXXXXX")"
    cat >"$pnpm_shim_dir/pnpm" <<EOF
#!/usr/bin/env sh
exec "$corepack_bin" pnpm "\$@"
EOF
    chmod +x "$pnpm_shim_dir/pnpm"
    export PATH="$pnpm_shim_dir:$PATH"
    pnpm_cmd=(pnpm)
  else
    die "pnpm is not installed (and corepack was not found). Install pnpm 11: https://pnpm.io/installation"
  fi
}

check_prereqs() {
  command -v node >/dev/null 2>&1 || die "Node.js (>= 22.18) is required."
  local node_ver
  node_ver="$(node -v | sed 's/^v//')"
  if ! version_ge "$node_ver" "22.18.0"; then
    die "Node.js $node_ver is too old; >= 22.18.0 is required."
  fi

  resolve_pnpm

  command -v cargo >/dev/null 2>&1 || die "Rust / cargo is required (https://rustup.rs)."
  command -v rustc >/dev/null 2>&1 || die "Rust / rustc is required (https://rustup.rs)."

  local rust_ver min_rust
  rust_ver="$(rustc --version | awk '{print $2}')"
  min_rust="$(sed -n 's/^rust-version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n 1)"
  min_rust="${min_rust:-1.96}"
  if ! version_ge "$rust_ver" "$min_rust"; then
    die "rustc $rust_ver is older than Cargo.toml's rust-version ($min_rust). Run 'rustup update stable' first."
  fi

  if [ "$(uname -s)" = "Linux" ]; then
    local missing_pkgs=()
    if command -v pkg-config >/dev/null 2>&1; then
      pkg-config --exists webkit2gtk-4.1 || missing_pkgs+=(libwebkit2gtk-4.1-dev)
      pkg-config --exists ayatana-appindicator3-0.1 || missing_pkgs+=(libayatana-appindicator3-dev)
      pkg-config --exists librsvg-2.0 || missing_pkgs+=(librsvg2-dev)
      pkg-config --exists openssl || missing_pkgs+=(libssl-dev)
    else
      missing_pkgs+=(pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev)
    fi

    if [ ! -f /usr/include/xdo.h ] && ! PATH="$PATH:/sbin:/usr/sbin" ldconfig -p 2>/dev/null | grep -q 'libxdo\.so'; then
      missing_pkgs+=(libxdo-dev)
    fi
    if [ "$bundle" = 1 ] && ! command -v patchelf >/dev/null 2>&1; then
      missing_pkgs+=(patchelf)
    fi

    if [ "${#missing_pkgs[@]}" -gt 0 ]; then
      die "Missing Linux Tauri system dependencies (${missing_pkgs[*]}).
Install on Debian/Ubuntu with:
  sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf"
    fi
  fi
}

ensure_node_modules() {
  if [ "$force_install" = 1 ] || [ ! -d "$repo_root/node_modules" ]; then
    log "Installing frontend dependencies with ${pnpm_cmd[*]}..."
    "${pnpm_cmd[@]}" install --frozen-lockfile
  fi
}

target_root="${CARGO_TARGET_DIR:-$repo_root/target}"

binary_path() {
  local profile="$1"
  local bin_name="openidea"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) bin_name="openidea.exe" ;;
  esac
  printf '%s/%s/%s\n' "$target_root" "$profile" "$bin_name"
}

check_display() {
  if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    warn "Neither DISPLAY nor WAYLAND_DISPLAY is set; launching a GUI desktop window may fail."
  fi
}

launch_binary() {
  local bin="$1"
  [ -x "$bin" ] || die "Desktop binary not found or not executable: $bin"
  check_display
  cleanup
  if [ "${#app_args[@]}" -gt 0 ]; then
    log "Launching OpenIDEA desktop app: $bin ${app_args[*]}"
    exec "$bin" "${app_args[@]}"
  else
    log "Launching OpenIDEA desktop app: $bin"
    exec "$bin"
  fi
}

if [ "$mode" = "dev" ]; then
  check_prereqs
  ensure_node_modules
  check_display
  log "Starting OpenIDEA in Tauri dev mode..."
  if [ "${#app_args[@]}" -gt 0 ]; then
    "${pnpm_cmd[@]}" tauri dev -- "${app_args[@]}"
  else
    "${pnpm_cmd[@]}" tauri dev
  fi
  exit $?
fi

if [ "$run_only" = 1 ]; then
  bin="$(binary_path "$mode")"
  launch_binary "$bin"
fi

check_prereqs
ensure_node_modules

build_args=(tauri build)
if [ "$mode" = "debug" ]; then
  build_args+=(--debug)
fi
if [ "$bundle" = 0 ]; then
  build_args+=(--no-bundle)
fi

log "Building OpenIDEA desktop app ($mode$([ "$bundle" = 1 ] && echo ', with bundles' || echo ', --no-bundle'))..."
"${pnpm_cmd[@]}" "${build_args[@]}"

bin="$(binary_path "$mode")"
log "Build complete: $bin"

if [ "$build_only" = 1 ]; then
  exit 0
fi

launch_binary "$bin"
