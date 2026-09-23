import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { UI } from "@/cli/ui"
import { withInstanceAsync } from "@/effect"
import { $ } from "bun"
import { Git } from "@/git"

export default Runtime.handler(Commands.commands["pr"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    number: input["number"],
  }
  await withInstanceAsync({ directory: process.cwd() }, async (instance) => {
    {
      const project = instance.project
      if (project.vcs !== "git") {
        UI.error("Could not find git repository. Please run this command from a git repository.")
        process.exit(1)
      }

      const prNumber = args.number
      const localBranchName = `pr/${prNumber}`
      UI.println(`Fetching and checking out PR #${prNumber}...`)

      const result = await $`gh pr checkout ${prNumber} --branch ${localBranchName} --force`.nothrow()

      if (result.exitCode !== 0) {
        UI.error(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`)
        process.exit(1)
      }

      const prInfoResult =
        await $`gh pr view ${prNumber} --json headRepository,headRepositoryOwner,isCrossRepository,headRefName,body`.nothrow()

      let sessionId: string | undefined

      if (prInfoResult.exitCode === 0) {
        const prInfoText = prInfoResult.text()
        if (prInfoText.trim()) {
          const prInfo = JSON.parse(prInfoText)

          if (prInfo && prInfo.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
            const forkOwner = prInfo.headRepositoryOwner.login
            const forkName = prInfo.headRepository.name
            const remoteName = forkOwner

            const cwd = instance.worktree
            const remoteList = await Git.remotes(cwd)
            if (!remoteList.includes(remoteName)) {
              await Git.remoteAdd(cwd, remoteName, `https://github.com/${forkOwner}/${forkName}.git`)
              UI.println(`Added fork remote: ${remoteName}`)
            }

            const headRefName = prInfo.headRefName
            await Git.branchSetUpstream(cwd, `${remoteName}/${headRefName}`, localBranchName)
          }

          if (prInfo && prInfo.body) {
            const sessionMatch = prInfo.body.match(/https:\/\/(?:nikcli-ai\.dev|nikcli\.store)\/s\/([a-zA-Z0-9_-]+)/)
            if (sessionMatch) {
              // Links from before the domain move point at nikcli.store; the share lives on nikcli-ai.dev.
              const sessionUrl = `https://nikcli-ai.dev/s/${sessionMatch[1]}`
              UI.println(`Found nikcli session: ${sessionUrl}`)
              UI.println(`Importing session...`)

              const importProc = Bun.spawn({
                windowsHide: true,
                cmd: [process.execPath, ...process.argv.slice(1, 2), "import", sessionUrl],
                stdout: "pipe",
                stderr: "pipe",
                cwd: process.cwd(),
                env: process.env,
              })
              const importExit = await importProc.exited
              if (importExit === 0) {
                const importOutput = (await new Response(importProc.stdout).text()).trim()
                const sessionIdMatch = importOutput.match(/Imported session: ([a-zA-Z0-9_-]+)/)
                if (sessionIdMatch) {
                  sessionId = sessionIdMatch[1]
                  UI.println(`Session imported: ${sessionId}`)
                }
              }
            }
          }
        }
      }

      UI.println(`Successfully checked out PR #${prNumber} as branch '${localBranchName}'`)
      UI.println()
      UI.println("Starting nikcli...")
      UI.println()

      const nikcliProcess = Bun.spawn({
        windowsHide: true,
        cmd: [process.execPath, ...process.argv.slice(1, 2), ...(sessionId ? ["-s", sessionId] : [])],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        cwd: process.cwd(),
        env: process.env,
      })
      const exitCode = await nikcliProcess.exited
      if (exitCode !== 0) {
        throw new Error(`nikcli exited with code ${exitCode}`)
      }
    }
  })
})
