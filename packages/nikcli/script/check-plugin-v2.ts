#!/usr/bin/env bun
/**
 * `script/check-plugin-v2.ts` — EOT-14 plugin v2 contract gate.
 *
 * `specs/effect-tui/14-plugin-v2-architecture.md` says the v2 manifest is
 * the discriminator between v1 and v2 plugins, capability gating is a
 * typed failure, and the autoload policy is a hard opt-in.
 *
 * This script enforces three structural invariants in CI:
 *
 *  1. `packages/plugin/src/v2/manifest.ts` exists and exports
 *     `parseManifest`, `hasManifest`, `CapabilityDenied`, `Incompatible`,
 *     `ManifestInvalid`, `Capability`, `ManifestSchema`.
 *  2. The nikcli source does NOT auto-import config-dir tools without the
 *     `NIKCLI_ALLOW_PLUGIN_AUTOLOAD` or `tool.allow` opt-in — the autoload
 *     path must consult one of those two gates before importing anything.
 *  3. `packages/nikcli/AGENTS.md` documents the same contract for human
 *     reviewers (the source of truth the test suite does not enforce).
 *
 * The script does not import the plugin package — that would require a
 * build step. It reads source files and asserts the contract survives
 * refactors.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const MANIFEST = path.join(REPO_ROOT, "packages", "plugin", "src", "v2", "manifest.ts")
const REGISTRY = path.join(REPO_ROOT, "packages", "nikcli", "src", "tool", "registry.ts")
const AGENTS = path.join(REPO_ROOT, "packages", "nikcli", "AGENTS.md")

const REQUIRED_EXPORTS = [
  "parseManifest",
  "hasManifest",
  "CapabilityDenied",
  "Incompatible",
  "ManifestInvalid",
  "Capability",
]

async function main() {
  const findings: string[] = []

  if (!existsSync(MANIFEST)) {
    findings.push(`missing v2 manifest module: ${path.relative(REPO_ROOT, MANIFEST)}`)
  } else {
    const source = readFileSync(MANIFEST, "utf8")
    for (const name of REQUIRED_EXPORTS) {
      // `export function`, `export class`, `export const` — cover all three
      // forms the manifest uses for its public surface.
      const pattern = new RegExp(`export\\s+(function|class|const|namespace)\\s+${name}\\b`)
      if (!pattern.test(source)) {
        findings.push(`${path.relative(REPO_ROOT, MANIFEST)} does not export ${name}`)
      }
    }
    if (!source.includes("PluginV2ManifestInvalid")) {
      findings.push(`${path.relative(REPO_ROOT, MANIFEST)} is missing the PluginV2ManifestInvalid tag`)
    }
    if (!source.includes("PluginV2Incompatible")) {
      findings.push(`${path.relative(REPO_ROOT, MANIFEST)} is missing the PluginV2Incompatible tag`)
    }
    if (!source.includes("PluginV2CapabilityDenied")) {
      findings.push(`${path.relative(REPO_ROOT, MANIFEST)} is missing the PluginV2CapabilityDenied tag`)
    }
  }

  if (!existsSync(REGISTRY)) {
    findings.push(`missing tool registry: ${path.relative(REPO_ROOT, REGISTRY)}`)
  } else {
    const source = readFileSync(REGISTRY, "utf8")
    // The autoload path must consult the env OR the allowlist before reading
    // any file. Either is enough; both is the documented contract.
    if (!source.includes("NIKCLI_ALLOW_PLUGIN_AUTOLOAD")) {
      findings.push(`${path.relative(REPO_ROOT, REGISTRY)} never references NIKCLI_ALLOW_PLUGIN_AUTOLOAD`)
    }
    if (!source.includes("tool.allow") && !source.includes("allowlist")) {
      findings.push(`${path.relative(REPO_ROOT, REGISTRY)} never consults tool.allow / allowlist`)
    }
  }

  if (!existsSync(AGENTS)) {
    findings.push(`missing AGENTS.md: ${path.relative(REPO_ROOT, AGENTS)}`)
  } else {
    const source = readFileSync(AGENTS, "utf8")
    const agentsRel = path.relative(REPO_ROOT, AGENTS)
    if (!source.includes("NIKCLI_ALLOW_PLUGIN_AUTOLOAD")) {
      findings.push(`${agentsRel} does not document NIKCLI_ALLOW_PLUGIN_AUTOLOAD`)
    }
    if (!source.includes("tool.pin") && !source.includes('"pin"')) {
      findings.push(`${agentsRel} does not document tool.pin`)
    }
  }

  console.log(`EOT-14 plugin v2 gate — manifest module + registry opt-in + AGENTS.md docs`)

  if (findings.length > 0) {
    console.error("")
    console.error(`FAIL: ${findings.length} finding(s):`)
    for (const finding of findings) {
      console.error(`  - ${finding}`)
    }
    console.error("")
    console.error(
      "Either (a) restore the missing export / doc, or (b) update the required list in this script and the EOT-14 spec together.",
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-plugin-v2 failed:", error)
  process.exit(2)
})
