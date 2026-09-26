import { render, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createCliRenderer, type CliRendererConfig } from "@opentui/core"
import { Clipboard } from "@tui/util/clipboard"
import * as Sound from "@tui/util/sound"
import { UserApi } from "@tui/util/user-api"
import { RouteProvider, useRoute } from "@tui/context/route"
import {
  Switch,
  Match,
  createEffect,
  untrack,
  ErrorBoundary,
  createSignal,
  Show,
  onMount,
  onCleanup,
  batch,
  on,
} from "solid-js"
import { VERSION, type InstallMethod } from "@nikcli-ai/util/version"
import { Flag } from "@nikcli-ai/util/flag"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderList, DialogProviderDisconnect } from "@tui/component/dialog-provider"
import { checkUpgradeWhenSubscriptionReady, SDKProvider, useSDK } from "@tui/context/sdk"
import { ProjectProvider } from "@tui/context/project"
import { ServerProvider } from "@tui/context/server"
import { SyncProvider, useSync } from "@tui/context/sync"
import { RemoteSyncProvider, useRemoteSync } from "@tui/context/remote-sync"
import { AnalyticsProvider } from "@tui/context/analytics"
import { TelemetryProvider } from "@tui/context/telemetry"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogModel, useConnected } from "@tui/component/dialog-model"
import { DialogStatus } from "@tui/component/dialog-status"
import { DialogSync } from "@tui/component/dialog-sync"
import { DialogUsage } from "@tui/component/dialog-usage"
import { DialogThemeList } from "@tui/component/dialog-theme-list"
import { DialogSettings } from "@tui/component/dialog-settings"
import { DialogHelp } from "./ui/dialog-help"
import { DialogTour } from "@tui/component/dialog-tour"
import { DialogQuickstartInfo, DialogDoctorInfo, DialogSupport, openExternal } from "@tui/component/dialog-support"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { DialogPermissionMode } from "@tui/component/dialog-permission-mode"
import { DialogAdvisorModel } from "@tui/component/dialog-advisor-model"
import { DialogSessionList } from "@tui/component/dialog-session-list"
import { DialogSessionWarp } from "@tui/component/dialog-session-warp"
import { DialogWorkspaceList } from "@tui/component/dialog-workspace-list"
import { DialogVariant } from "@tui/component/dialog-variant"
import { KeybindProvider, useKeybind } from "@tui/context/keybind"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Home } from "@tui/routes/home"
import { Session } from "@tui/routes/session"
import { Workspace } from "@tui/routes/workspace"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { UpgradeProvider, useUpgrade } from "./context/upgrade"
import { AttentionProvider, useAttention } from "./context/attention"
import { SessionTabsProvider, useSessionTabs } from "./context/session-tabs"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { Usage } from "./util/usage"
import { SessionPrimitives } from "@nikcli-ai/util/session-primitives"
import { TuiEventName } from "@nikcli-ai/util/tui-event-schema"
import { KVProvider, useKV } from "./context/kv"
import { LanguageProvider } from "./context/language"
import { parseModel } from "@nikcli-ai/util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { writeHeapSnapshot } from "v8"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { EditorContextProvider } from "./context/editor"
import type { TuiConfig } from "@nikcli-ai/sdk/httpapi"
import { TuiPluginRuntime, createTuiApi, type RouteMap } from "./plugin"
import { setPluginHost, type TuiPluginHost } from "./plugin/host"
import { dbg as dbgApp } from "./feature-plugins/background/__debug"
import { BackgroundImage } from "./feature-plugins/background/view"
import { DevToolsBar } from "./feature-plugins/devtools/bar"
import { ErrorComponent } from "./component/error-component"
import { PluginRouteMissing } from "./component/plugin-route-missing"
import { PluginRouteBoundary } from "./component/plugin-route-boundary"
import { Reconnecting } from "./component/reconnecting"
import { StartupLoading } from "./component/startup-loading"
import { SessionTabs } from "./component/session-tabs"
import { DialogOnboarding } from "@tui/component/dialog-onboarding"
import { DialogLogin } from "@tui/component/dialog-login"
import { DialogAccountLogin } from "@tui/component/dialog-account-login"
import { DialogProfile } from "@tui/component/dialog-profile"
import { DialogAuthManage } from "@tui/component/dialog-auth-manage"
import { BRAIN_SESSION_TITLE } from "@nikcli-ai/util/brain-constants"
import { DialogWebPreview } from "@tui/component/dialog-web-preview"
import { SupportSessionProvider } from "@tui/context/support-session"
import type { StartServerOptions } from "@tui/context/server"
import {
  shouldUseRendererThread,
  win32DisableProcessedInput,
  win32InstallCtrlCGuard,
  restoreTerminalState,
} from "@nikcli-ai/util/win32"

function rendererConfig(tuiCfg: TuiConfig): CliRendererConfig {
  return {
    targetFps: 45,
    // OpenTUI's native output thread can lose its Windows console pipe when a
    // full-screen image makes frames large. Use the synchronous writer there;
    // Linux already makes the same choice inside OpenTUI.
    useThread: shouldUseRendererThread(),
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    useMouse: tuiCfg.mouse ?? true,
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      onCopySelection: (text) => {
        Clipboard.copy(text).catch((error) => {
          console.error(`Failed to copy console selection to clipboard: ${error}`)
        })
      },
    },
  }
}

import type { EventSource } from "./context/sdk"
import { Log } from "@nikcli-ai/util/log"
import { classifyConfigFailure } from "@tui/util/config-failure"
import { ensureOnboarded } from "@tui/util/onboarding"

/**
 * What an update check found.
 *
 * Mirrors the payload of `installation.update-available`, but reaches the TUI as the *return
 * value* of `checkUpgrade` rather than over the event stream: the check runs in the CLI process
 * (the upgrade replaces the installed binary, so it cannot run in the long-lived background
 * service) while the event stream comes from that service, and the Bus does not cross processes.
 */
export type UpdateAvailable = {
  version: string
  method?: InstallMethod
  current: string
}

const log = Log.create({ service: "tui.app" })

