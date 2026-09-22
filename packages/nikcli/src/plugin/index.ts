import type { Hooks, PluginInput, Plugin as PluginInstance } from "@nikcli-ai/plugin"
import { createNikcliClient } from "@nikcli-ai/sdk/httpapi"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { EventError } from "../session/event-error"
import { errorMessage } from "@nikcli-ai/util/error-format"
import { retry } from "@nikcli-ai/util/retry"
import { Bus } from "../bus"
import { BunProc } from "../bun"
import { Config } from "../config/config"
import { resolveCredential } from "../connectors/credentials"
import { Flag } from "@nikcli-ai/util/flag"
import { Installation } from "../installation"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { Log } from "@nikcli-ai/util/log"
import { AsyncQueue } from "../util/queue"
import { withTimeout } from "../util/timeout"
import { CodexAuthPlugin } from "./codex"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { XAIAuthPlugin } from "./xai"
import { CursorAuthPlugin } from "./cursor"
import {
  readV1Plugin,
  readPluginId,
  resolvePluginId,
  pluginSource,
  isDeprecatedPlugin,
} from "@nikcli-ai/util/plugin-shared"
import type { PluginModule } from "@nikcli-ai/plugin"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { HerdrPlugin } from "./herdr"
import { Context, Effect, Layer } from "effect"
import { InstanceState, locallyInstance, runPromiseWithLayer, type InstanceContext } from "@/effect"

type NotifyChannel = "macos" | "slack" | "discord"
type NotifyPriority = "low" | "normal" | "high" | "critical"
type NotifyEventKey = "sessionIdle" | "sessionError" | "permissionAsked" | "questionAsked"

type NotifyJob = {
  title: string
  body: string
  priority: NotifyPriority
  source: string
  sessionID?: string
}

type MacIcon = {
  value: string
  remote: boolean
}

type PermissionAsked = {
  sessionID: string
  permission: string
  patterns?: string[]
}

type QuestionAsked = {
  sessionID: string
  questions?: Array<{ header: string; question: string }>
}

type SessionErrorEvent = {
  sessionID?: string
  error?: { name?: string; data?: { message?: string } }
}

type SessionStatusEvent = {
  sessionID: string
  status: {
    type: "idle" | "busy" | "retry"
    attempt?: number
    message?: string
    next?: number
  }
}

type NotifyConfig = NonNullable<NonNullable<Config.Info["notifications"]>["notify"]>
type RateState = { window: number; count: number }
type BreakerState = { fails: number; openUntil: number }
type ConnectorEntry = NonNullable<Config.Info["connectors"]>[string]
type NotifyState = {
  queue: AsyncQueue<NotifyJob>
  started: boolean
  rate: Map<NotifyChannel, RateState>
  breaker: Map<NotifyChannel, BreakerState>
  busy: Map<string, number>
  config: Config.Info | undefined
}

const notifyLog = Log.create({ service: "notify" })

function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
  return runPromiseWithLayer(Session.defaultLayer, locallyInstance(InstanceState.ambient(), effect))
}

const DEFAULT_RATE_WINDOW_MS = 60_000
const DEFAULT_RATE_MAX = 20
const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY = 500
const DEFAULT_RETRY_FACTOR = 2
const DEFAULT_RETRY_MAX_DELAY = 10_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_BREAKER_FAILURES = 3
const DEFAULT_BREAKER_COOLDOWN_MS = 120_000
const DEFAULT_IDLE_MIN_MS = 30_000
const DEFAULT_QUIET_SUPPRESS: NotifyChannel[] = ["macos"]

/**
 * The notify and init paths hold no `InstanceContext`, so the ambient scope is
 * read here — once, at the boundary — and handed to the explicit form below
 * rather than re-derived inside the fiber.
 */
function configGet() {
  return configGetFor(InstanceState.ambient())
}

function configGetFor(ctx: InstanceContext) {
  return runPromiseWithLayer(
    Config.defaultLayer,
    locallyInstance(
      ctx,
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }),
    ),
  )
}

