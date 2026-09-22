#!/usr/bin/env bun

/**
 * finalize-updater.ts — Assembles the Tauri auto-updater manifest (latest.json)
 * from the per-platform updater fragments produced by the desktop-release build
 * matrix, then uploads it to the GitHub release.
 *
 * This is the Tauri equivalent of electron-builder's latest*.yml files: Tauri
 * uses a single latest.json keyed by `<os>-<arch>`, each entry holding the
 * detached signature and the download URL of the platform's update bundle.
 *
 * Each build leg uploads an artifact `updater-<target>` containing:
 *   - meta.json  → { "key": "<platform-key>", "file": "<release asset name>" }
 *   - <name>.sig → the detached signature for that asset
 *
 * Env:
 *   UPDATER_FRAGMENTS_DIR  directory holding the downloaded updater-* artifacts
 *   GH_REPO                e.g. nikcli/nikcli
 *   NIKCLI_VERSION         version without leading v, e.g. 1.107.0
 *   RELEASE_NOTES          (optional) notes string for the manifest
 */

import { $ } from "bun"
import path from "path"
import fs from "fs"

const dir = process.env.UPDATER_FRAGMENTS_DIR
if (!dir) throw new Error("UPDATER_FRAGMENTS_DIR is required")

const repo = process.env.GH_REPO
if (!repo) throw new Error("GH_REPO is required")

const version = process.env.NIKCLI_VERSION
if (!version) throw new Error("NIKCLI_VERSION is required")

const tag = `v${version.replace(/^v/, "")}`

type Platform = { signature: string; url: string }

const platforms: Record<string, Platform> = {}

// Each updater-<target> artifact is downloaded into its own subdirectory.
const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const fragDir = path.join(dir, entry.name)
  const metaPath = path.join(fragDir, "meta.json")
  if (!fs.existsSync(metaPath)) continue

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { key: string; file: string }
  const sigPath = path.join(fragDir, `${meta.file}.sig`)
  if (!fs.existsSync(sigPath)) {
    console.log(`skipping ${meta.key}: missing signature ${meta.file}.sig`)
    continue
  }

  platforms[meta.key] = {
    signature: fs.readFileSync(sigPath, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${meta.file}`,
  }
  console.log(`added platform ${meta.key} -> ${meta.file}`)
}

if (Object.keys(platforms).length === 0) {
  console.log("no updater fragments found — nothing to finalize")
  process.exit(0)
}

const manifest = {
  version: tag,
  notes: process.env.RELEASE_NOTES || `Nikcli ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
}

const tmp = process.env.RUNNER_TEMP ?? "/tmp"
const outPath = path.join(tmp, "latest.json")
await Bun.write(outPath, JSON.stringify(manifest, null, 2))

console.log("=== latest.json ===")
console.log(JSON.stringify(manifest, null, 2))

await $`gh release upload ${tag} ${outPath} --clobber --repo ${repo}`
console.log(`uploaded latest.json to ${tag}`)