export function tui(input: {
  url: string
  args: Args
  directory?: string
  fetch?: typeof fetch
  events?: EventSource
  onExit?: () => Promise<void>
  onRestart?: () => Promise<void>
  checkUpgrade?: () => Promise<UpdateAvailable | undefined>
  upgradeNow?: (method: string, version: string) => Promise<void>
  startServer?: (options?: StartServerOptions) => Promise<string>
  /**
   * Config-surface operations the plugin runtime cannot perform itself.
   *
   * Required, not optional like the other host props: a terminal without it
   * cannot watch the config surface or install a plugin, and every entry point
   * that starts a TUI is a host file that can supply it.
   */
  pluginHost: TuiPluginHost
  /**
   * The merged TUI config, already read.
   *
   * A prop rather than a call, because of when it is needed: it feeds
   * `rendererConfig`, so it is consumed *before the renderer exists* — and at
   * that instant no transport does either. Over HTTP the call fails with
   * `ClientError: Transport`; over worker RPC it never settles at all, because
   * `Rpc.call` posts and waits with no timeout. The host reads it locally and
   * hands it over. Everything after the first frame uses `sdk.client.tui.config()`.
   */
  tuiConfig?: TuiConfig
}) {
  // promise to prevent immediate exit
  return new Promise<void>((resolve, reject) => {
    void (async () => {
      try {
        const unguard = win32InstallCtrlCGuard()
        win32DisableProcessedInput()
        // Read locally, and only here.
        //
        // This is the one config read that cannot go over the wire: it feeds `rendererConfig`,
        // so it happens before the renderer exists — and at that moment no transport does
        // either. An HTTP server has not been asked to listen yet, and the worker has not
        // installed its RPC `onmessage`, so a request here fails with `ClientError: Transport`
        // or, over worker RPC, never settles at all: `Rpc.call` posts and waits forever.
        // Everything after the first frame uses `sdk.client.tui.config()`.
        // Installed before anything can reach the plugin runtime.
        setPluginHost(input.pluginHost)

        const tuiCfg = input.tuiConfig ?? ({} as TuiConfig)
        const drive = Boolean(process.env.NIKCLI_DRIVE)
        const headless = drive && process.env.NIKCLI_DRIVE_RENDERER === "headless"
        // In drive mode the renderer must still be built from *this* package's
        // `@opentui/core`, so hand the simulation package our constructors: the
        // renderer's class identity is what `render(node, renderer)` below checks
        // to decide whether to reuse it instead of creating a second one.
        const renderer = drive
          ? await (
              await import("@nikcli-ai/simulation/frontend")
            ).Drive.create(rendererConfig(tuiCfg), {
              createCliRenderer,
              createTestRenderer: (await import("@opentui/core/testing")).createTestRenderer,
            })
          : await createCliRenderer(rendererConfig(tuiCfg))
        // Dozens of components subscribe to renderer events (`useTerminalDimensions`
        // alone is used in 32 files) and to key events (`useKeyboard`), all of which
        // unsubscribe on cleanup. That is well past EventEmitter's default cap of 10,
        // so without this bun prints a MaxListenersExceededWarning straight over the
        // first frame — once for the renderer, once for its key handler.
        renderer.setMaxListeners(200)
        renderer.keyInput.setMaxListeners(200)
        if (!headless) void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = headless ? "dark" : ((await (renderer as any).waitForThemeMode?.(1000)) ?? "dark")
        const onExit = async () => {
          unguard?.()
          await input.onExit?.()
          resolve()
        }

        await render(() => {
          return (
            <ErrorBoundary
              fallback={(error, reset) => <ErrorComponent error={error} reset={reset} onExit={onExit} mode={mode} />}
            >
              <ArgsProvider {...input.args}>
                <ExitProvider
                  onExit={onExit}
                  onBeforeExit={() => TuiPluginRuntime.dispose()}
                  onRestart={input.onRestart}
                >
                  <ServerProvider startServer={input.startServer}>
                    <KVProvider>
                      <ToastProvider>
                        <LanguageProvider>
                          <RouteProvider>
                            <SDKProvider
                              url={input.url}
                              directory={input.directory}
                              fetch={input.fetch}
                              events={input.events}
                            >
                              <SupportSessionProvider>
                                <ProjectProvider>
                                  <SyncProvider>
                                    <RemoteSyncProvider>
                                      <AnalyticsProvider>
                                        <TelemetryProvider>
                                          <ThemeProvider mode={mode}>
                                            <LocalProvider>
                                              <KeybindProvider>
                                                <PromptStashProvider>
                                                  <EditorContextProvider>
                                                    <DialogProvider>
                                                      <CommandProvider>
                                                        <FrecencyProvider>
                                                          <PromptHistoryProvider>
                                                            <PromptRefProvider>
                                                              <UpgradeProvider upgradeNow={input.upgradeNow}>
                                                                <AttentionProvider renderer={renderer}>
                                                                  <SessionTabsProvider>
                                                                    <App checkUpgrade={input.checkUpgrade} />
                                                                  </SessionTabsProvider>
                                                                </AttentionProvider>
                                                              </UpgradeProvider>
                                                            </PromptRefProvider>
                                                          </PromptHistoryProvider>
                                                        </FrecencyProvider>
                                                      </CommandProvider>
                                                    </DialogProvider>
                                                  </EditorContextProvider>
                                                </PromptStashProvider>
                                              </KeybindProvider>
                                            </LocalProvider>
                                          </ThemeProvider>
                                        </TelemetryProvider>
                                      </AnalyticsProvider>
                                    </RemoteSyncProvider>
                                  </SyncProvider>
                                </ProjectProvider>
                              </SupportSessionProvider>
                            </SDKProvider>
                          </RouteProvider>
                        </LanguageProvider>
                      </ToastProvider>
                    </KVProvider>
                  </ServerProvider>
                </ExitProvider>
              </ArgsProvider>
            </ErrorBoundary>
          )
        }, renderer)
      } catch (err) {
        reject(err)
      }
    })()
  })
}

