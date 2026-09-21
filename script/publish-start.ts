#!/usr/bin/env bun

import { $ } from "bun"
import { Script } from "@nikcli-ai/script"
import { buildNotes, getLatestRelease, writeReleaseSection } from "./changelog"

let notes: string[] = []

console.log("=== publishing ===\n")

if (!Script.preview) {
  const previous = await getLatestRelease()
  try {
    // Generate the changelog straight from the commit messages (grouped by area),
    // no AI / nikcli server required — robust in CI.
    notes = await buildNotes(previous, "HEAD", { raw: true })
  } catch (e) {
    console.log("Could not build changelog notes:", e)
    notes = []
  }

  // Record this release in CHANGELOG.md as part of the upcoming "release: vX"
  // commit. Doing it here (instead of a separate bot push) avoids racing the
  // branch and keeps the file in sync with the GitHub release notes below.
  try {
    await writeReleaseSection(Script.version, notes)
  } catch (e) {
    console.log("Could not update CHANGELOG.md:", e)
  }
}

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

for (const file of pkgjsons) {
  let pkg = await Bun.file(file).text()
  pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
  console.log("updated:", file)
  await Bun.file(file).write(pkg)
}

const extensionToml = new URL("../packages/extensions/zed/extension.toml", import.meta.url).pathname
if (await Bun.file(extensionToml).exists()) {
  let toml = await Bun.file(extensionToml).text()
  toml = toml.replace(/^version = "[^"]+"/m, `version = "${Script.version}"`)
  toml = toml.replaceAll(/releases\/download\/v[^/]+\//g, `releases/download/v${Script.version}/`)
  console.log("updated:", extensionToml)
  await Bun.file(extensionToml).write(toml)
}

await $`bun install`

console.log("\n=== nikcli ===\n")
await import(`../packages/nikcli/script/publish.ts`)

console.log("\n=== sdk ===\n")
await import(`../packages/sdk/js/script/publish.ts`)

console.log("\n=== plugin ===\n")
await import(`../packages/plugin/script/publish.ts`)

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

let output = `version=${Script.version}\n`

if (!Script.preview) {
  const branch = process.env.GITHUB_REF_NAME || (await $`git branch --show-current`.text().then((x) => x.trim()))
  if (!branch) {
    throw new Error("Unable to determine branch for release push")
  }
  // Use GH_PUSH_TOKEN (workflow token) for pushing — SST_GITHUB_TOKEN is a GitHub App
  // token and lacks 'workflows' permission needed to push .yml files.
  // GITHUB_TOKEN env var from the workflow resolves to the GitHub App token value,
  // so we must use a separate env var name (GH_PUSH_TOKEN) to avoid the conflict.
  const pushToken = process.env.GH_PUSH_TOKEN || process.env.GITHUB_TOKEN || process.env.SST_GITHUB_TOKEN
  await $`git remote set-url origin https://x-access-token:${pushToken}@github.com/nikcli/nikcli`
  // Drop any unintended modifications to workflow/action YAML — GitHub blocks
  // GITHUB_TOKEN from pushing changes under .github/workflows/* by design.
  // If prettier/format steps touched them, restore from index to keep the release push clean.
  // Also restore install scripts to avoid triggering CI loops on those changes.
  await $`git checkout -- .github/workflows .github/actions install packages/web/install`.nothrow()
  await $`git commit -am "release: v${Script.version}"`
  await $`git add -A`
  await $`git commit --amend --no-edit`

  // Publishing takes several minutes, during which `${branch}` may receive new
  // commits — a plain push then rejects with "non-fast-forward". Rebase the
  // release commit onto the latest remote tip and retry the branch push.
  let branchPushed = false
  for (let attempt = 0; attempt < 5 && !branchPushed; attempt++) {
    await $`git fetch origin ${branch}`
    // Build steps that run alongside the release (astro sync, codegen, ...) can
    // regenerate tracked files after the commit above, and `git rebase` refuses
    // to start on a dirty tree ("cannot rebase: You have unstaged changes").
    // Fold anything that reappeared into the release commit so a retry is never
    // blocked by generated noise.
    if ((await $`git status --porcelain`.text()).trim()) {
      await $`git add -A`
      await $`git commit --amend --no-edit`
    }
    const rebase = await $`git rebase origin/${branch}`.nothrow()
    if (rebase.exitCode !== 0) {
      /*
       * A release that landed while this one was publishing.
       *
       * Runs queue behind each other on the branch, and the second one builds
       * its release commit on the tip it checked out rather than on the one
       * the first left behind. Both rewrite the same lines — the "version" of
       * every package.json, the zed extension, the lockfile, the top of
       * CHANGELOG.md — so the rebase conflicts in all of them and the release
       * dies here, with its packages already on npm.
       *
       * Those files are the release commit's own output: it says "every
       * version is now X", and X is published, so its side wins. CHANGELOG.md
       * is the exception — the section the other release wrote has to survive
       * — so the remote file is kept and this version's section written into
       * it again, above the one already there. A conflict anywhere else is not
       * something a release commit produces, and still fails loudly.
       */
      const conflicted = (await $`git diff --name-only --diff-filter=U`.text())
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      const releaseOwned = (file: string) =>
        file.endsWith("package.json") ||
        file === "bun.lock" ||
        file === "CHANGELOG.md" ||
        file === "packages/extensions/zed/extension.toml"
      if (conflicted.length === 0 || !conflicted.every(releaseOwned)) {
        await $`git rebase --abort`.nothrow()
        throw new Error(`Failed to rebase release commit onto origin/${branch}`)
      }
      console.log(`resolving ${conflicted.length} release conflicts against origin/${branch}`)
      for (const file of conflicted) {
        // Mid-rebase, "ours" is the remote tip and "theirs" is the commit being
        // replayed: this release.
        if (file === "CHANGELOG.md") await $`git checkout --ours -- ${file}`
        else await $`git checkout --theirs -- ${file}`
      }
      if (conflicted.includes("CHANGELOG.md")) await writeReleaseSection(Script.version, notes)
      await $`git add -A`
      const resumed = await $`git -c core.editor=true rebase --continue`.nothrow()
      if (resumed.exitCode !== 0) {
        await $`git rebase --abort`.nothrow()
        throw new Error(`Failed to rebase release commit onto origin/${branch}`)
      }
    }
    const push = await $`git push origin HEAD:${branch}`.nothrow()
    branchPushed = push.exitCode === 0
    if (!branchPushed) await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  if (!branchPushed) throw new Error(`Failed to push release commit to ${branch} after retries`)

  // Tag the settled commit and push the tag separately.
  await $`git tag v${Script.version}`
  await $`git push origin v${Script.version}`
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --notes ${notes.join("\n") || "No notable changes"} ./packages/nikcli/dist/*.zip ./packages/nikcli/dist/*.tar.gz`
  const release = await $`gh release view v${Script.version} --json id,tagName`.json()
  output += `release=${release.id}\n`
  output += `tag=${release.tagName}\n`
}

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output)
}
