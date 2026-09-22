#!/usr/bin/env bash
# Cache-bust: 2026-07-29T00-00-00Z
set -euo pipefail
APP=nikcli
ASSET_PREFIX=nikcli-ai

# Bun's --compile appends .exe on Windows targets, so both the file inside the
# release archive and the installed command need the extension under Git Bash /
# MSYS / Cygwin. Computed here so the --binary path gets it too.
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) BIN_NAME="$APP.exe" ;;
    *) BIN_NAME="$APP" ;;
esac

# ────────────────────────────────────────────────────────────────────────────
# Styling (opencode-style clack rails)
# ────────────────────────────────────────────────────────────────────────────

if [ -t 2 ]; then
    TTY=true
else
    TTY=false
fi

if [ "$TTY" = "true" ] && [ -z "${NO_COLOR:-}" ]; then
    DIM='\033[0;2m'
    BOLD='\033[1m'
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[38;5;214m'
    CYAN='\033[0;36m'
    GRAY='\033[0;90m'
    NC='\033[0m'
else
    DIM=''; BOLD=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; GRAY=''; NC=''
fi

# Glyphs (use ASCII fallbacks if locale isn't UTF-8)
case "${LANG:-}${LC_ALL:-}" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*)
        G_BAR='│'
        G_TOP='┌'
        G_BOT='└'
        G_DOT='●'
        G_OK='◇'
        G_WARN='▲'
        G_ERR='■'
        ;;
    *)
        G_BAR='|'
        G_TOP='+'
        G_BOT='+'
        G_DOT='o'
        G_OK='*'
        G_WARN='!'
        G_ERR='x'
        ;;
esac

# All UI goes to stderr so `curl | bash` keeps the rails visible.
ui() { printf "%b\n" "$1" >&2; }

logo() {
    if [ "$TTY" != "true" ]; then return 0; fi
    ui ""
    ui "${GRAY}    ███╗   ██╗██╗██╗  ██╗ ██████╗██╗     ██╗${NC}"
    ui "${GRAY}    ████╗  ██║██║██║ ██╔╝██╔════╝██║     ██║${NC}"
    ui "${GRAY}    ██╔██╗ ██║██║█████╔╝ ██║     ██║     ██║${NC}"
    ui "${GRAY}    ██║╚██╗██║██║██╔═██╗ ██║     ██║     ██║${NC}"
    ui "${GRAY}    ██║ ╚████║██║██║  ██╗╚██████╗███████╗██║${NC}"
    ui "${GRAY}    ╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝${NC}"
    ui ""
}

intro() { ui "${GRAY}${G_TOP}${NC}  ${BOLD}$1${NC}"; ui "${GRAY}${G_BAR}${NC}"; }
step()  { ui "${CYAN}${G_DOT}${NC}  $1"; ui "${GRAY}${G_BAR}${NC}"; }
warn()  { ui "${YELLOW}${G_WARN}${NC}  $1"; ui "${GRAY}${G_BAR}${NC}"; }
fail()  { ui "${RED}${G_ERR}${NC}  ${RED}$1${NC}"; ui "${GRAY}${G_BAR}${NC}"; }
outro() { ui "${GRAY}${G_BOT}${NC}  ${BOLD}$1${NC}"; }

# Spinner — animated frames printed on a single line, advances on the rail.
SPINNER_PID=""
spinner_start() {
    local label="$1"
    if [ "$TTY" != "true" ]; then
        ui "${CYAN}${G_DOT}${NC}  $label"
        ui "${GRAY}${G_BAR}${NC}"
        return 0
    fi
    printf '\033[?25l' >&2
    (
        local frames='◐◓◑◒'
        local i=0
        while :; do
            local c="${frames:$((i % 4)):1}"
            printf '\r%b%s%b  %s ' "$CYAN" "$c" "$NC" "$label" >&2
            i=$((i + 1))
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
    disown "$SPINNER_PID" 2>/dev/null || true
}

spinner_stop() {
    local status="$1"
    local message="$2"
    if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
        kill "$SPINNER_PID" 2>/dev/null || true
        wait "$SPINNER_PID" 2>/dev/null || true
    fi
    SPINNER_PID=""
    if [ "$TTY" = "true" ]; then
        printf '\r\033[2K' >&2
        printf '\033[?25h' >&2
    fi
    if [ "$status" = "ok" ]; then
        ui "${GREEN}${G_OK}${NC}  $message"
    else
        ui "${RED}${G_ERR}${NC}  ${RED}$message${NC}"
    fi
    ui "${GRAY}${G_BAR}${NC}"
}

cleanup_on_exit() {
    if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
        kill "$SPINNER_PID" 2>/dev/null || true
    fi
    if [ "$TTY" = "true" ]; then
        printf '\033[?25h' >&2
    fi
}
trap cleanup_on_exit EXIT INT TERM

# ────────────────────────────────────────────────────────────────────────────
# Usage & args
# ────────────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Nikcli Installer

Usage: install.sh [options]

Options:
    -h, --help              Display this help message
    -v, --version <version> Install a specific version (e.g., 1.0.180)
    -b, --binary <path>     Install from a local binary instead of downloading
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc, etc.)

