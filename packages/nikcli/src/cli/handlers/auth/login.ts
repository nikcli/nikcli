import { Option } from "effect"
import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { Auth } from "@/auth"
import * as prompts from "@clack/prompts"
import { UI } from "@/cli/ui"
import { ModelsDev } from "@/provider/models"
import { map, pipe, sortBy, values } from "remeda"
import { Effect } from "effect"
import { withInstanceAsync } from "@/effect"
import { loginAccount } from "@/cli/handlers/account/shared"
import { Policy } from "@/policy/policy"
import { log, runAuth, configGet, authSet, pluginList, handlePluginAuth } from "./shared"

export default Runtime.handler(Commands.commands["auth"].commands["login"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    url: Option.getOrUndefined(input["url"]),
    provider: input["provider"],
    server: Option.getOrUndefined(input["server"]),
  }
  await withInstanceAsync({ directory: process.cwd() }, async () => {
    {
      if (!args.url && !args.provider) {
        await loginAccount(args.server)
        return
      }
      UI.empty()
      prompts.intro("Add credential")

      if (args.url) {
        const url = args.url
        log.debug("Login with well-known URL", { url })

        const wellknownResponse = await runAuth(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            return yield* auth.fetchWellKnown(url)
          }),
        )
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null)

        const wellknown = Auth.WellKnownAuthResponse.safeParse(wellknownResponse)

        if (!wellknown.success) {
          prompts.log.error("Invalid auth response from server")
          prompts.outro("Done")
          return
        }

        let token: string
        try {
          token = await runAuth(
            Effect.gen(function* () {
              const auth = yield* Auth.Service
              return yield* auth.fetchWellKnownToken(url, [...wellknown.data.auth.command])
            }),
          )
        } catch (error) {
          log.error("Failed to fetch well-known token", { error })
          prompts.log.error(error instanceof Error ? error.message : "Failed")
          prompts.outro("Done")
          return
        }

        await authSet(url, {
          type: "wellknown",
          key: wellknown.data.auth.env,
          token: token.trim(),
        })
        prompts.log.success("Logged into " + url)
        log.info("Well-known login successful", { url })
        prompts.outro("Done")
        return
      }

      await ModelsDev.refresh().catch(() => {})

      const config = await configGet()

      const providers = Policy.filter(config, await ModelsDev.get())

      const priority: Record<string, number> = {
        nikcli: 0,
        anthropic: 1,
        "github-copilot": 2,
        openai: 3,
        google: 4,
        openrouter: 5,
        vercel: 6,
      }
      let provider = await prompts.autocomplete({
        message: "Select provider",
        maxItems: 8,
        options: [
          ...pipe(
            providers,
            values(),
            sortBy(
              (x) => priority[x.id] ?? 99,
              (x) => x.name ?? x.id,
            ),
            map((x) => ({
              label: x.name,
              value: x.id,
              hint: {
                nikcli: "recommended",
                anthropic: "Claude Max or API key",
                openai: "ChatGPT Plus/Pro or API key",
              }[x.id],
            })),
          ),
          {
            value: "other",
            label: "Other",
          },
        ],
      })

      if (prompts.isCancel(provider)) {
        prompts.outro("Done")
        return
      }

      const plugin = await pluginList().then((x) => x.find((x) => x.auth?.provider === provider))
      if (plugin && plugin.auth) {
        const handled = await handlePluginAuth({ auth: plugin.auth }, provider)
        if (handled) return
      }

      if (provider === "other") {
        provider = await prompts.text({
          message: "Enter provider id",
          validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
        })
        if (prompts.isCancel(provider)) {
          prompts.outro("Done")
          return
        }
        provider = provider.replace(/^@ai-sdk\//, "")

        const customPlugin = await pluginList().then((x) => x.find((x) => x.auth?.provider === provider))
        if (customPlugin && customPlugin.auth) {
          const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider)
          if (handled) return
        }

        prompts.log.warn(
          `This only stores a credential for ${provider} - you will need configure it in nikcli.json, check the docs for examples.`,
        )
      }

      if (provider === "amazon-bedrock") {
        prompts.log.info(
          "Amazon Bedrock authentication priority:\n" +
            "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
            "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
            "Configure via nikcli.json options (profile, region, endpoint) or\n" +
            "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
        )
      }

      if (provider === "nikcli") {
        prompts.log.info("Create an api key at https://nikcli-ai.dev/auth")
      }

      if (provider === "vercel") {
        prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
      }

      if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
        prompts.log.info(
          "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://nikcli-ai.dev/docs/providers/#cloudflare-ai-gateway",
        )
      }

      const key = await prompts.password({
        message: "Enter your API key",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(key)) {
        prompts.outro("Done")
        return
      }

      log.info("Setting API key", { provider })
      await authSet(provider, {
        type: "api",
        key,
      })

      prompts.outro("Done")
    }
  })
})