function makeNotifyState(): NotifyState {
  return {
    queue: new AsyncQueue<NotifyJob>(),
    started: false,
    rate: new Map<NotifyChannel, RateState>(),
    breaker: new Map<NotifyChannel, BreakerState>(),
    busy: new Map<string, number>(),
    config: undefined,
  }
}

function isConnector(entry: ConnectorEntry | undefined): entry is Config.Connector {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function flag(value: boolean | undefined, fallback: boolean) {
  if (value === undefined) return fallback
  return value
}

function settings(config: Config.Info | undefined): NotifyConfig {
  return (config?.notifications?.notify ?? {}) as NotifyConfig
}

function eventOn(config: NotifyConfig | undefined, key: NotifyEventKey, fallback: boolean) {
  const events = config?.events
  if (!events) return fallback
  const value = events[key]
  if (value === undefined) return fallback
  return value
}

function rateConfig(config: NotifyConfig | undefined) {
  const input = config?.rateLimit
  const windowMs = input?.windowMs ?? DEFAULT_RATE_WINDOW_MS
  const maxPerWindow = input?.maxPerWindow ?? DEFAULT_RATE_MAX
  return {
    windowMs: Math.max(1000, windowMs),
    maxPerWindow: Math.max(1, maxPerWindow),
  }
}

function retryConfig(config: NotifyConfig | undefined) {
  const input = config?.retry
  return {
    attempts: input?.attempts ?? DEFAULT_RETRY_ATTEMPTS,
    delay: input?.delay ?? DEFAULT_RETRY_DELAY,
    factor: input?.factor ?? DEFAULT_RETRY_FACTOR,
    maxDelay: input?.maxDelay ?? DEFAULT_RETRY_MAX_DELAY,
    timeoutMs: input?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

function breakerConfig(config: NotifyConfig | undefined) {
  const input = config?.breaker
  const failures = input?.failures ?? DEFAULT_BREAKER_FAILURES
  const cooldownMs = input?.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS
  return {
    failures: Math.max(1, failures),
    cooldownMs: Math.max(1000, cooldownMs),
  }
}

function idleMin(config: NotifyConfig | undefined) {
  const value = config?.idleMinMs
  if (value && value > 0) return value
  return DEFAULT_IDLE_MIN_MS
}

function preview(items: string[], max: number) {
  if (items.length === 0) return ""
  if (items.length <= max) return items.join(", ")
  const head = items.slice(0, max).join(", ")
  return `${head} +${items.length - max} more`
}

function formatMessage(title: string, body: string) {
  if (!body) return title
  return `${title}\n${body}`
}

function slackText(title: string, body: string) {
  if (!body) return `*${title}*`
  return `*${title}*\n${body}`
}

function span(ms: number) {
  const total = Math.max(1, Math.round(ms / 1000))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins === 0) return `${secs}s`
  if (secs === 0) return `${mins}m`
  return `${mins}m ${secs}s`
}

function errorText(error: { name?: string; data?: { message?: string } } | undefined) {
  if (!error) return "Unknown error"
  const data = typeof error === "object" ? error.data : undefined
  if (data && typeof data.message === "string" && data.message.length > 0) return data.message
  const message =
    typeof (error as { message?: string }).message === "string" ? (error as { message?: string }).message : ""
  if (message) return message
  if (typeof error.name === "string" && error.name.length > 0) return error.name
  return "Unknown error"
}

function clock(value: string | undefined) {
  if (!value) return undefined
  const parts = value.split(":")
  if (parts.length !== 2) return undefined
  const hour = Number(parts[0])
  const minute = Number(parts[1])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined
  if (hour < 0 || hour > 23) return undefined
  if (minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

function quiet(config: NotifyConfig | undefined, channel: NotifyChannel, now: Date) {
  const hours = config?.quietHours
  if (!hours) return false
  if (hours.enabled === false) return false
  const start = clock(hours.start)
  const end = clock(hours.end)
  if (start === undefined || end === undefined) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  const active = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  if (!active) return false
  const suppress = hours.suppress ?? DEFAULT_QUIET_SUPPRESS
  return suppress.includes(channel)
}

function slackReady(config: NotifyConfig | undefined) {
  const slack = config?.slack
  if (!slack) return false
  if (slack.enabled === false) return false
  if (!slack.connector) return false
  const channel = slack.channel ?? Flag.NIKCLI_SLACK_CHANNEL
  if (!channel) return false
  return true
}

function discordReady(config: NotifyConfig | undefined) {
  const discord = config?.discord
  if (!discord) return false
  if (discord.enabled === false) return false
  const webhook = discord.webhook ?? Flag.NIKCLI_DISCORD_WEBHOOK_URL
  if (!webhook) return false
  return true
}

function available(config: NotifyConfig | undefined) {
  const list: NotifyChannel[] = []
  if (config?.macos === true && process.platform === "darwin") list.push("macos")
  if (slackReady(config)) list.push("slack")
  if (discordReady(config)) list.push("discord")
  return list
}

function iconPath(value: string) {
  if (!value) return undefined
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  if (value.startsWith("file://")) return fileURLToPath(value)
  if (path.isAbsolute(value)) return value
  return undefined
}

function iconMac(config: Config.Info | undefined): MacIcon | undefined {
  const icon = config?.notifications?.icon
  if (!icon) return undefined
  const value = icon.url
  if (!value) return undefined
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return { value, remote: true }
  }
  const local = iconPath(value)
  if (!local) return undefined
  return { value: local, remote: false }
}

function route(priority: NotifyPriority, list: NotifyChannel[]) {
  if (list.length === 0) return []
  const preferred: NotifyChannel[] =
    priority === "low" || priority === "normal" ? ["macos"] : ["macos", "slack", "discord"]
  const chosen = preferred.filter((item) => list.includes(item))
  if (chosen.length > 0) return chosen
  return list
}

function rateAllow(
  data: NotifyState,
  config: NotifyConfig | undefined,
  channel: NotifyChannel,
  priority: NotifyPriority,
  now: number,
) {
  if (priority === "high" || priority === "critical") return true
  const limit = rateConfig(config)
  const entry = data.rate.get(channel)
  if (!entry) {
    data.rate.set(channel, { window: now, count: 1 })
    return true
  }
  if (now - entry.window >= limit.windowMs) {
    entry.window = now
    entry.count = 1
    return true
  }
  if (entry.count >= limit.maxPerWindow) return false
  entry.count += 1
  return true
}

function breakerOpen(data: NotifyState, channel: NotifyChannel, now: number) {
  const entry = data.breaker.get(channel)
  if (!entry) return false
  if (entry.openUntil === 0) return false
  if (entry.openUntil <= now) {
    data.breaker.delete(channel)
    return false
  }
  return true
}

function breakerReset(data: NotifyState, channel: NotifyChannel) {
  data.breaker.delete(channel)
}

function breakerFail(data: NotifyState, config: NotifyConfig | undefined, channel: NotifyChannel, now: number) {
  const limit = breakerConfig(config)
  const current = data.breaker.get(channel) ?? { fails: 0, openUntil: 0 }
  const fails = current.fails + 1
  const openUntil = fails >= limit.failures ? now + limit.cooldownMs : current.openUntil
  data.breaker.set(channel, { fails, openUntil })
}

function startQueue(data: NotifyState) {
  if (data.started) return
  data.started = true
  void runQueue(data)
}

function enqueue(data: NotifyState, job: NotifyJob) {
  data.queue.push(job)
}

async function loadConfig(data: NotifyState) {
  if (data.config) return data.config
  const config = await configGet()
  data.config = config
  return config
}

async function runQueue(data: NotifyState) {
  for await (const job of data.queue) {
    await processJob(data, job).catch((error) => {
      const text = error instanceof Error ? error.message : String(error)
      notifyLog.error("notification processing failed", {
        error: text,
        source: job.source,
      })
    })
  }
}

async function processJob(data: NotifyState, job: NotifyJob) {
  const config = await loadConfig(data)
  const cfg = settings(config)
  if (!flag(cfg.enabled, true)) return
  const list = available(cfg)
  if (list.length === 0) return
  const targets = route(job.priority, list)
  if (targets.length === 0) return
  const now = new Date()
  const stamp = now.getTime()
  for (const channel of targets) {
    if (quiet(cfg, channel, now)) continue
    if (!rateAllow(data, cfg, channel, job.priority, stamp)) {
      notifyLog.debug("notification rate limited", {
        channel,
        source: job.source,
      })
      continue
    }
    if (breakerOpen(data, channel, stamp)) {
      notifyLog.warn("notification circuit open", {
        channel,
        source: job.source,
      })
      continue
    }
    await deliver(config, cfg, channel, job)
      .then((sent) => {
        if (!sent) return false
        breakerReset(data, channel)
        return true
      })
      .catch((error) => {
        breakerFail(data, cfg, channel, stamp)
        const text = error instanceof Error ? error.message : String(error)
        notifyLog.error("notification delivery failed", {
          channel,
          source: job.source,
          error: text,
        })
        return false
      })
  }
}

async function deliver(config: Config.Info, cfg: NotifyConfig, channel: NotifyChannel, job: NotifyJob) {
  if (channel === "macos") return macos(config, job.title, job.body)
  if (channel === "slack") return slack(config, cfg, job)
  if (channel === "discord") return discord(config, cfg, job)
  return false
}

async function macos(config: Config.Info, title: string, body: string) {
  if (process.platform !== "darwin") return false
  const icon = iconMac(config)
  const message = body.length ? body : " "
  const notifier = icon && !icon.remote ? Bun.which("terminal-notifier") : null
  if (icon && notifier && !icon.remote) {
    const result = await Bun.$`${notifier} -title ${title} -message ${message} -contentImage ${icon.value}`
      .nothrow()
      .quiet()
    if (result.exitCode === 0) return true
  }
  if (!icon) {
    const safeTitle = title.replace(/"/g, '\\"')
    const safeBody = body.replace(/"/g, '\\"')
    await Bun.$`osascript -e 'display notification "${safeBody}" with title "${safeTitle}"'`.nothrow().quiet()
    return true
  }
  const script = `
    ObjC.import('Cocoa')
    const title = ${JSON.stringify(title)}
    const body = ${JSON.stringify(body)}
    const image = ${JSON.stringify(icon.value)}
    const remote = ${JSON.stringify(icon.remote)}
    const notification = $.NSUserNotification.alloc.init
    notification.title = title
    notification.informativeText = body
    const url = remote ? $.NSURL.URLWithString(image) : $.NSURL.fileURLWithPath(image)
    const img = $.NSImage.alloc.initWithContentsOfURL(url)
    if (!img) throw new Error('icon load failed')
    notification.contentImage = img
    const center = $.NSUserNotificationCenter.defaultUserNotificationCenter
    center.deliverNotification(notification)
    $.NSThread.sleepForTimeInterval(0.2)
    if (!notification.presented) throw new Error('notification not presented')
  `
  const result = await Bun.$`osascript -l JavaScript -e ${script}`.nothrow().quiet()
  if (result.exitCode === 0) return true
  const safeTitle = title.replace(/"/g, '\\"')
  const safeBody = body.replace(/"/g, '\\"')
  await Bun.$`osascript -e 'display notification "${safeBody}" with title "${safeTitle}"'`.nothrow().quiet()
  return true
}

async function slack(config: Config.Info, cfg: NotifyConfig, job: NotifyJob) {
  const slack = cfg.slack
  if (!slack) return false
  if (slack.enabled === false) return false
  if (!slack.connector) return false
  const channel = slack.channel ?? Flag.NIKCLI_SLACK_CHANNEL
  if (!channel) return false
  const connectors = config.connectors ?? {}
  const entry = connectors[slack.connector]
  if (!isConnector(entry)) return false
  if (entry.enabled === false) return false
  if (entry.type !== "slack") return false
  const credential = await resolveCredential(slack.connector, entry)
  if (!credential) return false
  const api = await import("../connectors/api/slack")
  const retryCfg = retryConfig(cfg)
  const text = slackText(job.title, job.body)
  const action = () => withTimeout(api.SlackApi.sendMessage(credential, channel, text), retryCfg.timeoutMs)
  await retry(action, {
    attempts: retryCfg.attempts,
    delay: retryCfg.delay,
    factor: retryCfg.factor,
    maxDelay: retryCfg.maxDelay,
  })
  return true
}

async function discord(config: Config.Info, cfg: NotifyConfig, job: NotifyJob) {
  const discord = cfg.discord
  if (!discord) return false
  if (discord.enabled === false) return false
  const webhook = discord.webhook ?? Flag.NIKCLI_DISCORD_WEBHOOK_URL
  if (!webhook) return false
  const retryCfg = retryConfig(cfg)
  const message = formatMessage(job.title, job.body)
  const action = async () => {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    })
    if (response.ok) return
    const text = await response.text()
    const detail = text ? `Discord webhook failed: ${text}` : `Discord webhook failed: ${response.status}`
    throw new Error(detail)
  }
  await retry(() => withTimeout(action(), retryCfg.timeoutMs), {
    attempts: retryCfg.attempts,
    delay: retryCfg.delay,
    factor: retryCfg.factor,
    maxDelay: retryCfg.maxDelay,
  })
  return true
}

async function handleEvent(data: NotifyState, event: { type: string; properties: unknown }) {
  // Session status events are frequent and can arrive back-to-back (busy -> idle).
  // Track busy timing before any async work so we don't miss idle notifications.
  if (event.type === "session.status") {
    const info = event.properties as SessionStatusEvent
    const status = info.status
    if (status.type === "busy" || status.type === "retry") {
      if (!data.busy.has(info.sessionID)) data.busy.set(info.sessionID, Date.now())
      return
    }
    if (status.type !== "idle") return

    const start = data.busy.get(info.sessionID)
    data.busy.delete(info.sessionID)
    if (!start) return

    const config = await loadConfig(data)
    const cfg = settings(config)
    if (!flag(cfg.enabled, true)) return
    if (!eventOn(cfg, "sessionIdle", true)) return
    const elapsed = Date.now() - start
    if (elapsed < idleMin(cfg)) return
    const infoSession = await runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.get(info.sessionID)
      }),
    ).catch(() => undefined)
    const title =
      infoSession && !Session.isDefaultTitle(infoSession.title)
        ? `Session ready: ${infoSession.title}`
        : "Session ready"
    enqueue(data, {
      title,
      body: `Completed in ${span(elapsed)}`,
      priority: "normal",
      source: event.type,
      sessionID: info.sessionID,
    })
    return
  }

  const config = await loadConfig(data)
  const cfg = settings(config)
  if (!flag(cfg.enabled, true)) return
  if (event.type === "permission.asked") {
    if (!eventOn(cfg, "permissionAsked", true)) return
    const info = event.properties as PermissionAsked
    const list = preview(info.patterns ?? [], 3)
    const body = list ? `Permission: ${info.permission}\nPatterns: ${list}` : `Permission: ${info.permission}`
    enqueue(data, {
      title: "Permission required",
      body,
      priority: "high",
      source: event.type,
      sessionID: info.sessionID,
    })
    return
  }
  if (event.type === "question.asked") {
    if (!eventOn(cfg, "questionAsked", true)) return
    const info = event.properties as QuestionAsked
    const first = info.questions?.[0]
    const count = info.questions?.length ?? 0
    const extra = count > 1 ? ` (+${count - 1} more)` : ""
    const body = first ? `${first.header}: ${first.question}${extra}` : "Input required"
    enqueue(data, {
      title: "Input required",
      body,
      priority: "high",
      source: event.type,
      sessionID: info.sessionID,
    })
    return
  }
  if (event.type === "session.error") {
    if (!eventOn(cfg, "sessionError", true)) return
    const info = event.properties as SessionErrorEvent
    const body = errorText(info.error)
    enqueue(data, {
      title: "Session error",
      body,
      priority: "critical",
      source: event.type,
      sessionID: info.sessionID,
    })
    return
  }
}

function createNotifyPlugin(data: NotifyState): PluginInstance {
  return async function NotifyPlugin(_input: PluginInput): Promise<Hooks> {
    startQueue(data)
    return {
      async config(cfg) {
        data.config = cfg as Config.Info
      },
      async event(input) {
        await handleEvent(data, input.event)
      },
    }
  }
}

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  const BUILTIN: string[] = []

  export interface Interface {
    trigger<
      Name extends Exclude<keyof Required<Hooks>, "auth" | "dispose" | "event" | "tool" | "provider">,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(
      name: Name,
      input: Input,
      output: Output,
    ): Effect.Effect<Output, unknown>
    list(): Effect.Effect<Hooks[], unknown>
    init(): Effect.Effect<void, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("Plugin.Service") {}

  export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
    return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? Installation.CHANNEL)
  }

  type State = {
    hooks: Hooks[]
    input: PluginInput
    subscribed: boolean
    unsubscribe?: () => void
    disposed: boolean
  }

  async function disposeHooks(state: State) {
    if (state.disposed) return
    state.disposed = true
    state.unsubscribe?.()
    state.unsubscribe = undefined

    for (const hook of state.hooks) {
      try {
        await hook.dispose?.()
      } catch (error) {
        log.error("plugin dispose hook failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async function buildState(ctx: InstanceContext): Promise<State> {
    const { Server } = await import("../server/server")
    const client = createNikcliClient({
      baseUrl: "http://localhost:4096",
      fetch: Server.localFetch,
    })
    const config = await configGetFor(ctx)
    const hooks: Hooks[] = []
    const input: PluginInput = {
      client,
      project: ctx.project,
      worktree: ctx.worktree,
      directory: ctx.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }

    // Built-in plugins that are directly imported (not installed from npm)
    const internalPlugins: PluginInstance[] = [
      (input) =>
        CodexAuthPlugin(input, {
          experimentalWebSockets: experimentalWebSocketsEnabled({
            enabled: Flag.NIKCLI_EXPERIMENTAL_WEBSOCKETS,
          }),
        }),
      CopilotAuthPlugin,
      XAIAuthPlugin,
      CursorAuthPlugin,
      CloudflareWorkersAuthPlugin,
      CloudflareAIGatewayAuthPlugin,
      // HerdrPlugin is registered by default but stays a hard no-op
      // outside a Herdr pane (HERDR_ENV=1). Inside a Herdr pane it
      // auto-enables the bridge so nikcli appears as a first-class
      // agent without the user having to flip a toggle. The flag still
      // exists for users who want to disable the plugin entirely.
      HerdrPlugin,
      createNotifyPlugin(makeNotifyState()),
    ]

    for (const plugin of internalPlugins) {
      log.info("loading internal plugin", { name: plugin.name })
      const init = await plugin(input)
      hooks.push(init)
    }

    const plugins = [...(config.plugin ?? [])]
    if (!Flag.NIKCLI_DISABLE_DEFAULT_PLUGINS) {
      plugins.push(...BUILTIN)
    }

    for (let plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (isDeprecatedPlugin(plugin)) continue
      const spec = plugin
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await BunProc.install(pkg, version).catch((err) => {
          if (!builtin) throw err

          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to install builtin plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: EventError.unknown(`Failed to install built-in plugin ${pkg}@${version}: ${message}`),
          })

          return ""
        })
        if (!plugin) continue
      }
      const mod = await import(plugin)
      const v1 = readV1Plugin(mod, spec, "server", "detect")
      if (v1) {
        const source = pluginSource(spec)
        const id = readPluginId(v1.id, spec)
        await resolvePluginId(source, spec, plugin, id)
        hooks.push(await (v1 as PluginModule).server!(input, Config.pluginOptions(spec)))
      } else {
        // Prevent duplicate initialization when plugins export the same function
        // as both a named export and default export (e.g., `export const X` and `export default X`).
        // Object.entries(mod) would return both entries pointing to the same function reference.
        const seen = new Set<PluginInstance>()
        for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
          if (seen.has(fn)) continue
          seen.add(fn)
          const init = await fn(input)
          hooks.push(init)
        }
      }
    }

    const state: State = {
      hooks,
      input,
      subscribed: false,
      disposed: false,
    }
    Instance.registerDisposer(() => disposeHooks(state))
    return state
  }

  async function triggerImpl<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "dispose" | "event" | "tool" | "provider">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(state: State, name: Name, input: Input, output: Output): Promise<Output> {
    return triggerHooks(state.hooks, name, input, output)
  }

  export async function triggerHooks<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "dispose" | "event" | "tool" | "provider">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(hooks: readonly Hooks[], name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i]!
      const fn = hook[name as keyof Hooks]
      if (!fn) continue
      // Opencode #17517: per-hook try/catch so one plugin's failure does
      // not block others, and errors are logged instead of vanishing as
      // unhandled rejections.
      try {
        // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
        // give up.
        // try-counter: 2
        await fn(input, output)
      } catch (error) {
        log.warn("plugin hook failed", {
          hook: name,
          pluginIndex: i,
          error: errorMessage(error),
        })
      }
    }
    return output
  }

  export function createEventHookHandler(hooks: readonly Hooks[], isDisposed: () => boolean) {
    return async (input: Parameters<NonNullable<Hooks["event"]>>[0]): Promise<void> => {
      if (isDisposed()) return
      await runEventHooks(hooks, input, isDisposed)
    }
  }

  export function subscribeEventHooks(input: {
    hooks: readonly Hooks[]
    isDisposed: () => boolean
    subscribe: (handler: (event: Parameters<NonNullable<Hooks["event"]>>[0]["event"]) => void) => () => void
  }): (() => void) | undefined {
    if (input.isDisposed()) return
    const handleEvent = createEventHookHandler(input.hooks, input.isDisposed)
    const unsubscribe = input.subscribe((event) => void handleEvent({ event }))
    if (!input.isDisposed()) return unsubscribe
    unsubscribe()
  }

  export async function runEventHooks(
    hooks: readonly Hooks[],
    input: Parameters<NonNullable<Hooks["event"]>>[0],
    isDisposed: () => boolean = () => false,
  ): Promise<void> {
    for (let i = 0; i < hooks.length; i++) {
      if (isDisposed()) return
      try {
        await hooks[i]!["event"]?.(input)
      } catch (error) {
        log.warn("plugin event handler failed", {
          pluginIndex: i,
          error: errorMessage(error),
        })
      }
    }
  }

  async function initImpl(state: State) {
    const hooks = state.hooks
    const config = await configGet()
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i]!
      // The internal Config.Info schema keeps `command.*.template` optional,
      // while the plugin SDK's Config type expects a required template field.
      // The runtime shape is valid for the SDK contract; widen with a cast.
      try {
        await hook.config?.(config as unknown as Parameters<NonNullable<Hooks["config"]>>[0])
      } catch (error) {
        log.warn("plugin config failed", {
          pluginIndex: i,
          error: errorMessage(error),
        })
      }
    }
    if (state.disposed) return
    if (state.subscribed) return
    state.subscribed = true
    state.unsubscribe = subscribeEventHooks({
      hooks: state.hooks,
      isDisposed: () => state.disposed,
      subscribe: Bus.subscribeAll,
    })
    if (!state.unsubscribe) state.subscribed = false
  }

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>((ctx) =>
        Effect.tryPromise(() => buildState(ctx)).pipe(Effect.orDie),
      )
      const getState = () => InstanceState.get(state)

      return Service.of({
        trigger: (name, input, output) =>
          getState().pipe(Effect.flatMap((state) => Effect.tryPromise(() => triggerImpl(state, name, input, output)))),
        list: () => getState().pipe(Effect.map((state) => state.hooks)),
        init: () => getState().pipe(Effect.flatMap((state) => Effect.tryPromise(() => initImpl(state)))),
      })
    }),
  )

  export const defaultLayer = layer
}
