import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization } from "@nikcli-ai/sdk/httpapi"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import { Keybind } from "@tui/util/keybind"
import { useAbortOnCleanup } from "@tui/util/lifecycle"

const PROVIDER_PRIORITY: Record<string, number> = {
  nikcli: 0,
  anthropic: 1,
  "github-copilot": 2,
  openai: 3,
  google: 4,
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const connected = createMemo(() => new Set(sync.data.provider_next.connected))
  const options = createMemo(() => {
    return pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => {
        const isConnected = connected().has(provider.id)
        return {
          title: provider.name,
          value: provider.id,
          description: {
            nikcli: "(Recommended)",
            anthropic: "(Claude Max or API key)",
            openai: "(ChatGPT Plus/Pro or API key)",
          }[provider.id],
          category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Other",
          footer: isConnected ? "Connected" : undefined,
          async onSelect() {
            if (isConnected) {
              dialog.replace(() => <DialogModel providerID={provider.id} />)
              return
            }
            const methods = sync.data.provider_auth[provider.id] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              const result = await sdk.client.provider.oauth.authorize({
                providerID: provider.id,
                method: index,
              })
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
              if ((result.data?.method as string) === "auto-code") {
                dialog.replace(() => (
                  <AutoCodeMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
            }
            if (method.type === "api") {
              return dialog.replace(() => <ApiMethod providerID={provider.id} title={method.label} />)
            }
          },
        }
      }),
    )
  })
  return options
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

function providerSourceDescription(source: string | undefined) {
  if (source === "api") return "API key"
  if (source === "config") return "Configured provider"
  if (source === "env") return "Environment credentials"
  if (source === "custom") return "Custom provider"
  return "Stored credentials"
}

function useDisconnectProvider() {
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  return async function disconnectProvider(providerID: string) {
    const connectedProvider = sync.data.provider.find((item) => item.id === providerID)
    const listedProvider = sync.data.provider_next.all.find((item) => item.id === providerID)
    const providerName = connectedProvider?.name ?? listedProvider?.name ?? providerID
    const source = connectedProvider?.source ?? "api"

    const remove = await sdk.client.auth.remove({ providerID }).catch((error: unknown) => ({ error }))
    if (remove.error) {
      toast.show({ variant: "error", message: errorMessage(remove.error) })
      return false
    }

    if (source !== "api") {
      const policies = sync.data.config.experimental?.policies ?? []
      const alreadyDenied = policies.some(
        (statement) =>
          statement.effect === "deny" && statement.action === "provider.use" && statement.resource === providerID,
      )
      if (!alreadyDenied) {
        const update = await sdk.client.config
          .update({
            payload: {
              experimental: {
                ...sync.data.config.experimental,
                policies: [
                  ...policies,
                  {
                    effect: "deny",
                    action: "provider.use",
                    resource: providerID,
                  },
                ],
              },
            },
          })
          .catch((error: unknown) => ({ error }))
        if (update.error) {
          toast.show({ variant: "error", message: errorMessage(update.error) })
          return false
        }
        if ("data" in update && update.data) sync.set("config", update.data)
      }
    }

    await sdk.client.instance.dispose().catch((error: unknown) => {
      toast.show({
        variant: "warning",
        message: `Disconnected, but refresh failed: ${errorMessage(error)}`,
      })
    })
    await sync.refreshProviders().catch((error: unknown) => {
      toast.show({
        variant: "warning",
        message: `Disconnected, but refresh failed: ${errorMessage(error)}`,
      })
    })
    toast.show({ variant: "info", message: `${providerName} disconnected` })
    return true
  }
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  const sync = useSync()
  const toast = useToast()
  const dialog = useDialog()
  const disconnectProvider = useDisconnectProvider()
  const [pending, setPending] = createSignal(false)
  const allOptions = createMemo(() => {
    const base = options()
    // A1: "Try without account" — surface OpenRouter's free models to
    // first-time users. We open the openrouter provider's auth flow
    // directly with a `:free` hint in the description.
    if (sync.data.provider_next.connected.length === 0) {
      return [
        {
          title: "Try for free (OpenRouter :free models)",
          value: "openrouter.free",
          description: "Free API key from openrouter.ai/settings/keys — works with any `:free` model.",
          category: "Get started",
          async onSelect() {
            const methods = sync.data.provider_auth["openrouter"] ?? [{ type: "api", label: "API key" }]
            const apiMethod = methods.find((m) => m.type === "api")
            if (!apiMethod) {
              toast.show({
                variant: "warning",
                message: "OpenRouter API-key auth is not available in this build of nikcli.",
                duration: 5000,
              })
              return
            }
            dialog.replace(() => <OpenRouterFreeMethod title={apiMethod.label} />)
          },
        },
        ...base,
      ]
    }
    return base
  })
  return (
    <DialogSelect
      title="Connect a provider"
      options={allOptions()}
      keybind={[
        {
          keybind: Keybind.parse("ctrl+d")[0],
          title: pending() ? "Disconnecting" : "Disconnect",
          disabled: sync.data.provider_next.connected.length === 0 || pending(),
          onTrigger: async (option) => {
            const providerID = String(option.value)
            if (!sync.data.provider_next.connected.includes(providerID)) {
              toast.show({
                variant: "warning",
                message: "Select a connected provider to disconnect",
              })
              return
            }
            setPending(true)
            try {
              await disconnectProvider(providerID)
            } finally {
              setPending(false)
            }
          },
        },
      ]}
    />
  )
}

export function DialogProviderDisconnect() {
  const sync = useSync()
  const dialog = useDialog()
  const disconnectProvider = useDisconnectProvider()
  const [pending, setPending] = createSignal<string>()
  const options = createMemo(() => {
    if (sync.data.provider_next.connected.length === 0) {
      return [
        {
          title: "No connected providers",
          value: "",
          description: "Use /connect to add a provider",
          disabled: true,
        },
      ]
    }

    return sync.data.provider_next.connected.map((providerID) => {
      const connectedProvider = sync.data.provider.find((item) => item.id === providerID)
      const listedProvider = sync.data.provider_next.all.find((item) => item.id === providerID)
      const providerName = connectedProvider?.name ?? listedProvider?.name ?? providerID
      const disabled = pending() !== undefined
      return {
        title: pending() === providerID ? `Disconnecting ${providerName}` : providerName,
        value: providerID,
        description: providerSourceDescription(connectedProvider?.source),
        footer: providerID,
        disabled,
        async onSelect() {
          if (disabled) return
          setPending(providerID)
          const disconnected = await disconnectProvider(providerID)
          setPending(undefined)
          if (disconnected) dialog.clear()
        },
      }
    })
  })

  return <DialogSelect title="Disconnect provider" options={options()} />
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  const life = useAbortOnCleanup()

  onMount(async () => {
    // The callback blocks until the browser approves. `esc` in the meantime
    // unmounts this dialog, so every step past the first await re-checks —
    // disposing the SDK instance or replacing the stack after the user left is
    // how a provider dialog reappears over an unrelated screen.
    const result = await sdk.client.provider.oauth.callback(
      { providerID: props.providerID, method: props.index },
      { signal: life.signal },
    )
    if (life.disposed()) return
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    if (life.disposed()) return
    await sync.bootstrap()
    if (life.disposed()) return
    await sync.refreshProviders()
    if (life.disposed()) return
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.foreground.default}>
          {props.title}
        </text>
        <text fg={theme.foreground.muted}>esc</text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.accent.fg} />
        <text fg={theme.foreground.muted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.foreground.muted}>Waiting for authorization...</text>
      <text fg={theme.foreground.default}>
        c <span style={{ fg: theme.foreground.muted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)
  const life = useAbortOnCleanup()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback(
          {
            providerID: props.providerID,
            method: props.index,
            code: value,
          },
          { signal: life.signal },
        )
        if (life.disposed()) return
        if (!error) {
          await sdk.client.instance.dispose()
          if (life.disposed()) return
          await sync.bootstrap()
          if (life.disposed()) return
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.foreground.muted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.accent.fg} />
          <Show when={error()}>
            <text fg={theme.status.error.fg}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

function AutoCodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)
  const [complete, setComplete] = createSignal(false)
  const life = useAbortOnCleanup()

  async function finish() {
    if (complete() || life.disposed()) return
    setComplete(true)
    await sdk.client.instance.dispose()
    if (life.disposed()) return
    await sync.bootstrap()
    if (life.disposed()) return
    await sync.refreshProviders()
    if (life.disposed()) return
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  }

  onMount(async () => {
    const { error } = await sdk.client.provider.oauth.callback(
      { providerID: props.providerID, method: props.index },
      { signal: life.signal },
    )
    if (life.disposed()) return
    if (!error) await finish()
  })

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        if (!value) return
        const { error } = await sdk.client.provider.oauth.callback(
          {
            providerID: props.providerID,
            method: props.index,
            code: value,
          },
          { signal: life.signal },
        )
        if (life.disposed()) return
        if (!error) {
          await finish()
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.foreground.muted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.accent.fg} />
          <text fg={theme.foreground.muted}>Waiting for authorization, or paste the code shown by xAI.</text>
          <Show when={error()}>
            <text fg={theme.status.error.fg}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
}

/**
 * Variant of ApiMethod for the A1 "Try for free" flow. Renders a
 * OpenRouter-specific description that points the user at the free API
 * key page and shows the `:free` model naming convention. After auth,
 * the same C8 fail-fast check runs.
 */
function OpenRouterFreeMethod(props: { title: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const life = useAbortOnCleanup()

  return (
    <DialogPrompt
      title="OpenRouter free tier"
      placeholder="OpenRouter API key (any free key from openrouter.ai)"
      description={() => (
        <box gap={1}>
          <text fg={theme.foreground.muted}>
            OpenRouter gives you a free API key at{" "}
            <span style={{ fg: theme.accent.fg }}>https://openrouter.ai/settings/keys</span>.
          </text>
          <text fg={theme.foreground.muted}>
            After saving, the model picker filters to <span style={{ fg: theme.accent.alt }}>`:free`</span> models
            automatically.
          </text>
        </box>
      )}
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set(
          {
            providerID: "openrouter",
            payload: { type: "api", key: value },
          },
          { signal: life.signal },
        )
        if (life.disposed()) return
        await sdk.client.instance.dispose()
        if (life.disposed()) return
        await sync.bootstrap()
        if (life.disposed()) return
        await sync.refreshProviders()
        if (life.disposed()) return
        const isConnected = sync.data.provider_next.connected.includes("openrouter")
        if (!isConnected) {
          toast.show({
            variant: "error",
            message: "Saved key, but openrouter did not come back connected. Check the key and try again.",
            duration: 8000,
          })
          return
        }
        // After successful free-tier connect, jump straight to a `:free`
        // After successful free-tier connect, jump straight to the model
        // picker scoped to openrouter so the user can pick a `:free` model.
        dialog.replace(() => <DialogModel providerID="openrouter" />)
      }}
    />
  )
}