Examples:
    curl -fsSL https://nikcli-ai.dev/install | bash
    curl -fsSL https://nikcli-ai.dev/install | bash -s -- --version 1.5.0
    ./install --binary /path/to/nikcli
EOF
}

requested_version=${VERSION:-}
no_modify_path=false
binary_path=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            if [[ -n "${2:-}" ]]; then
                requested_version="$2"
                shift 2
            else
                logo; intro "Install"; fail "--version requires a version argument"; outro "Aborted"
                exit 1
            fi
            ;;
        -b|--binary)
            if [[ -n "${2:-}" ]]; then
                binary_path="$2"
                shift 2
            else
                logo; intro "Install"; fail "--binary requires a path argument"; outro "Aborted"
                exit 1
            fi
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        *)
            warn "Unknown option '$1'"
            shift
            ;;
    esac
done

# ────────────────────────────────────────────────────────────────────────────
# Start the UI
# ────────────────────────────────────────────────────────────────────────────

logo
intro "Install"

INSTALL_DIR=${NIKCLI_INSTALL_DIR:-${XDG_BIN_DIR:-$HOME/.nikcli/bin}}
mkdir -p "$INSTALL_DIR"

# ────────────────────────────────────────────────────────────────────────────
# Platform detection / version resolution
# ────────────────────────────────────────────────────────────────────────────

if [ -n "$binary_path" ]; then
    if [ ! -f "$binary_path" ]; then
        fail "Binary not found at ${binary_path}"
        outro "Aborted"
        exit 1
    fi
    specific_version="local"
    step "Using local binary: ${BOLD}${binary_path}${NC}"
