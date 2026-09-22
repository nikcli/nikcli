#!/usr/bin/env node

// Materializes the correct per-platform nikcli binary next to the `bin/nikcli`
// wrapper so the wrapper can exec it directly.
//
// This is best-effort by design: the wrapper resolves the binary at runtime too,
// so a failure here (pnpm without postinstall, --ignore-scripts, yarn PnP, npm's
// optionalDependencies bug) must never fail the install. We exit 0 and let the
// wrapper try again later.

import fs from "fs"
import os from "os"
import path from "path"
import childProcess from "child_process"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Published layout puts this file at the package root; in the repo it lives in
// `script/`. Resolve the package root from whichever one actually has a manifest.
const packageRoot = fs.existsSync(path.join(__dirname, "package.json")) ? __dirname : path.join(__dirname, "..")
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" }
const archMap = { x64: "x64", arm64: "arm64", arm: "arm" }

const platform = platformMap[os.platform()] ?? os.platform()
const arch = archMap[os.arch()] ?? os.arch()
const base = `nikcli-ai-${platform}-${arch}`
// Bun's `--compile` appends `.exe` on Windows targets, so that is the name inside
// the per-platform package on Windows and the bare name everywhere else.
const sourceBinary = platform === "windows" ? "nikcli.exe" : "nikcli"
// Never overwrite `bin/nikcli` — that file IS the wrapper this package declares
// in its `bin` field. We drop the native binary beside it instead.
const targetBinary = path.join(packageRoot, "bin", platform === "windows" ? "nikcli.exe" : "nikcli-bin")

function supportsAvx2() {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    // PF_AVX2_INSTRUCTIONS_AVAILABLE == 40
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = (result.stdout || "").trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        continue
      }
    }
  }

  return false
}

function isMusl() {
  if (platform !== "linux") return false

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Ignore filesystem probes blocked by the host.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

// Ordered best → worst. A baseline binary runs on an AVX2 machine (just slower),
// so it stays in the list as a fallback; the reverse is a SIGILL crash, which is
// why the baseline probe must be right on every platform.
// Since Bun 1.4 the x64 build is itself baseline and no `-baseline` package is
// published any more, so those names only ever resolve for releases <= 1.299.0.
// They stay in the list for exactly that reason — a missing name is skipped, and
// the plain x64 package the list falls through to is safe on every CPU.
function packageNames() {
  const baseline = arch === "x64" && !supportsAvx2()

  if (platform === "linux") {
    if (isMusl()) {
      if (arch === "x64")
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
      return [`${base}-musl`, base]
    }

    if (arch === "x64")
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
    return [base, `${base}-musl`]
  }

  if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  return [base]
}

function resolveBinary(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`)
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", sourceBinary)
  if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`)
  return binaryPath
}

function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) fs.unlinkSync(target)
  try {
    // Hardlink when we can: no second copy of a ~100MB binary on disk.
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
  }
  fs.chmodSync(target, 0o755)
}

// npm has a long-standing bug where optionalDependencies are skipped when a
// lockfile was produced on another platform. Fetching the one package we need
// into a temp prefix recovers from it without touching the user's tree.
function installPackage(name) {
  const version = packageJson.optionalDependencies?.[name]
  if (!version) return false

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nikcli-install-"))
  try {
    const result = childProcess.spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, `${name}@${version}`],
      // npm is npm.cmd on Windows, so it needs a shell to be spawnable.
      // Output stays quiet: we print our own diagnostic if every candidate fails.
      { stdio: "ignore", windowsHide: true, shell: process.platform === "win32" },
    )
    if (result.status !== 0) return false
    copyBinary(path.join(temp, "node_modules", name, "bin", sourceBinary), targetBinary)
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
    timeout: 30000,
  })
  return result.status === 0
}

function main() {
  const names = packageNames()
  for (const name of names) {
    try {
      copyBinary(resolveBinary(name), targetBinary)
      if (verifyBinary()) {
        console.log(`nikcli: using ${name}`)
        return
      }
    } catch {
      if (installPackage(name) && verifyBinary()) {
        console.log(`nikcli: using ${name} (fetched separately)`)
        return
      }
    }
  }

  throw new Error(
    `could not resolve a native binary for ${platform}-${arch}. Tried: ${names.join(", ")}.\n` +
      `The 'nikcli' command will try again at runtime. To fix it now, install one of those packages manually,\n` +
      `or use the standalone installer: https://nikcli-ai.dev/install`,
  )
}

try {
  main()
} catch (error) {
  // Non-fatal on purpose: the wrapper resolves the binary at runtime as well.
  console.warn(`nikcli postinstall: ${error.message}`)
}
