import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import path from "path"
import { exec } from "child_process"
import * as prompts from "@clack/prompts"
import { map, pipe, sortBy, values } from "remeda"
import { UI } from "@/cli/ui"
import { ModelsDev } from "@/provider/models"
import { withInstanceAsync } from "@/effect"
import { Git } from "@/git"
import { parseGitHubRemote } from "@/util/repository"
import { GITHUB_APP_NAME, API_BASE_URL, WORKFLOW_FILE } from "./shared"

export default Runtime.handler(Commands.commands["github"].commands["install"], async (_input) => {
  await withInstanceAsync({ directory: process.cwd() }, async (instance) => {
    {
      UI.empty()
      prompts.intro("Install GitHub agent")
      const app = await getAppInfo()
      await installGitHubApp()

      const providers = await ModelsDev.get().then((p) => {
        delete p["github-copilot"]
        return p
      })

      const provider = await promptProvider()
      const model = await promptModel()

      await addWorkflowFiles()
      printNextSteps()

      function printNextSteps() {
        let step2
        if (provider === "amazon-bedrock") {
          step2 =
            "Configure OIDC in AWS - https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services"
        } else {
          step2 = [
            `    2. Add the following secrets in org or repo (${app.owner}/${app.repo}) settings`,
            "",
            ...providers[provider].env.map((e) => `       - ${e}`),
          ].join("\n")
        }

        prompts.outro(
          [
            "Next steps:",
            "",
            `    1. Commit the \`${WORKFLOW_FILE}\` file and push`,
            step2,
            "",
            "    3. Go to a GitHub issue and comment `/nik summarize` to see the agent in action",
            "",
            "   Learn more about the GitHub agent - https://nikcli.store/docs/github/#usage-examples",
          ].join("\n"),
        )
      }

      async function getAppInfo() {
        const project = instance.project
        if (project.vcs !== "git") {
          prompts.log.error(`Could not find git repository. Please run this command from a git repository.`)
          throw new UI.CancelledError()
        }

        const info = (
          await Git.run(["remote", "get-url", "origin"], {
            cwd: instance.worktree,
          })
        )
          .text()
          .trim()
        const parsed = parseGitHubRemote(info)
        if (!parsed) {
          prompts.log.error(`Could not find git repository. Please run this command from a git repository.`)
          throw new UI.CancelledError()
        }
        return {
          owner: parsed.owner,
          repo: parsed.repo,
          root: instance.worktree,
        }
      }

      async function promptProvider() {
        const priority: Record<string, number> = {
          nikcli: 0,
          anthropic: 1,
          openai: 2,
          google: 3,
        }
        let provider = await prompts.select({
          message: "Select provider",
          maxItems: 8,
          options: pipe(
            providers,
            values(),
            sortBy(
              (x) => priority[x.id] ?? 99,
              (x) => x.name ?? x.id,
            ),
            map((x) => ({
              label: x.name,
              value: x.id,
              hint: priority[x.id] === 0 ? "recommended" : undefined,
            })),
          ),
        })

        if (prompts.isCancel(provider)) throw new UI.CancelledError()

        return provider
      }

      async function promptModel() {
        const providerData = providers[provider]!

        const model = await prompts.select({
          message: "Select model",
          maxItems: 8,
          options: pipe(
            providerData.models,
            values(),
            sortBy((x) => x.name ?? x.id),
            map((x) => ({
              label: x.name ?? x.id,
              value: x.id,
            })),
          ),
        })

        if (prompts.isCancel(model)) throw new UI.CancelledError()
        return model
      }

      async function installGitHubApp() {
        const s = prompts.spinner()
        s.start("Installing GitHub app")

        const installation = await getInstallation()
        if (installation) return s.stop("GitHub app already installed")

        const url = `https://github.com/apps/${GITHUB_APP_NAME}`
        const command =
          process.platform === "darwin"
            ? `open "${url}"`
            : process.platform === "win32"
              ? `start "" "${url}"`
              : `xdg-open "${url}"`

        // Hides the intermediary console window, not the browser this launches.
        exec(command, { windowsHide: true }, (error) => {
          if (error) {
            prompts.log.warn(`Could not open browser. Please visit: ${url}`)
          }
        })

        // Skip polling for custom apps (non-official)
        if (GITHUB_APP_NAME !== "nikcli-agent") {
          s.stop(`Opened ${url} - please install the app and then press Enter to continue...`)
          await prompts.confirm({
            message: "Have you installed the GitHub app?",
          })
          return
        }

        s.message("Waiting for GitHub app to be installed")
        const MAX_RETRIES = 120
        let retries = 0
        // Poll for installation; bounded by MAX_RETRIES.
        while (true) {
          const installation = await getInstallation()
          if (installation) break

          if (retries > MAX_RETRIES) {
            s.stop(
              `Failed to detect GitHub app installation. Make sure to install the app for the \`${app.owner}/${app.repo}\` repository.`,
            )
            throw new UI.CancelledError()
          }

          retries++
          await Bun.sleep(1000)
        }

        s.stop("Installed GitHub app")

        async function getInstallation() {
          const res = await fetch(`${API_BASE_URL}/get_github_app_installation?owner=${app.owner}&repo=${app.repo}`)
          if (!res.ok) return null
          const data = await res.json()
          return data.installation
        }
      }

      async function addWorkflowFiles() {
        const envStr =
          provider === "amazon-bedrock"
            ? ""
            : `\n        env:${providers[provider].env.map((e) => `\n          ${e}: \${{ secrets.${e} }}`).join("")}`

        await Bun.write(
          path.join(app.root, WORKFLOW_FILE),
          `name: nikcli

  on:
    issue_comment:
      types: [created]
    pull_request_review_comment:
      types: [created]

  jobs:
    nikcli:
      if: |
        contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association) &&
        (
          contains(github.event.comment.body, ' /nik ') ||
          startsWith(github.event.comment.body, '/nik ') ||
          github.event.comment.body == '/nik' ||
          contains(github.event.comment.body, ' /nikcli ') ||
          startsWith(github.event.comment.body, '/nikcli ') ||
          github.event.comment.body == '/nikcli'
        )
      runs-on: ubuntu-latest
      timeout-minutes: 30
      permissions:
        id-token: write
        contents: write
        pull-requests: write
        issues: write
      steps:
        - name: Checkout repository
          uses: actions/checkout@v6
          with:
            fetch-depth: 0
            persist-credentials: false

        - name: Run nikcli
          uses: nikcli/nikcli/github@latest${envStr}
          with:
            model: ${provider}/${model}`,
        )

        prompts.log.success(`Added workflow file: "${WORKFLOW_FILE}"`)
      }
    }
  })
})