else
    raw_os=$(uname -s)
    os=$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')
    case "$raw_os" in
      Darwin*) os="darwin" ;;
      Linux*) os="linux" ;;
      MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    esac

    arch=$(uname -m)
    if [[ "$arch" == "aarch64" ]]; then
      arch="arm64"
    fi
    if [[ "$arch" == "x86_64" ]]; then
      arch="x64"
    fi

    if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
      rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
      if [ "$rosetta_flag" = "1" ]; then
        arch="arm64"
      fi
    fi

    combo="$os-$arch"
    case "$combo" in
      linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64|windows-arm64)
        ;;
      *)
        fail "Unsupported OS/Arch: $os/$arch"
        outro "Aborted"
        exit 1
        ;;
    esac

    archive_ext=".zip"
    if [ "$os" = "linux" ]; then
      archive_ext=".tar.gz"
    fi

    is_musl=false
    if [ "$os" = "linux" ]; then
      if [ -f /etc/alpine-release ]; then
        is_musl=true
      fi
      if command -v ldd >/dev/null 2>&1; then
        if ldd --version 2>&1 | grep -qi musl; then
          is_musl=true
        fi
      fi
    fi

    needs_baseline=false
    if [ "$arch" = "x64" ]; then
      if [ "$os" = "linux" ]; then
        if ! grep -qi avx2 /proc/cpuinfo 2>/dev/null; then
          needs_baseline=true
        fi
      fi
      if [ "$os" = "darwin" ]; then
        avx2=$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)
        if [ "$avx2" != "1" ]; then
          needs_baseline=true
        fi
      fi
      if [ "$os" = "windows" ]; then
        # No /proc/cpuinfo under MSYS/Git Bash — ask the kernel through PowerShell.
        # PF_AVX2_INSTRUCTIONS_AVAILABLE == 40. Anything other than a clear "true"
        # falls back to the baseline build, which runs everywhere.
        ps='(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
        avx2_out=""
        if command -v powershell.exe >/dev/null 2>&1; then
          avx2_out=$(powershell.exe -NoProfile -NonInteractive -Command "$ps" 2>/dev/null || true)
        elif command -v pwsh >/dev/null 2>&1; then
          avx2_out=$(pwsh -NoProfile -NonInteractive -Command "$ps" 2>/dev/null || true)
        fi
        avx2_out=$(echo "$avx2_out" | tr -d '\r' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
        if [ "$avx2_out" != "true" ] && [ "$avx2_out" != "1" ]; then
          needs_baseline=true
        fi
      fi
    fi

    # Bun 1.4 emits one x64 build that is itself baseline (no AVX2 required), so
    # releases from 1.300.0 on ship no `-baseline` asset at all; earlier releases
    # do. When the CPU needs baseline we therefore try the baseline asset first
    # and fall back to the plain target. Both orders are safe: on an old release
    # the baseline asset exists and wins, and on a new one the plain asset it
    # falls back to runs everywhere. The reverse — handing an AVX2 build to a CPU
    # without AVX2 — is a SIGILL, so the plain target is never tried first here.
    musl_suffix=""
    if [ "$is_musl" = "true" ]; then
      musl_suffix="-musl"
    fi

    target="$os-$arch$musl_suffix"
    target_fallback=""
    if [ "$needs_baseline" = "true" ]; then
      target_fallback="$target"
      target="$os-$arch-baseline$musl_suffix"
    fi

    filename="$ASSET_PREFIX-$target$archive_ext"

    if [ "$os" = "linux" ]; then
        if ! command -v tar >/dev/null 2>&1; then
            fail "'tar' is required but not installed"
            outro "Aborted"
            exit 1
        fi
    else
        if ! command -v unzip >/dev/null 2>&1; then
            fail "'unzip' is required but not installed"
            outro "Aborted"
            exit 1
        fi
    fi

    step "Detected: ${BOLD}${os}${NC} ${DIM}(${arch})${NC}"

    if [ -z "$requested_version" ]; then
        release_url_primary="https://nikcli-ai.dev/releases/latest/download"
        release_url_fallback="https://github.com/nikcli/nikcli/releases/latest/download"
        spinner_start "Resolving latest version"
        specific_version=$(curl -s https://api.github.com/repos/nikcli/nikcli/releases/latest | sed -E -n 's/.*"tag_name": *"v?([^"]*)".*/\1/p' || true)
        if [ -z "$specific_version" ]; then
            spinner_stop err "Failed to fetch version information"
            outro "Aborted"
            exit 1
        fi
        spinner_stop ok "Latest version: ${BOLD}${specific_version}${NC}"
    else
        requested_version="${requested_version#v}"
        release_tag="v${requested_version}"
        release_url_primary="https://nikcli-ai.dev/releases/download/${release_tag}"
        release_url_fallback="https://github.com/nikcli/nikcli/releases/download/${release_tag}"
        specific_version=$requested_version

        http_status=$(curl -sI -o /dev/null -w "%{http_code}" "https://github.com/nikcli/nikcli/releases/tag/${release_tag}")
        if [ "$http_status" = "404" ]; then
            http_status_bare=$(curl -sI -o /dev/null -w "%{http_code}" "https://github.com/nikcli/nikcli/releases/tag/${requested_version}")
            if [ "$http_status_bare" = "200" ] || [ "$http_status_bare" = "302" ]; then
                release_tag="${requested_version}"
                release_url_primary="https://nikcli-ai.dev/releases/download/${release_tag}"
                release_url_fallback="https://github.com/nikcli/nikcli/releases/download/${release_tag}"
            else
                fail "Release ${requested_version} not found"
                ui "${GRAY}${G_BAR}${NC}  ${DIM}See https://github.com/nikcli/nikcli/releases${NC}"
                outro "Aborted"
                exit 1
            fi
        fi
        step "Target version: ${BOLD}${specific_version}${NC}"
    fi
fi

# ────────────────────────────────────────────────────────────────────────────
# Already installed?
# ────────────────────────────────────────────────────────────────────────────

check_version() {
    if command -v nikcli >/dev/null 2>&1; then
        installed_version=$(nikcli --version 2>/dev/null || echo "")
        if [[ -n "$installed_version" && "$installed_version" != "$specific_version" ]]; then
            step "Currently installed: ${BOLD}${installed_version}${NC} ${DIM}→${NC} ${BOLD}${specific_version}${NC}"
        elif [[ "$installed_version" == "$specific_version" ]]; then
            step "Version ${BOLD}${specific_version}${NC} already installed"
            outro "Done"
            exit 0
        fi
    fi
}

# ────────────────────────────────────────────────────────────────────────────
# Download & install
# ────────────────────────────────────────────────────────────────────────────

download_and_install() {
    local tmp_dir="${TMPDIR:-/tmp}/nikcli_install_$$"
    mkdir -p "$tmp_dir"

    local download_success=false
    spinner_start "Downloading ${APP} ${specific_version}"

    # $target is the baseline asset and $target_fallback the plain one when the
    # CPU needs baseline; otherwise $target_fallback is empty and there is a
    # single candidate. A release carrying neither is a genuine failure.
    local http_code
    local candidate_target
    local candidate_url
    for candidate_target in "$target" "$target_fallback"; do
        if [ -z "$candidate_target" ]; then
            continue
        fi
        target="$candidate_target"
        filename="$ASSET_PREFIX-$target$archive_ext"
        for candidate_url in "$release_url_primary/$filename" "$release_url_fallback/$filename"; do
            rm -f "$tmp_dir/$filename"
            http_code=$(curl -sL -w "%{http_code}" -o "$tmp_dir/$filename" "$candidate_url" 2>/dev/null || echo "000")
            if [ "$http_code" = "200" ] && [ -s "$tmp_dir/$filename" ]; then
                download_success=true
                break
            fi
        done
        if [ "$download_success" = true ]; then
            break
        fi
    done

    if [ "$download_success" = false ]; then
        rm -f "$tmp_dir/$filename"
        spinner_stop err "Failed to download nikcli"
        rm -rf "$tmp_dir"
        outro "Aborted"
        exit 1
    fi
    spinner_stop ok "Downloaded ${DIM}${filename}${NC}"

    spinner_start "Extracting archive"
    if [ "$os" = "linux" ]; then
        tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"
    else
        unzip -q "$tmp_dir/$filename" -d "$tmp_dir"
    fi

    # Layouts seen across releases: <triplet>/bin/<binary> (current), bin/<binary>,
    # and the flat archive root. Windows archives carry the .exe suffix.
    local extracted_binary=""
    local candidate
    for candidate in \
        "$tmp_dir/$ASSET_PREFIX-$target/bin/$BIN_NAME" \
        "$tmp_dir/bin/$BIN_NAME" \
        "$tmp_dir/$BIN_NAME"; do
        if [ -f "$candidate" ]; then
            extracted_binary="$candidate"
            break
        fi
    done
    if [ -z "$extracted_binary" ]; then
        spinner_stop err "Binary not found in archive at expected path"
        rm -rf "$tmp_dir"
        outro "Aborted"
        exit 1
    fi

    mv "$extracted_binary" "$INSTALL_DIR/$BIN_NAME"
    chmod 755 "${INSTALL_DIR}/$BIN_NAME"
    rm -rf "$tmp_dir"
    spinner_stop ok "Installed to ${BOLD}${INSTALL_DIR}/${BIN_NAME}${NC}"
}

install_from_binary() {
    spinner_start "Installing from local binary"
    cp "$binary_path" "${INSTALL_DIR}/$BIN_NAME"
    chmod 755 "${INSTALL_DIR}/$BIN_NAME"
    spinner_stop ok "Installed to ${BOLD}${INSTALL_DIR}/${BIN_NAME}${NC}"
}

if [ -n "$binary_path" ]; then
    install_from_binary
else
    check_version
    download_and_install
fi

# ────────────────────────────────────────────────────────────────────────────
# PATH
# ────────────────────────────────────────────────────────────────────────────

add_to_path() {
    local config_file=$1
    local command=$2

    if grep -Fxq "$command" "$config_file"; then
        step "${APP} already on \$PATH in ${DIM}${config_file}${NC}"
    elif [[ -w $config_file ]]; then
        echo -e "\n# nikcli" >> "$config_file"
        echo "$command" >> "$config_file"
        step "Added ${BOLD}${APP}${NC} to \$PATH in ${DIM}${config_file}${NC}"
    else
        warn "Manually add to ${config_file}:  ${command}"
    fi
}

XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}

current_shell=$(basename "$SHELL")
case $current_shell in
    fish)
        config_files="$HOME/.config/fish/config.fish"
    ;;
    zsh)
        config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
    ;;
    bash)
        config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
    ;;
    ash|sh)
        config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
    ;;
    *)
        config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
    ;;