function LegacyRedirect(props: {
  tab: "tree" | "changes" | "graph" | "github" | "actions"
  sessionID?: string
  workspaceID?: string
}) {
  const route = useRoute()
  onMount(() => {
    route.navigate({
      type: "workspace",
      tab: props.tab,
      sessionID: props.sessionID,
      workspaceID: props.workspaceID,
    })
  })
  return null
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function sessionIDFromRoute(route: ReturnType<typeof useRoute>["data"]) {
  return "sessionID" in route ? route.sessionID : undefined
}

function App(props: { checkUpgrade?: () => Promise<UpdateAvailable | undefined> }) {
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  renderer.externalOutputMode = "passthrough"
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const command = useCommandDialog()
  const sdk = useSDK()
  const toast = useToast()
  const themeCtx = useTheme()
  const upgradeCtx = useUpgrade()
  const { theme, mode, setMode } = themeCtx
  const sync = useSync()
  const tabs = useSessionTabs()
  const { exit, setSummary } = useExit()
  const promptRef = usePromptRef()
  const attention = useAttention()
  const keybind = useKeybind()

  /**
   * Offer the update the check found, and install it if the user agrees.
   *
   * Driven by `checkUpgrade`'s return value rather than by the `installation.update-available`
   * event: that event is published on the Bus of whichever process ran the check, and since the
   * background service became the default that process is this CLI — not the server the event
   * stream comes from, so the TUI never saw it. See `UpdateAvailable`.
   */
  async function offerUpdate(available: UpdateAvailable) {
    const { version, method } = available
    const currentVersion = available.current || VERSION

    // Skip version already dismissed by the user
    const skipped = kv.get("skipped_version")
    if (skipped && version === skipped) return

    const hint = method ? ` via ${method}` : ""
    const choice = await DialogConfirm.show(
      dialog,
      `Update Available`,
      `A new release v${version} is available. You have v${currentVersion}.\n\nInstall the update${hint} now?`,
      "confirm",
    )

    if (choice === false) {
      kv.set("skipped_version", version)
      return
    }

    if (!choice) return

    // No detected installation method (e.g. running from source / unknown
    // package manager). The TUI still shows the dialog so the user is
    // aware, but the actual install has to be triggered manually.
    if (!method) {
      await DialogAlert.show(
        dialog,
        "Update Available",
        `Version v${version} is available, but your install method (${VERSION === "local" ? "local build" : process.execPath}) could not be detected automatically.\n\nRun \`nikcli upgrade ${version}\` to install.`,
      )
      return
    }

    toast.show({
      variant: "info",
      message: `Updating to v${version}...`,
      duration: 30_000,
    })

    try {
      await upgradeCtx.upgradeNow?.(method, version)
    } catch (error) {
      // UpgradeFailedError carries the real reason in `stderr`; its `message` is empty, which
      // is what made this toast show a blank body for every failed update.
      //
      // Match on the name, not `instanceof`: the upgrade runs in the worker and the error
      // comes back over RPC as a plain `Error`, so the class check was always false and this
      // toast still said "Update failed". `Rpc` now carries the tagged error's own fields.
      const stderr = (error as { stderr?: unknown }).stderr
      const message =
        error instanceof Error && error.name === "UpgradeFailedError" && typeof stderr === "string"
          ? stderr
          : error instanceof Error
            ? error.message || (error.cause instanceof Error ? error.cause.message : "Update failed")
            : "Update failed"
      toast.show({
        variant: "error",
        title: "Update Failed",
        message,
        duration: 10_000,
      })
      return
    }

    await DialogAlert.show(
      dialog,
      "Update Complete",
      `Successfully updated to v${version}. Please restart the application.`,
    )

    await exit()
  }

  // Plugin routes — mutable map + reactive stamp for re-renders
  const routes: RouteMap = new Map()
  const [pluginRouteKey, setPluginRouteKey] = createSignal(0)
  const bump = () => setPluginRouteKey((k) => k + 1)
  const [pluginsReady, setPluginsReady] = createSignal(false)

  const [onboardingActive, setOnboardingActive] = createSignal(false)

  setSummary(() => {
    const sessionID = sessionIDFromRoute(route.data)
    if (!sessionID) return
    const session = sync.session.get(sessionID)
    const messages = sync.data.message[sessionID] ?? []
    const usage = Usage.fromMessages(messages, sync.data.provider)
    const totals = messages.reduce(
      (acc, message) => {
        if (message.role !== "assistant") return acc
        const tokens =
          message.tokens.total && message.tokens.total > 0
            ? message.tokens.total
            : message.tokens.input +
              message.tokens.output +
              message.tokens.reasoning +
              message.tokens.cache.read +
              message.tokens.cache.write
        acc.tokens += tokens
        acc.input += message.tokens.input
        acc.output += message.tokens.output
        acc.reasoning += message.tokens.reasoning
        acc.cost += message.cost
        return acc
      },
      { tokens: 0, input: 0, output: 0, reasoning: 0, cost: 0 },
    )
    const title =
      session?.title && !SessionPrimitives.isDefaultTitle(session.title) ? session.title : "Untitled session"
    const duration = session ? formatDuration(Date.now() - session.time.created) : undefined
    const context = usage.model?.contextLimit
      ? `${Usage.formatTokens(usage.tokens)} / ${Usage.formatTokens(usage.model.contextLimit)} (${Usage.formatPct(usage.tokens, usage.model.contextLimit)})`
      : Usage.formatTokens(usage.tokens)
    const model = usage.model ? `${usage.model.providerID}/${usage.model.modelID}` : "—"
    const resume = `nikcli --session ${sessionID}`

    const asciiLogo = `
███╗   ██╗██╗██╗  ██╗ ██████╗██╗     ██╗
████╗  ██║██║██║ ██╔╝██╔════╝██║     ██║
██╔██╗ ██║██║█████╔╝ ██║     ██║     ██║
██║╚██╗██║██║██╔═██╗ ██║     ██║     ██║
██║ ╚████║██║██║  ██╗╚██████╗███████╗██║
╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝`

    return [
      `${asciiLogo}`,
      "",
      `  Session  ${title}`,
      `  Resume   ${resume}`,
      duration ? `  Time     ${duration}` : undefined,
      `  Model    ${model}`,
      totals.tokens > 0
        ? `  Tokens   ${Usage.formatTokens(totals.tokens)} total (${Usage.formatTokens(totals.input)} in, ${Usage.formatTokens(totals.output)} out${totals.reasoning > 0 ? `, ${Usage.formatTokens(totals.reasoning)} reasoning` : ""})`
        : undefined,
      `  Context  ${context}`,
      totals.cost > 0 ? `  Cost     ${money.format(totals.cost)}` : undefined,
      "\n",
    ]
      .filter(Boolean)
      .join("\n")
  })

  onMount(() => {
    void (async () => {
      // Drive instances use an injected local provider and must not depend on
      // interactive account/onboarding state from the host machine.
      //
      // The session is asked for now, alongside `hasUsers`, and nothing before
      // the plugins waits for it: onboarding never read it. Answering it can
      // mean renewing and verifying the issuer token over the network — a
      // second or more on every launch after the token's quarter hour — and a
      // returning user's plugins, config and prompt have no use for the answer.
      // What it decides (the sign-in dialog) is applied once they are up.
      let returningAccount: Promise<Awaited<ReturnType<typeof UserApi.session>>> | undefined
      if (!process.env.NIKCLI_DRIVE) {
        // Account state comes from `/user/*` — the transport is up by now, as
        // the `sdk.client.tui.config` call a few lines below has always relied on.
        const accountRequest = UserApi.session(sdk)
        // A first run never awaits it; a returning one does, below, and sees any failure there.
        accountRequest.catch(() => {})

        // `null` means the question could not be asked. Treating that as "no
        // users" would restart onboarding for someone who already has an
        // account, so only an explicit `false` counts as first run.
        const isFirstRun = (await UserApi.hasUsers(sdk)) === false

        if (isFirstRun && !kv.get("onboarding_complete", false)) {
          // First-time user: unified onboarding handles account creation + provider setup
          setOnboardingActive(true)
          const outcome = await ensureOnboarded({
            runOnboarding: () => DialogOnboarding.run(dialog),
            currentUser: () => UserApi.me(sdk),
            onAttemptFailed: (attempt) =>
              log.warn("onboarding closed without an account", {
                attempt,
                service: "tui.onboarding",
              }),
          })
          setOnboardingActive(false)
          if (outcome.status === "complete") {
            kv.set("onboarding_complete", true)
            const needsProvider = untrack(() => sync.status === "complete" && sync.data.provider.length === 0)
            if (needsProvider && dialog.stack.length === 0) {
              dialog.replace(() => <DialogProviderList />)
            }
          } else {
            // Not signed in, and startup must not pretend otherwise: the flag
            // stays unset so the next launch asks again. It also must not park
            // here — the config load and renderer wiring below never ran while
            // this loop spun, which left the user with a frozen screen and no
            // reason for it. Say what happened and let startup finish.
            log.error("onboarding did not produce an account", {
              attempts: outcome.attempts,
            })
            toast.show({
              message: "Account setup didn't complete — run /signin to finish signing in.",
              variant: "error",
            })
          }
        } else {
          returningAccount = accountRequest
        }
      }

      // The renderer already owns the terminal here, so a config failure must
      // not take the TUI down the way it does in the standalone host. It must
      // still not pass for an empty config: say which of the three it was.
      const configResult = await sdk.client.tui.config().catch((error: unknown) => ({ data: undefined, error }))
      if (configResult.error !== undefined) {
        const status = (configResult as { response?: { status: number } }).response?.status
        log.error("tui config unavailable; starting on defaults", {
          reason: classifyConfigFailure(configResult.error, status),
          status,
        })
      }
      const tuiConfig = (configResult.data ?? {}) as TuiConfig
      const api = createTuiApi({
        command,
        tuiConfig,
        dialog,
        keybind,
        kv,
        route,
        routes,
        bump,
        sdk,
        sync,
        theme: themeCtx,
        toast,
        tabs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer: renderer as any,
      })
      dbgApp("before init")
      await TuiPluginRuntime.init(api)
      dbgApp("after init")
      // Register the global sync dialog keybind (default: <leader>y).
      // Uses the same command-dialog plumbing as the slash command
      // /sync so a single source of truth drives both entry points.
      api.keymap.registerLayer({
        commands: [
          {
            name: "sync.open",
            title: "Sync status",
            namespace: "System",
            run() {
              dialog.replace(() => <DialogSync />)
            },
          },
        ],
        bindings: [{ key: "sync_view", cmd: "sync.open" }],
      })
      setPluginsReady(true)

      // Three answers, and only one of them is a reason to interrupt. The
      // server is asked whether this machine holds a session; while it is
      // still booting — or being restarted by an auto-update — it cannot
      // answer, and reading that silence as "signed out" is what put the
      // sign-in dialog in front of someone who had never signed out.
      const account = await returningAccount
      if (account?.status === "signed-out") {
        // Returning user with no active session: standard login
        await DialogLogin.run(dialog, sdk)
      } else if (account?.status === "unknown") {
        log.warn("could not read the account session at startup; not prompting", {
          service: "tui.account",
        })
      }
    })().catch((error) => {
      dbgApp("init chain error", () => String(error))
      setOnboardingActive(false)
      setPluginsReady(true)
      toast.error(error)
    })
  })

  onCleanup(() => {
    void TuiPluginRuntime.dispose()
    restoreTerminalState()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)
    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))

  // Update terminal window title based on current route and session
  createEffect(
    on(
      () => ({
        enabled: terminalTitleEnabled(),
        type: route.data.type,
        sessionID:
          route.data.type === "session" || route.data.type === "changes" || route.data.type === "tree"
            ? ((route.data as any).sessionID ?? null)
            : null,
        title:
          route.data.type === "github"
            ? "GitHub"
            : route.data.type === "session" || route.data.type === "changes" || route.data.type === "tree"
              ? (route.data as any).sessionID
                ? (sync.session.get((route.data as any).sessionID)?.title ?? null)
                : null
              : null,
      }),
      (state) => {
        if (!state.enabled || Flag.NIKCLI_DISABLE_TERMINAL_TITLE) {
          renderer.setTerminalTitle("")
          return
        }

        if (state.type === "home") {
          renderer.setTerminalTitle("Nikcli")
          return
        }

        if (state.type === "session" && state.sessionID) {
          if (!state.title || SessionPrimitives.isDefaultTitle(state.title)) {
            renderer.setTerminalTitle("Nikcli")
            return
          }
          const title = state.title.length > 40 ? state.title.slice(0, 37) + "..." : state.title
          renderer.setTerminalTitle(`Nikcli | ${title}`)
          return
        }

        if (state.type === "git-graph" || state.type === "github") {
          renderer.setTerminalTitle("Nikcli | GitHub")
          return
        }

        if (state.type === "workspace") {
          renderer.setTerminalTitle("Nikcli | Workspace")
          return
        }
      },
      { defer: true },
    ),
  )

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = parseModel(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
          workspaceID: sync.session.get(args.sessionID)?.workspaceID,
        })
      }
    })
  })

  let continued = false
  createEffect(
    on(
      () => [continued, sync.status, args.continue],
      () => {
        if (continued || sync.status === "loading" || !args.continue) return
        const match = sync.data.session
          .toSorted((a, b) => b.time.updated - a.time.updated)
          .find((x) => x.parentID === undefined)?.id
        if (match) {
          continued = true
          route.navigate({
            type: "session",
            sessionID: match,
            workspaceID: sync.session.get(match)?.workspaceID,
          })
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        if (onboardingActive()) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  const connected = useConnected()
  command.register(() => [
    {
      title: "Take the 6-step tour",
      value: "support.tour",
      category: "Support",
      suggested: sync.data.session.length < 3,
      slash: { name: "tour" },
      onSelect: () => {
        dialog.replace(() => <DialogTour />)
      },
    },
    {
      title: "Show help",
      value: "support.help",
      category: "Support",
      slash: { name: "help" },
      onSelect: () => {
        dialog.replace(() => <DialogHelp />)
      },
    },
    {
      title: "Run the interactive quickstart",
      value: "support.quickstart",
      category: "Support",
      slash: { name: "quickstart", aliases: ["get-started"] },
      onSelect: () => {
        dialog.replace(() => <DialogQuickstartInfo />)
      },
    },
    {
      title: "Run nikcli doctor",
      value: "support.doctor",
      category: "Support",
      slash: { name: "doctor" },
      onSelect: () => {
        dialog.replace(() => <DialogDoctorInfo />)
      },
    },
    {
      title: "Open the docs",
      value: "support.docs",
      category: "Support",
      slash: { name: "docs" },
      onSelect: () => {
        openExternal("https://nikcli-ai.dev/docs")
      },
    },
    {
      title: "Chat with the support assistant",
      value: "support.chat",
      category: "Support",
      suggested: true,
      keybind: "app_support",
      slash: { name: "support", aliases: ["ask", "help-me"] },
      onSelect: () => {
        dialog.replace(() => <DialogSupport />)
      },
    },
    {
      title: "Switch session",
      value: "session.list",
      keybind: "session_list",
      category: "Session",
      suggested: sync.data.session.length > 0,
      slash: {
        name: "sessions",
        aliases: ["resume", "continue"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogSessionList />)
      },
    },
    {
      title: "Manage workspaces",
      value: "workspace.list",
      category: "Workspace",
      suggested: true,
      slash: {
        name: "workspaces",
      },
      onSelect: () => {
        dialog.replace(() => <DialogWorkspaceList />)
      },
    },
    {
      title: "Warp session",
      value: "workspace.warp",
      category: "Workspace",
      enabled: route.data.type === "session" && Flag.NIKCLI_EXPERIMENTAL_WORKSPACES_TUI,
      slash: {
        name: "warp",
      },
      onSelect: () => {
        const data = route.data
        if (data.type !== "session") return
        const sessionID = data.sessionID
        dialog.replace(() => <DialogSessionWarp sessionID={sessionID} />)
      },
    },
    {
      title: "New session",
      suggested: route.data.type === "session",
      value: "session.new",
      keybind: "session_new",
      category: "Session",
      slash: {
        name: "new",
        aliases: ["clear"],
      },
      onSelect: () => {
        const current = promptRef.current
        // Don't require focus - if there's any text, preserve it
        const currentPrompt = current?.current?.input ? current.current : undefined
        const workspaceID =
          route.data.type === "session"
            ? (route.data.workspaceID ?? sync.session.get(route.data.sessionID)?.workspaceID)
            : route.data.workspaceID
        route.navigate({
          type: "home",
          initialPrompt: currentPrompt,
          workspaceID,
        })
        dialog.clear()
      },
    },
    {
      title: "Workspace panel (sessions · changes · graph · github · actions)",
      value: "workspace.open",
      category: "Git",
      suggested: true,
      slash: {
        name: "workspace",
        aliases: ["ws", "panel"],
      },
      onSelect: () => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        const hasDiff = route.data.type === "session" && (sync.data.session_diff[route.data.sessionID]?.length ?? 0) > 0
        route.navigate({
          type: "workspace",
          tab: hasDiff ? "changes" : "tree",
          sessionID,
          workspaceID: sessionID
            ? (route.data.workspaceID ?? sync.session.get(sessionID)?.workspaceID)
            : route.data.workspaceID,
        })
        dialog.clear()
      },
    },
    // Hidden helpers so existing /changes /tree /graph /github slash commands still work
    // but don't clutter the command palette suggestion list.
    {
      title: "Open changes tab",
      value: "workspace.tab.changes",
      category: "Git",
      hidden: true,
      slash: { name: "changes" },
      onSelect: () => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        route.navigate({
          type: "workspace",
          tab: "changes",
          sessionID,
          workspaceID: sessionID
            ? (route.data.workspaceID ?? sync.session.get(sessionID)?.workspaceID)
            : route.data.workspaceID,
        })
        dialog.clear()
      },
    },
    {
      title: "Open sessions tab",
      value: "workspace.tab.tree",
      category: "Git",
      hidden: true,
      slash: { name: "tree" },
      onSelect: () => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        route.navigate({
          type: "workspace",
          tab: "tree",
          sessionID,
          workspaceID: sessionID
            ? (route.data.workspaceID ?? sync.session.get(sessionID)?.workspaceID)
            : route.data.workspaceID,
        })
        dialog.clear()
      },
    },
    {
      title: "Open commit graph tab",
      value: "workspace.tab.graph",
      category: "Git",
      hidden: true,
      slash: { name: "graph", aliases: ["gitgraph", "commits"] },
      onSelect: () => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        route.navigate({
          type: "workspace",
          tab: "graph",
          sessionID,
          workspaceID: sessionID
            ? (route.data.workspaceID ?? sync.session.get(sessionID)?.workspaceID)
            : route.data.workspaceID,
        })
        dialog.clear()
      },
    },
    {
      title: "Open GitHub tab",
      value: "workspace.tab.github",
      category: "Git",
      hidden: true,
      slash: { name: "github", aliases: ["gh"] },
      onSelect: () => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        route.navigate({
          type: "workspace",
          tab: "github",
          sessionID,
          workspaceID: sessionID
            ? (route.data.workspaceID ?? sync.session.get(sessionID)?.workspaceID)
            : route.data.workspaceID,
        })
        dialog.clear()
      },
    },
    {
      title: "Open CI actions tab",
      value: "workspace.tab.actions",
      category: "Git",
      hidden: true,
      slash: { name: "actions", aliases: ["ci", "workflows"] },
      onSelect: () => {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        route.navigate({
          type: "workspace",
          tab: "actions",
          sessionID,
          workspaceID: sessionID
            ? (route.data.workspaceID ?? sync.session.get(sessionID)?.workspaceID)
            : route.data.workspaceID,
        })
        dialog.clear()
      },
    },
    {
      title: "Switch model",
      value: "model.list",
      keybind: "model_list",
      suggested: true,
      category: "Agent",
      slash: {
        name: "models",
      },
      onSelect: () => {
        dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: "Model cycle",
      value: "model.cycle_recent",
      keybind: "model_cycle_recent",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycle(1)
      },
    },
    {
      title: "Model cycle reverse",
      value: "model.cycle_recent_reverse",
      keybind: "model_cycle_recent_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycle(-1)
      },
    },
    {
      title: "Favorite cycle",
      value: "model.cycle_favorite",
      keybind: "model_cycle_favorite",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(1)
      },
    },
    {
      title: "Favorite cycle reverse",
      value: "model.cycle_favorite_reverse",
      keybind: "model_cycle_favorite_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(-1)
      },
    },
    {
      title: "Switch agent",
      value: "agent.list",
      keybind: "agent_list",
      category: "Agent",
      slash: {
        name: "agents",
      },
      onSelect: () => {
        // Lazy: picking an agent is not on the path to the first frame, and this
        // dialog is among the most expensive of the eager component imports.
        // See `script/import-cost.ts` for the measurement.
        void import("@tui/component/dialog-agent").then(({ DialogAgent }) => {
          dialog.replace(() => <DialogAgent />)
        })
      },
    },
    {
      title: "Permission mode",
      value: "permission.mode",
      keybind: "permission_mode",
      category: "Agent",
      slash: {
        name: "permissions",
        aliases: ["permission"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogPermissionMode />)
      },
    },
    {
      title: "Set advisor model",
      value: "agent.advisor",
      category: "Agent",
      slash: {
        name: "advisor",
      },
      onSelect: () => {
        const name = local.agent.current()?.name
        if (!name) return
        dialog.replace(() => <DialogAdvisorModel agentName={name} />)
      },
    },
    {
      title: "Browse skills",
      value: "skill.list",
      category: "Agent",
      slash: {
        name: "skills",
      },
      onSelect: () => {
        void import("@tui/component/dialog-skills").then(({ DialogSkills }) => dialog.replace(() => <DialogSkills />))
      },
    },
    {
      title: "Toggle MCPs",
      value: "mcp.list",
      category: "Agent",
      slash: {
        name: "mcps",
      },
      onSelect: () => {
        // Lazy: inspecting mcp servers is not on the path to the first frame, and this
        // dialog is among the most expensive of the eager component imports.
        // See `script/import-cost.ts` for the measurement.
        void import("@tui/component/dialog-mcp").then(({ DialogMcp }) => {
          dialog.replace(() => <DialogMcp />)
        })
      },
    },
    {
      title: "Routines",
      value: "routine.list",
      category: "System",
      slash: {
        name: "routines",
        aliases: ["routine"],
      },
      onSelect: () => {
        // Lazy: managing routines is not on the path to the first frame, and this
        // dialog is among the most expensive of the eager component imports.
        // See `script/import-cost.ts` for the measurement.
        void import("@tui/component/dialog-routine").then(({ DialogRoutine }) => {
          dialog.replace(() => <DialogRoutine />)
        })
      },
    },
    {
      title: "Agent cycle",
      value: "agent.cycle",
      keybind: "agent_cycle",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.agent.move(1)
      },
    },
    {
      title: "Variant cycle",
      value: "variant.cycle",
      keybind: "variant_cycle",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.model.variant.cycle()
      },
    },
    {
      title: "Select variant",
      value: "variant.select",
      category: "Agent",
      onSelect: () => {
        dialog.replace(() => <DialogVariant />)
      },
    },
    {
      title: "Agent cycle reverse",
      value: "agent.cycle.reverse",
      keybind: "agent_cycle_reverse",
      category: "Agent",
      hidden: true,
      onSelect: () => {
        local.agent.move(-1)
      },
    },
    {
      title: "Connect provider",
      value: "provider.connect",
      suggested: !connected(),
      slash: {
        name: "connect",
      },
      onSelect: () => {
        dialog.replace(() => <DialogProviderList />)
      },
      category: "Provider",
    },
    {
      title: "Disconnect provider",
      value: "provider.disconnect",
      suggested: sync.data.provider_next.connected.length > 0,
      enabled: sync.data.provider_next.connected.length > 0,
      slash: {
        name: "disconnect",
      },
      onSelect: () => {
        dialog.replace(() => <DialogProviderDisconnect />)
      },
      category: "Provider",
    },
    {
      title: "Sign in to nikcli",
      value: "account.login",
      category: "Account",
      slash: {
        name: "signin",
        aliases: ["account-login"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogAccountLogin />)
      },
    },
    {
      title: "Personalize nikcli",
      value: "account.profile",
      category: "Account",
      slash: {
        name: "profile",
        aliases: ["me", "personalize"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogProfile />)
      },
    },
    {
      title: "Manage Account",
      value: "auth.manage",
      category: "Account",
      slash: {
        name: "auth",
        aliases: ["account"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogAuthManage />)
      },
    },
    {
      title: "Settings",
      value: "settings.open",
      slash: { name: "settings" },
      onSelect: () => {
        dialog.replace(() => <DialogSettings />)
      },
      category: "System",
    },
    {
      title: "Edit config",
      value: "config.edit",
      slash: { name: "config" },
      onSelect: () => {
        // Lazy: editing config is not on the path to the first frame, and this
        // dialog is among the most expensive of the eager component imports.
        // See `script/import-cost.ts` for the measurement.
        void import("@tui/component/dialog-config").then(({ DialogConfig }) => {
          dialog.replace(() => <DialogConfig />)
        })
      },
      category: "System",
    },
    {
      title: "Web preview",
      value: "web.preview",
      category: "Tools",
      slash: {
        name: "preview",
        aliases: ["browse", "web"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogWebPreview />)
      },
    },
    {
      title: "View status",
      keybind: "status_view",
      value: "nikcli.status",
      slash: {
        name: "status",
      },
      onSelect: () => {
        dialog.replace(() => <DialogStatus />)
      },
      category: "System",
    },
    {
      title: "Connect mobile app",
      value: "mobile.connect",
      category: "Remote",
      suggested: true,
      slash: {
        name: "mobile",
        aliases: ["link"],
      },
      onSelect: () => {
        // Lazy: pairing a phone is not on the path to the first frame, and this
        // dialog's chain is the most expensive of the eager component imports.
        // See `script/import-cost.ts` for the measurement.
        const sessionID = sessionIDFromRoute(route.data)
        void import("@tui/component/dialog-mobile-connect").then(({ DialogMobileConnect }) => {
          dialog.replace(() => <DialogMobileConnect sessionID={sessionID} />)
        })
      },
    },
    {
      title: "Sync status",
      keybind: "sync_view",
      value: "nikcli.sync",
      slash: {
        name: "sync",
        aliases: ["hub", "remote"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogSync />)
      },
      category: "System",
    },
    {
      title: "Context usage",
      value: "nikcli.usage",
      slash: {
        name: "usage",
        aliases: ["context"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogUsage />)
      },
      category: "Session",
    },
    {
      title: "Analytics",
      value: "analytics.view",
      slash: {
        name: "analytics",
        aliases: ["stats"],
      },
      onSelect: () => {
        void import("@tui/component/dialog-analytics").then(({ DialogAnalytics }) =>
          dialog.replace(() => <DialogAnalytics onClose={() => dialog.clear()} />),
        )
      },
      category: "Session",
    },
    {
      title: "Command center",
      value: "nikcli.dashboard",
      slash: {
        name: "dashboard",
        aliases: ["ops", "command-center"],
      },
      onSelect: () => {
        void import("@tui/component/dialog-command-center").then(({ DialogCommandCenter }) =>
          dialog.replace(() => <DialogCommandCenter />),
        )
      },
      category: "Session",
    },
    {
      title: "Switch theme",
      value: "theme.switch",
      keybind: "theme_list",
      slash: {
        name: "themes",
      },
      onSelect: () => {
        dialog.replace(() => <DialogThemeList />)
      },
      category: "System",
    },
    {
      title: "Toggle appearance",
      value: "theme.switch_mode",
      onSelect: (dialog) => {
        setMode(mode() === "dark" ? "light" : "dark")
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Help",
      value: "help.show",
      slash: {
        name: "help",
      },
      onSelect: () => {
        dialog.replace(() => <DialogHelp />)
      },
      category: "System",
    },
    {
      title: "Open docs",
      value: "docs.open",
      onSelect: () => {
        open("https://nikcli-ai.dev/docs").catch(() => {})
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Open WebUI",
      value: "webui.open",
      onSelect: () => {
        open(sdk.url).catch(() => {})
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Exit the app",
      value: "app.exit",
      slash: {
        name: "exit",
        aliases: ["quit", "q"],
      },
      onSelect: () => exit(),
      category: "System",
    },
    {
      title: "Toggle debug panel",
      category: "System",
      value: "app.debug",
      onSelect: (dialog) => {
        renderer.toggleDebugOverlay()
        dialog.clear()
      },
    },
    {
      title: "Toggle console",
      category: "System",
      value: "app.console",
      onSelect: (dialog) => {
        renderer.console.toggle()
        dialog.clear()
      },
    },
    {
      title: "Write heap snapshot",
      category: "System",
      value: "app.heap_snapshot",
      onSelect: (dialog) => {
        const path = writeHeapSnapshot()
        toast.show({
          variant: "info",
          message: `Heap snapshot written to ${path}`,
          duration: 5000,
        })
        dialog.clear()
      },
    },
    {
      title: "Suspend terminal",
      value: "terminal.suspend",
      keybind: "terminal_suspend",
      category: "System",
      hidden: true,
      onSelect: () => {
        const handler = () => {
          renderer.resume()
        }
        process.once("SIGCONT", handler)

        renderer.suspend()
        process.kill(0, "SIGTSTP")
      },
    },
    {
      title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
      value: "terminal.title.toggle",
      keybind: "terminal_title_toggle",
      category: "System",
      onSelect: (dialog) => {
        setTerminalTitleEnabled((prev) => {
          const next = !prev
          kv.set("terminal_title_enabled", next)
          if (!next) renderer.setTerminalTitle("")
          return next
        })
        dialog.clear()
      },
    },
  ])

  createEffect(
    on(
      () => local.model.current(),
      (currentModel) => {
        if (!currentModel) return
        if (currentModel.providerID === "openrouter" && !kv.get("openrouter_warning", false)) {
          untrack(() => {
            DialogAlert.show(
              dialog,
              "Warning",
              "While openrouter is a convenient way to access LLMs your request will often be routed to subpar providers that do not work well in our testing.\n\nFor reliable access to models check out Nikcli Zen\nhttps://nikcli-ai.dev/zen",
            ).then(() => kv.set("openrouter_warning", true))
          })
        }
      },
      { defer: true },
    ),
  )

  onMount(() => {
    const refocusPrompt = () => {
      if (route.data.type !== "session" && route.data.type !== "home") return
      const ref = promptRef.current
      if (ref && !ref.focused) ref.focus()
    }
    renderer.on("focus", refocusPrompt)

    const unsubs = [
      sdk.event.on(TuiEventName.commandExecute, (evt) => {
        command.trigger(evt.properties.command)
      }),
      sdk.event.on(TuiEventName.toastShow, (evt) => {
        toast.show({
          title: evt.properties.title,
          message: evt.properties.message,
          variant: evt.properties.variant,
          duration: evt.properties.duration,
        })
      }),
      sdk.event.on("monitor.completed", (evt) => {
        const variant =
          evt.properties.status === "complete" ? "success" : evt.properties.status === "cancelled" ? "info" : "error"
        const exit = evt.properties.exitCode
        const suffix = exit === null ? "" : ` (exit ${exit})`
        toast.show({
          message: `${evt.properties.title} ${evt.properties.status}${suffix}`,
          variant,
          duration: evt.properties.status === "complete" ? 3500 : 5000,
        })
      }),
      sdk.event.on(TuiEventName.sessionSelect, (evt) => {
        route.navigate({
          type: "session",
          sessionID: evt.properties.sessionID,
          workspaceID: sync.session.get(evt.properties.sessionID)?.workspaceID,
        })
      }),
      sdk.event.on(SessionPrimitives.EventName.deleted, (evt) => {
        const deletedSessionID = evt.properties.info.id
        const currentSessionID =
          route.data.type === "session" || route.data.type === "changes" || route.data.type === "tree"
            ? route.data.sessionID
            : undefined
        if (currentSessionID === deletedSessionID) {
          route.navigate({
            type: "home",
            workspaceID: evt.properties.info.workspaceID,
          })
          toast.show({
            variant: "info",
            message: "The current session was deleted",
          })
        }
      }),
      sdk.event.on(SessionPrimitives.EventName.error, (evt) => {
        const error = evt.properties.error
        if (error && typeof error === "object" && error.name === "MessageAbortedError") return
        const sessionID = evt.properties.sessionID
        const currentSession = route.data.type === "session" ? route.data.sessionID : undefined
        const session = sessionID ? sync.session.get(sessionID) : undefined
        if (session?.title === BRAIN_SESSION_TITLE && currentSession !== sessionID) return
        const message = (() => {
          if (!error) return "An error occurred"

          if (typeof error === "object") {
            const data = error.data
            if ("message" in data && typeof data.message === "string") {
              return data.message
            }
          }
          return String(error)
        })()

        toast.show({
          variant: "error",
          message,
          duration: 5000,
        })
      }),
      sdk.event.on("permission.blocked", (evt) => {
        toast.show({
          message: `${evt.properties.permission} denied by auto mode · [${evt.properties.rule}] · ${keybind.print("permission_mode")} to review`,
          variant: "warning",
          duration: 5000,
        })
      }),
      sdk.event.on("permission.asked", () => {
        const tuiCfg = sync.data.config?.tui as { sound?: boolean } | undefined
        if (tuiCfg?.sound === false) return
        if (attention.focus() === "focused") return
        Sound.pulse(1.3)
      }),
      sdk.event.on("session.idle", () => {
        const tuiCfg = sync.data.config?.tui as { sound?: boolean } | undefined
        if (tuiCfg?.sound === false) return
        if (attention.focus() === "focused") return
        Sound.pulse(0.8)
      }),
    ]

    void checkUpgradeWhenSubscriptionReady(sdk.subscriptionReady, props.checkUpgrade)
      .then((available) => (available ? offerUpdate(available) : undefined))
      .catch(() => undefined)

    onCleanup(() => {
      renderer.off("focus", refocusPrompt)
      unsubs.forEach((fn) => fn())
      Sound.dispose()
    })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.surface.base}
      onMouseUp={async () => {
        if (Flag.NIKCLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) {
          renderer.clearSelection()
          return
        }
        const text = renderer.getSelection()?.getSelectedText()
        if (text && text.length > 0) {
          await Clipboard.copy(text)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
          renderer.clearSelection()
        }
      }}
    >
      {/*
        Keep the wallpaper first in logical child order as well as at z-index
        -1. The image appears asynchronously; this gives Solid an anchor before
        the UI when it inserts the renderable and avoids a foreground frame.
      */}
      <BackgroundImage />
      <Show when={route.data.type === "home" || route.data.type === "session"}>
        <SessionTabs />
      </Show>
      <box flexGrow={1} minHeight={0} width="100%">
        <Switch>
          <Match when={route.data.type === "home"}>
            <Home />
          </Match>
          <Match when={route.data.type === "session"}>
            <Session />
          </Match>
          <Match when={route.data.type === "changes" && route.data}>
            {(data) => <LegacyRedirect tab="changes" sessionID={data().sessionID} workspaceID={data().workspaceID} />}
          </Match>
          <Match when={route.data.type === "tree" && route.data}>
            {(data) => <LegacyRedirect tab="tree" sessionID={data().sessionID} workspaceID={data().workspaceID} />}
          </Match>
          <Match when={route.data.type === "git-graph" && route.data}>
            {(data) => <LegacyRedirect tab="graph" sessionID={data().sessionID} workspaceID={data().workspaceID} />}
          </Match>
          <Match when={route.data.type === "github" && route.data}>
            {(data) => <LegacyRedirect tab="github" sessionID={data().sessionID} workspaceID={data().workspaceID} />}
          </Match>
          <Match when={route.data.type === "actions" && route.data}>
            {(data) => <LegacyRedirect tab="actions" sessionID={data().sessionID} workspaceID={data().workspaceID} />}
          </Match>
          <Match when={route.data.type === "workspace"}>
            <Workspace />
          </Match>
          <Match when={route.data.type === "plugin" && route.data}>
            {(data) => (
              // Keyed so navigating to another plugin route, or a hot reload of
              // the plugin, recreates the boundary; otherwise one crash would
              // latch every future plugin route into the fallback.
              <Show keyed when={{ id: data().id, generation: pluginRouteKey() }}>
                {(current) => (
                  <PluginRouteBoundary id={current.id}>
                    {(() => {
                      const last = routes.get(current.id)?.at(-1)
                      return last ? (
                        last.render({ params: data().data })
                      ) : (
                        <PluginRouteMissing id={current.id} onHome={() => route.navigate({ type: "home" })} />
                      )
                    })()}
                  </PluginRouteBoundary>
                )}
              </Show>
            )}
          </Match>
        </Switch>
      </box>
      <box flexShrink={0}>
        <TuiPluginRuntime.Slot name="app.bottom" />
      </box>
      {/*
        Mounted here rather than through a slot, like BackgroundImage above: a
        slot would put a SlotRenderable between the bar and the layout, and the
        one thing this component must not do is add to the cost it reports.
        Renders nothing at all until `/devtools` turns it on.
      */}
      <DevToolsBar />
      <TuiPluginRuntime.Slot name="app" />
      <StartupLoading ready={pluginsReady} />
      <Show when={sdk.connection.status() === "reconnecting"}>
        <Reconnecting attempt={sdk.connection.attempt()} error={sdk.connection.error()} />
      </Show>
    </box>
  )
}