function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const life = useAbortOnCleanup()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={
        props.providerID === "nikcli"
          ? () => (
              <box gap={1}>
                <text fg={theme.foreground.muted}>
                  Nikcli Zen gives you access to all the best coding models at the cheapest prices with a single API
                  key.
                </text>
                <text fg={theme.foreground.default}>
                  Go to <span style={{ fg: theme.accent.fg }}>https://nikcli.store/zen</span> to get a key
                </text>
              </box>
            )
          : undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set(
          {
            providerID: props.providerID,
            payload: { type: "api", key: value },
          },
          { signal: life.signal },
        )
        if (life.disposed()) return
        await sdk.client.instance.dispose()
        if (life.disposed()) return
        await sync.bootstrap()
        if (life.disposed()) return
        await sync.refreshProviders()
        if (life.disposed()) return
        // C8: verify the provider actually shows as connected after the
        // round-trip. If not, the key is bad — fail fast with a clear
        // message and stay on the prompt so the user can re-enter.
        const isConnected = sync.data.provider_next.connected.includes(props.providerID)
        if (!isConnected) {
          toast.show({
            variant: "error",
            message: `Saved key for ${props.providerID}, but the provider did not come back connected. Check the key and try again.`,
            duration: 8000,
          })
          return
        }
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}