esac

if [[ "$no_modify_path" != "true" ]]; then
    config_file=""
    for file in $config_files; do
        if [[ -f $file ]]; then
            config_file=$file
            break
        fi
    done

    if [[ -z $config_file ]]; then
        warn "No config file found for ${current_shell}. Add manually: export PATH=$INSTALL_DIR:\$PATH"
    elif [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        case $current_shell in
            fish)
                add_to_path "$config_file" "fish_add_path $INSTALL_DIR"
            ;;
            zsh|bash|ash|sh)
                add_to_path "$config_file" "export PATH=$INSTALL_DIR:\$PATH"
            ;;
            *)
                export PATH=$INSTALL_DIR:$PATH
                warn "Manually add to ${config_file}:  export PATH=$INSTALL_DIR:\$PATH"
            ;;
        esac
    else
        step "${BOLD}${INSTALL_DIR}${NC} already on \$PATH"
    fi
fi

# Under Git Bash the shell rc above only fixes $PATH for Git Bash itself — cmd.exe
# and PowerShell read the Windows user PATH, so register it there too. Editing the
# User scope only (never the machine one) keeps this safe without elevation.
if [ "$BIN_NAME" != "$APP" ] && [[ "$no_modify_path" != "true" ]]; then
    win_dir=""
    if command -v cygpath >/dev/null 2>&1; then
        win_dir=$(cygpath -w "$INSTALL_DIR" 2>/dev/null || true)
    fi
    if [ -n "$win_dir" ]; then
        # The directory travels through the environment, not the command line, so
        # spaces and quotes in the path cannot break the PowerShell parse.
        win_ps=$(printf '%s' '$dir = $env:NIKCLI_WIN_INSTALL_DIR
$current = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $current) { $current = "" }
$parts = $current -split ";" | Where-Object { $_ -ne "" }
if ($parts -notcontains $dir) {
  [Environment]::SetEnvironmentVariable("Path", (($parts + $dir) -join ";"), "User")
  Write-Output "added"
} else {
  Write-Output "present"
}')
        win_shell=""
        if command -v powershell.exe >/dev/null 2>&1; then
            win_shell=powershell.exe
        elif command -v pwsh >/dev/null 2>&1; then
            win_shell=pwsh
        fi
        if [ -n "$win_shell" ]; then
            win_out=$(NIKCLI_WIN_INSTALL_DIR="$win_dir" "$win_shell" -NoProfile -NonInteractive -Command "$win_ps" 2>/dev/null | tr -d '\r' || true)
            case "$win_out" in
                *added*) step "Added ${BOLD}${win_dir}${NC} to the Windows user PATH ${DIM}(restart your terminal)${NC}" ;;
                *present*) step "${BOLD}${win_dir}${NC} already on the Windows PATH" ;;
                *) warn "Add ${win_dir} to your Windows PATH manually" ;;
            esac
        else
            warn "Add ${win_dir} to your Windows PATH manually"
        fi
    fi
fi

if [ -n "${GITHUB_ACTIONS-}" ] && [ "${GITHUB_ACTIONS}" == "true" ]; then
    echo "$INSTALL_DIR" >> "$GITHUB_PATH"
    step "Added ${INSTALL_DIR} to \$GITHUB_PATH"
fi

# ────────────────────────────────────────────────────────────────────────────
# Done
# ────────────────────────────────────────────────────────────────────────────

outro "${GREEN}${APP} ${specific_version} installed${NC}"
ui ""
ui "   ${DIM}Next steps${NC}"
ui "   ${BOLD}cd${NC} <project>          ${DIM}# open your project${NC}"
ui "   ${BOLD}${APP}${NC}                  ${DIM}# start nikcli${NC}"
ui ""
ui "   ${DIM}Docs: ${NC}${CYAN}https://nikcli-ai.dev/docs${NC}"
ui ""
