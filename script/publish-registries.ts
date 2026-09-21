#!/usr/bin/env bun
import { $ } from "bun"
import { Script } from "@nikcli-ai/script"
import crypto from "crypto"
import fs from "fs"
import path from "path"

if (!Script.preview) {
  const version = Script.version
  const distDir = path.resolve("./dist")

  console.log("=== publishing homebrew formula ===\n")

  // ── Helper: compute SHA256 of a file ──────────────────────────────────────
  async function sha256(filePath: string): Promise<string> {
    const buffer = fs.readFileSync(filePath)
    return crypto.createHash("sha256").update(buffer).digest("hex")
  }

  // ── Helper: find an archive file matching a glob-like pattern ─────────────
  function findArchive(pattern: string): string | null {
    const fullPath = path.join(distDir, pattern)
    if (fs.existsSync(fullPath)) return fullPath

    const files = fs.readdirSync(distDir)
    const match = files.find((f) => f === pattern)
    if (match) return path.join(distDir, match)

    return null
  }

  // ── Required archives for the formula ──────────────────────────────────────
  const requiredArchives = {
    "darwin-arm64": "nikcli-ai-darwin-arm64.zip",
    "darwin-x64": "nikcli-ai-darwin-x64.zip",
    "linux-arm64": "nikcli-ai-linux-arm64.tar.gz",
    "linux-x64": "nikcli-ai-linux-x64.tar.gz",
  } as const

  type Platform = keyof typeof requiredArchives

  // ── Compute SHA256 for each required archive ───────────────────────────────
  const shas: Record<Platform, string> = {} as any
  for (const [platform, filename] of Object.entries(requiredArchives)) {
    const filePath = findArchive(filename)
    if (!filePath) {
      console.error(`missing archive: ${filename} — skipping homebrew formula publish`)
      process.exit(1)
    }
    const hash = await sha256(filePath)
    shas[platform as Platform] = hash
    console.log(`  sha256(${filename}) = ${hash}`)
  }

  // ── Generate Homebrew formula ──────────────────────────────────────────────
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was auto-generated. DO NOT EDIT.",
    `# Last updated: ${new Date().toISOString()}`,
    "class Nikcli < Formula",
    `  desc "The AI coding agent built for the terminal."`,
    `  homepage "https://github.com/nikcli/nikcli"`,
    `  version "${version}"`,
    `  license "MIT"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/nikcli/nikcli/releases/download/v${Script.version}/nikcli-ai-darwin-x64.zip"`,
    `      sha256 "${shas["darwin-x64"]}"`,
    "",
    "      def install",
    '        bin.install "nikcli"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/nikcli/nikcli/releases/download/v${Script.version}/nikcli-ai-darwin-arm64.zip"`,
    `      sha256 "${shas["darwin-arm64"]}"`,
    "",
    "      def install",
    '        bin.install "nikcli"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/nikcli/nikcli/releases/download/v${Script.version}/nikcli-ai-linux-x64.tar.gz"`,
    `      sha256 "${shas["linux-x64"]}"`,
    "",
    "      def install",
    '        bin.install "nikcli"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/nikcli/nikcli/releases/download/v${Script.version}/nikcli-ai-linux-arm64.tar.gz"`,
    `      sha256 "${shas["linux-arm64"]}"`,
    "",
    "      def install",
    '        bin.install "nikcli"',
    "      end",
    "    end",
    "  end",
    "",
    "  test do",
    '    assert_match(/#{version}/, shell_output("#{bin}/nikcli --version"))',
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  console.log("\ngenerated homebrew formula:")
  console.log(homebrewFormula)

  // ── Clone, update, and push the homebrew tap ───────────────────────────────
  const token = process.env["GITHUB_TOKEN"] || process.env["GH_PUSH_TOKEN"] || process.env["SST_GITHUB_TOKEN"]
  if (!token) {
    console.error("GITHUB_TOKEN not set — cannot push homebrew tap")
    process.exit(1)
  }

  const tapDir = path.resolve("./dist/homebrew-tap")

  console.log("\ncloning homebrew tap...")
  await $`rm -rf ${tapDir}`
  await $`git clone https://${token}@github.com/nikomatt69/homebrew-tap.git ${tapDir}`

  await Bun.file(path.join(tapDir, "nikcli.rb")).write(homebrewFormula)

  console.log("committing and pushing formula...")
  await $`git -c user.name="nikcli-ci" -c user.email="nikcli-ci[bot]@users.noreply.github.com" add nikcli.rb`.cwd(
    tapDir,
  )
  await $`git -c user.name="nikcli-ci" -c user.email="nikcli-ci[bot]@users.noreply.github.com" commit -m "nikcli v${Script.version}"`.cwd(
    tapDir,
  )
  await $`git push`.cwd(tapDir)

  console.log(`\nhomebrew formula published for v${Script.version}`)
}
