import type { Hooks, PluginInput } from "@nikcli-ai/plugin"
import type { LLMEvent } from "@nikcli-ai/llm"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { existsSync, realpathSync } from "fs"
import { spawn, spawnSync } from "child_process"
import { OAUTH_DUMMY_KEY } from "../auth"
import { Log } from "@nikcli-ai/util/log"
import { z } from "zod"

const log = Log.create({ service: "plugin.cursor" })

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepCli"
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000
const URL_EXTRACTION_TIMEOUT_MS = 10_000

const CURSOR_PROXY_HOST = "127.0.0.1"
const CURSOR_PROXY_PORT = 32124
const CURSOR_PROXY_BASE_URL = `http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_PORT}/v1`
const FORCE_TOOL_MODE = process.env.CURSOR_ACP_FORCE !== "false"

function getHomeDir() {
  const override = process.env.CURSOR_ACP_HOME_DIR
  if (override && override.length > 0) return override
  return os.homedir()
}

type CursorAgentRunner = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

function shouldUseSystemCursorNode() {
  const override = process.env.CURSOR_AGENT_USE_SYSTEM_NODE
  if (override === "true") return true
  if (override === "false") return false
  return os.platform() === "darwin"
}

function getCursorCompileCacheDir() {
  if (process.env.NODE_COMPILE_CACHE) return process.env.NODE_COMPILE_CACHE
  const home = getHomeDir()
  if (os.platform() === "darwin") {
    return path.join(home, "Library", "Caches", "cursor-compile-cache")
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "cursor-compile-cache")
}

function resolveCursorAgentRunner(): CursorAgentRunner {
  const fallback = Bun.which("cursor-agent") ?? Bun.which("agent") ?? "cursor-agent"
  const env: NodeJS.ProcessEnv = { ...process.env }

  if (!shouldUseSystemCursorNode()) {
    return { command: fallback, args: [], env }
  }

  const node = Bun.which("node")
  if (!node || !path.isAbsolute(fallback)) {
    return { command: fallback, args: [], env }
  }

  try {
    const resolved = realpathSync(fallback)
    const entry = path.join(path.dirname(resolved), "index.js")
    if (!existsSync(entry)) {
      return { command: fallback, args: [], env }
    }
    if (!env.NODE_COMPILE_CACHE) {
      env.NODE_COMPILE_CACHE = getCursorCompileCacheDir()
    }
    return {
      command: node,
      args: ["--use-system-ca", entry],
      env,
    }
  } catch {
    return { command: fallback, args: [], env }
  }
}

function getPossibleAuthPaths() {
  const home = getHomeDir()
  const authFiles = ["cli-config.json", "auth.json"]
  const paths: string[] = []

  if (os.platform() === "darwin") {
    for (const file of authFiles) paths.push(path.join(home, ".cursor", file))
    for (const file of authFiles) paths.push(path.join(home, ".config", "cursor", file))
    return paths
  }

  for (const file of authFiles) paths.push(path.join(home, ".config", "cursor", file))

  const xdgConfig = process.env.XDG_CONFIG_HOME
  if (xdgConfig && xdgConfig !== path.join(home, ".config")) {
    for (const file of authFiles) paths.push(path.join(xdgConfig, "cursor", file))
  }

  for (const file of authFiles) paths.push(path.join(home, ".cursor", file))
  return paths
}

const CLI_CONFIG_PATHS = getPossibleAuthPaths()

interface CliConfig {
  access_token?: string
  accessToken?: string
  refresh_token?: string
  refreshToken?: string
  expires_at?: number
  expiresAt?: number
  token?: string
  authInfo?: {
    email?: string
    displayName?: string
    userId?: number
    authId?: string
  }
}

type ImportedTokens = {
  access: string
  refresh: string
  expires: number
}

async function readCliConfig(): Promise<{ path: string; config: CliConfig } | undefined> {
  for (const pathname of CLI_CONFIG_PATHS) {
    try {
      const text = await fs.readFile(pathname, "utf-8")
      const parsed = JSON.parse(text) as CliConfig
      if (parsed.access_token || parsed.accessToken || parsed.token) {
        return { path: pathname, config: parsed }
      }
    } catch {
      continue
    }
  }
  return undefined
}

function cliConfigToOAuth(config: CliConfig): ImportedTokens {
  const access = config.access_token ?? config.accessToken ?? config.token ?? ""
  const refresh = config.refresh_token ?? config.refreshToken ?? access
  let expires = config.expires_at ?? config.expiresAt ?? 0

  if (expires > 0 && expires < 1e12) {
    expires *= 1000
  }

  if (!expires) {
    expires = Date.now() + 60 * 60 * 1000
  }

  return { access, refresh, expires }
}

function stripAnsi(value: string) {
  // ANSI CSI sequences intentionally contain the ESC control character.
  // oxlint-disable-next-line eslint/no-control-regex
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

const CURSOR_AUTH_HINT =
  "Cursor CLI is not authenticated. Run `cursor-agent login` in a terminal (or set CURSOR_API_KEY), then reconnect."

// cursor-agent emits an auth error when the CLI has no valid session. Recent
// versions store the real token in the OS keychain — not in cli-config.json —
// so the only reliable auth signal is the CLI itself, not a config file.
function isCursorAuthError(text: string | undefined): boolean {
  if (!text) return false
  return /authentication required|run '?agent login'?|CURSOR_API_KEY/i.test(stripAnsi(text))
}

async function runCursorAgent(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const runner = resolveCursorAgentRunner()
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (status: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    }
    const proc = spawn(runner.command, [...runner.args, ...args], {
      windowsHide: true,
      env: runner.env,
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
      finish(null)
    }, timeoutMs)
    proc.stdout.on("data", (d) => (stdout += d.toString()))
    proc.stderr.on("data", (d) => (stderr += d.toString()))
    proc.on("close", (code) => finish(code))
    proc.on("error", () => finish(null))
  })
}

// `cursor-agent about` prints a "User Email" row: an address when logged in,
// literally "Not logged in" otherwise. This is the source of truth for auth.
function parseLoggedInFromAbout(aboutOutput: string): boolean {
  const match = stripAnsi(aboutOutput).match(/User Email\s+(.+)/i)
  if (!match) return false
  const value = match[1].trim()
  return value.length > 0 && !/not logged in/i.test(value)
}

async function isCursorAgentLoggedIn(): Promise<boolean> {
  const { stdout } = await runCursorAgent(["about"])
  return parseLoggedInFromAbout(stdout)
}

// Poll until the cursor-agent CLI reports an authenticated session (login done
// in the browser). Replaces the old file-existence check, which false-positived
// on a stale cli-config.json that lingers even when logged out.
async function pollForCursorLogin(timeoutMs = AUTH_POLL_TIMEOUT_MS, intervalMs = 1_000): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    if (await isCursorAgentLoggedIn()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

async function importStoredCursorSession(input: PluginInput, getAuth: () => Promise<any>) {
  let auth = await getAuth()
  if (auth) return auth

  const legacy = await readCliConfig()
  if (!legacy) return auth

  const tokens = cliConfigToOAuth(legacy.config)
  if (!tokens.access) return auth

  await input.client.auth.set({
    providerID: "cursor",
    payload: {
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
    },
  })

  log.info("imported cursor token from cli config", { path: legacy.path })
  return getAuth()
}

async function refreshFromCliConfig(input: PluginInput): Promise<ImportedTokens | undefined> {
  const current = await readCliConfig()
  if (!current) return undefined

  const tokens = cliConfigToOAuth(current.config)
  await input.client.auth.set({
    providerID: "cursor",
    payload: {
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
    },
  })
  return tokens
}

async function waitForCursorAuthStatus(): Promise<{ kind: "token"; tokens: ImportedTokens } | { kind: "session" }> {
  const loggedIn = await pollForCursorLogin()
  if (!loggedIn) {
    throw new Error("Timed out waiting for Cursor login. Complete the browser sign-in and try again.")
  }
  // Older cursor-agent versions still persist a token in cli-config.json; use it
  // when present. Newer versions keep it in the OS keychain, so we fall back to a
  // session marker and let the CLI use its own stored credentials per request.
  const current = await readCliConfig()
  if (current) {
    const tokens = cliConfigToOAuth(current.config)
    if (tokens.access) return { kind: "token", tokens }
  }
  return { kind: "session" }
}

async function startCursorOAuth(): Promise<{
  url: string
  instructions: string
  callback: () => Promise<
    | { type: "success"; access: string; refresh: string; expires: number }
    | { type: "success"; key: string }
    | { type: "failed" }
  >
}> {
  return new Promise((resolve, reject) => {
    log.info("starting cursor-agent login process")

    const runner = resolveCursorAgentRunner()
    const proc = spawn(runner.command, [...runner.args, "login"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: runner.env,
    })

    let stdout = ""
    let stderr = ""
    let urlExtracted = false

    proc.stdout.on("data", (data) => {
      stdout += data.toString()
    })
    proc.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    const extractUrl = () => {
      const cleanOutput = stripAnsi(stdout).replace(/\s/g, "")
      const urlMatch = cleanOutput.match(/https:\/\/cursor\.com\/(loginDeepControl|loginDeepCli)[^\s]*/)
      return urlMatch?.[0] ?? null
    }

    const tryExtractUrl = () => {
      const url = extractUrl()
      if (!url || urlExtracted) return
      urlExtracted = true
      log.info("got cursor login url")

      resolve({
        url,
        instructions: "Click 'Continue with Cursor' in your browser to authenticate.",
        callback: async () => {
          return new Promise((resolveCallback) => {
            let settled = false
            let closed = false
            let timeout: Timer | undefined

            const resolveOnce = (
              value:
                | {
                    type: "success"
                    access: string
                    refresh: string
                    expires: number
                  }
                | { type: "success"; key: string }
                | { type: "failed" },
            ) => {
              if (settled) return
              settled = true
              if (timeout) clearTimeout(timeout)
              resolveCallback(value)
            }

            const stopProc = () => {
              if (closed) return
              try {
                proc.kill()
              } catch {}
            }

            void waitForCursorAuthStatus()
              .then((result) => {
                log.info("cursor auth detected", { kind: result.kind })
                if (result.kind === "token") {
                  resolveOnce({
                    type: "success",
                    access: result.tokens.access,
                    refresh: result.tokens.refresh,
                    expires: result.tokens.expires,
                  })
                } else {
                  resolveOnce({ type: "success", key: OAUTH_DUMMY_KEY })
                }
                stopProc()
              })
              .catch((err) => {
                log.warn("cursor auth poll failed", {
                  error: err instanceof Error ? err.message : String(err),
                })
              })

            proc.on("close", async (code) => {
              closed = true
              if (settled) return
              if (code === 0) {
                try {
                  const status = await waitForCursorAuthStatus()
                  if (status.kind === "token") {
                    resolveOnce({
                      type: "success",
                      access: status.tokens.access,
                      refresh: status.tokens.refresh,
                      expires: status.tokens.expires,
                    })
                  } else {
                    resolveOnce({ type: "success", key: OAUTH_DUMMY_KEY })
                  }
                  return
                } catch {}
              }
              resolveOnce({ type: "failed" })
            })

            timeout = setTimeout(() => {
              stopProc()
              resolveOnce({ type: "failed" })
            }, AUTH_POLL_TIMEOUT_MS)
          })
        },
      })
    }

    const urlPollStart = Date.now()
    const pollForUrl = () => {
      if (urlExtracted) return
      if (Date.now() - urlPollStart >= URL_EXTRACTION_TIMEOUT_MS) {
        proc.kill()
        const errorMsg = stderr ? stripAnsi(stderr) : "No login URL received within timeout"
        reject(new Error(`Failed to get login URL: ${errorMsg}`))
        return
      }
      tryExtractUrl()
      if (!urlExtracted) setTimeout(pollForUrl, 100)
    }
    pollForUrl()
  })
}

const CursorToolArgsSchema = z.looseObject({
  command: z.string().optional().catch(undefined),
  path: z.string().optional().catch(undefined),
  pattern: z.string().optional().catch(undefined),
  query: z.string().optional().catch(undefined),
  file_path: z.string().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  content: z.string().optional().catch(undefined),
})
export type CursorToolArgs = {
  command?: string
  path?: string
  pattern?: string
  query?: string
  file_path?: string
  url?: string
  content?: string
}

const CursorToolCallResultSchema = z.looseObject({
  error: z.unknown(),
  success: z.unknown(),
  content: z.string().optional().catch(undefined),
})
export type CursorToolCallResult = {
  error?: unknown
  success?: unknown
  content?: string
}

const CursorToolCallEntrySchema = z
  .looseObject({
    args: CursorToolArgsSchema.optional().catch(undefined),
    result: CursorToolCallResultSchema.optional().catch(undefined),
  })
  .catch({ args: undefined, result: undefined })
export type CursorToolCallEntry = {
  args?: CursorToolArgs
  result?: CursorToolCallResult
}

const CursorStringListSchema = z
  .array(z.string().nullable().catch(null))
  .transform((entries) => entries.filter((entry): entry is string => entry !== null))

const CursorResultTextSchema = z
  .string()
  .transform((value) => value.trim())
  .catch("")

const CursorSuccessTextSchema = z
  .union([z.string(), z.object({ content: z.string() }).transform((payload) => payload.content)])
  .nullable()
  .catch(null)

const StreamJsonEventSchema = z.looseObject({
  type: z.string().catch(""),
  subtype: z.string().optional().catch(undefined),
  session_id: z.string().optional().catch(undefined),
  timestamp: z.number().optional().catch(undefined),
  timestamp_ms: z.number().optional().catch(undefined),
  // Buffered flush of a prior partial — same text already streamed via
  // timestamp_ms deltas. Must be skipped to avoid duplicating assistant text
  // (cursor stream-json: events with both timestamp_ms and model_call_id).
  model_call_id: z.string().optional().catch(undefined),
  message: z
    .looseObject({
      role: z.string().catch(""),
      content: z
        .array(
          z.looseObject({
            type: z.string().catch(""),
            text: z.string().optional().catch(undefined),
            thinking: z.string().optional().catch(undefined),
          }),
        )
        .catch([]),
    })
    .optional()
    .catch(undefined),
  text: z.string().optional().catch(undefined),
  tool_call: z.record(z.string(), CursorToolCallEntrySchema).optional().catch(undefined),
  call_id: z.string().optional().catch(undefined),
  is_error: z.boolean().optional().catch(undefined),
  // Terminal `result` events put the final assistant text (or error prose) here.
  result: z.unknown(),
  errors: CursorStringListSchema.optional().catch(undefined),
  error: z
    .looseObject({ message: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  usage: z
    .looseObject({
      inputTokens: z.number().optional().catch(undefined),
      outputTokens: z.number().optional().catch(undefined),
      cacheReadTokens: z.number().optional().catch(undefined),
      input_tokens: z.number().optional().catch(undefined),
      output_tokens: z.number().optional().catch(undefined),
      cache_read_tokens: z.number().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
})

export type StreamJsonEvent = {
  type: string
  subtype?: string
  session_id?: string
  timestamp?: number
  timestamp_ms?: number
  model_call_id?: string
  message?: {
    role: string
    content: Array<{ type: string; text?: string; thinking?: string }>
  }
  text?: string
  tool_call?: Record<string, CursorToolCallEntry>
  call_id?: string
  is_error?: boolean
  result?: unknown
  errors?: string[]
  error?: { message?: string }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    input_tokens?: number
    output_tokens?: number
    cache_read_tokens?: number
  }
}

/** True for the buffered duplicate flush that re-emits already-streamed partials. */
function isBufferedFlush(event: StreamJsonEvent): boolean {
  return event.timestamp_ms !== undefined && event.model_call_id !== undefined
}

// cursor-agent tool keys -> nikcli-style labels, so its native tool activity
// reads like the other providers' tool cards in the TUI.
const CURSOR_TOOL_LABELS = new Map([
  ["readToolCall", "read"],
  ["writeToolCall", "write"],
  ["editToolCall", "edit"],
  ["shellToolCall", "bash"],
  ["bashToolCall", "bash"],
  ["lsToolCall", "ls"],
  ["listToolCall", "ls"],
  ["globToolCall", "glob"],
  ["grepToolCall", "grep"],
  ["searchToolCall", "search"],
  ["deleteToolCall", "delete"],
  ["fetchToolCall", "webfetch"],
  ["updateTodosToolCall", "todos"],
  ["taskToolCall", "task"],
])

function cursorToolLabel(key: string): string {
  const known = CURSOR_TOOL_LABELS.get(key)
  if (known) return known
  return key.endsWith("ToolCall") ? key.slice(0, -"ToolCall".length) : key
}

function cursorToolSummary(args: CursorToolArgs | undefined): string {
  if (!args) return ""
  for (const value of [args.command, args.path, args.pattern, args.query, args.file_path, args.url, args.content]) {
    if (value && value.trim()) return value.trim()
  }
  return ""
}

// The tool_call payload nests the tool object next to bookkeeping keys
// (toolCallId, hookAdditionalContexts, ...); pick the one ending in "ToolCall".
function formatCursorToolActivity(event: StreamJsonEvent): string {
  const entry = event.tool_call
  if (!entry) return ""
  const key = Object.keys(entry).find((k) => k.endsWith("ToolCall") && k !== "toolCallId")
  if (!key) return ""
  const label = cursorToolLabel(key)
  const summary = cursorToolSummary(entry[key]?.args)
  const detail = summary ? ` \`${summary.length > 120 ? summary.slice(0, 117) + "…" : summary}\`` : ""
  return `\n\n\`⏺ ${label}\`${detail}\n\n`
}

function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = StreamJsonEventSchema.safeParse(JSON.parse(trimmed))
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

function extractText(event: StreamJsonEvent): string {
  if (!event.message?.content) return ""
  return event.message.content
    .filter((c) => c.type === "text" && c.text !== undefined)
    .map((c) => c.text ?? "")
    .join("")
}

function extractThinkingFromAssistant(event: StreamJsonEvent): string {
  if (!event.message?.content) return ""
  return event.message.content
    .filter((c) => c.type === "thinking" && c.thinking !== undefined)
    .map((c) => c.thinking ?? "")
    .join("")
}

class LineBuffer {
  private buffer = ""
  private decoder = new TextDecoder()
  push(chunk: string | Uint8Array): string[] {
    const text = chunk instanceof Uint8Array ? this.decoder.decode(chunk) : chunk
    if (!text) return []
    this.buffer += text
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""
    const completed: string[] = []
    for (const line of lines) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line
      if (!normalized.trim()) continue
      completed.push(normalized)
    }
    return completed
  }
  flush(): string[] {
    const normalized = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer
    this.buffer = ""
    return normalized.trim() ? [normalized] : []
  }
}

class DeltaTracker {
  private lastText = ""
  private lastThinking = ""
  nextText(v: string): string {
    const d = this.diff(this.lastText, v)
    this.lastText = v
    return d
  }
  nextThinking(v: string): string {
    const d = this.diff(this.lastThinking, v)
    this.lastThinking = v
    return d
  }
  private diff(prev: string, cur: string): string {
    if (!prev) return cur
    if (cur.startsWith(prev)) return cur.slice(prev.length)
    if (prev.startsWith(cur)) return ""
    let i = 0
    const minLen = Math.min(prev.length, cur.length)
    while (i < minLen && prev[i] === cur[i]) i++
    return cur.slice(i)
  }
}

type OpenAiDelta = {
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{
    index: number
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
}

class StreamToSseConverter {
  private readonly id: string
  private readonly created: number
  private readonly model: string
  private readonly tracker = new DeltaTracker()
  private sawAssistantPartials = false
  private sawThinkingPartials = false

  constructor(model: string, options?: { id?: string; created?: number }) {
    this.model = model
    this.id = options?.id ?? `cursor-acp-${Date.now()}`
    this.created = options?.created ?? Math.floor(Date.now() / 1000)
  }

  handleEvent(event: StreamJsonEvent): string[] {
    if (event.type === "assistant" && event.message?.content?.some((c) => c.type === "text")) {
      if (isBufferedFlush(event)) return []
      const isPartial = event.timestamp_ms !== undefined
      if (isPartial) {
        const text = extractText(event)
        if (text) {
          this.sawAssistantPartials = true
          return [this.chunkWith({ content: text })]
        }
        return []
      }
      if (this.sawAssistantPartials) return []
      const delta = this.tracker.nextText(extractText(event))
      return delta ? [this.chunkWith({ content: delta })] : []
    }

    if (event.type === "thinking") {
      if (isBufferedFlush(event)) return []
      const text = event.text ?? ""
      if (event.timestamp_ms !== undefined) {
        if (text) {
          this.sawThinkingPartials = true
          return [this.chunkWith({ reasoning_content: text })]
        }
        return []
      }
      if (this.sawThinkingPartials) return []
      const delta = this.tracker.nextThinking(text)
      return delta ? [this.chunkWith({ reasoning_content: delta })] : []
    }

    if (event.type === "assistant" && event.message?.content?.some((c) => c.type === "thinking")) {
      if (isBufferedFlush(event)) return []
      const isPartial = event.timestamp_ms !== undefined
      const text = extractThinkingFromAssistant(event)
      if (isPartial) {
        if (text) {
          this.sawThinkingPartials = true
          return [this.chunkWith({ reasoning_content: text })]
        }
        return []
      }
      if (this.sawThinkingPartials) return []
      const delta = this.tracker.nextThinking(text)
      return delta ? [this.chunkWith({ reasoning_content: delta })] : []
    }

    // Passthrough mode: cursor-agent executes its OWN tools (edit/bash/etc.) via
    // `--force`. We do NOT re-emit them as OpenAI tool_calls — that made nikcli
    // try to run cursor's tools (updateTodos/Task/...) and reject them as
    // "unavailable". Instead we surface each call as a compact markdown line so
    // the TUI shows the concrete action (path/command) like a native tool card.
    // Only on "started" to avoid duplicating on the paired "completed" event.
    if (event.type === "tool_call") {
      if (event.subtype && event.subtype !== "started") return []
      const line = formatCursorToolActivity(event)
      return line ? [this.chunkWith({ content: line })] : []
    }

    return []
  }

  private chunkWith(delta: OpenAiDelta): string {
    return `data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`
  }
}

function formatSseDone(): string {
  return "data: [DONE]\n\n"
}

function formatSseStart(model: string, options?: { id?: string; created?: number }): string {
  return `data: ${JSON.stringify({
    id: options?.id ?? `cursor-acp-${Date.now()}`,
    object: "chat.completion.chunk",
    created: options?.created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`
}

const CursorChatPartSchema = z
  .looseObject({
    type: z.string().catch(""),
    text: z.string().optional().catch(undefined),
  })
  .catch({ type: "", text: undefined })

const CursorChatMessageSchema = z.looseObject({
  role: z.string().catch("user"),
  content: z
    .union([z.string(), z.array(CursorChatPartSchema)])
    .optional()
    .catch(undefined),
})

function messageText(message: any): string {
  const parsed = CursorChatMessageSchema.safeParse(message)
  if (!parsed.success) return ""
  const content = parsed.data.content
  if (content === undefined) return ""
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  }
  return content
}

// Passthrough mode: cursor-agent IS the agent and runs its own tools, so we send
// plain conversational history — no tool advertising, no OpenAI tool_call markup
// (which cursor-agent doesn't understand and which fought its native tool loop).
function buildPromptFromMessages(messages: Array<any>): string {
  const lines: string[] = []
  for (const message of messages) {
    const parsedMessage = CursorChatMessageSchema.safeParse(message)
    const role = parsedMessage.success ? parsedMessage.data.role : "user"
    if (role === "tool") continue // tool results belong to nikcli's loop, not cursor's
    const text = messageText(message)
    if (text) lines.push(`${role.toUpperCase()}: ${text}`)
  }
  return lines.join("\n\n")
}

function lastUserPrompt(messages: Array<any>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      const text = messageText(messages[i])
      if (text) return text
    }
  }
  return ""
}

// A conversation is a continuation once a prior assistant turn with content
// exists — then we hand cursor-agent only the new user message and resume its
// own session (native context) instead of replaying a flattened history.
function isContinuation(messages: Array<any>): boolean {
  return messages.some((m: any) => m?.role === "assistant" && messageText(m).trim().length > 0)
}

// Maps a nikcli conversation (workspace + first user message) to the cursor-agent
// session id captured from its stream, so follow-up turns `--resume` the SAME
// session rather than starting fresh or continuing an unrelated one.
const cursorSessions = new Map<string, string>()

function conversationKey(workspaceDirectory: string, messages: Array<any>): string {
  const firstUser = messages.find((m: any) => m?.role === "user")
  const seed = `${workspaceDirectory}::${firstUser ? messageText(firstUser) : ""}`
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0
  return `k${hash >>> 0}`
}

function normalizeCursorModel(model: string | undefined): string {
  if (!model) return "auto"
  const cleaned = model.replace(/^cursor\//, "").replace(/^cursor-acp\//, "")
  return cleaned || "auto"
}

async function handleCursorProxyRequest(req: Request, workspaceDirectory: string): Promise<Response> {
  const bunAny = globalThis as any
  if (!bunAny.Bun?.spawn) {
    throw new Error("Cursor proxy requires Bun runtime.")
  }

  try {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, workspaceDirectory }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      const runner = resolveCursorAgentRunner()
      const proc = bunAny.Bun.spawn({
        windowsHide: true,
        cmd: [runner.command, ...runner.args, "models"],
        stdout: "pipe",
        stderr: "pipe",
        env: runner.env,
      })
      const [output, errOutput] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      if (isCursorAuthError(output) || isCursorAuthError(errOutput)) {
        return new Response(
          JSON.stringify({
            error: { message: CURSOR_AUTH_HINT, type: "authentication_error" },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        )
      }
      const created = Math.floor(Date.now() / 1000)
      const models = parseCursorModelsOutput(output).map(({ id }) => ({
        id,
        object: "model",
        created,
        owned_by: "cursor",
      }))
      return new Response(JSON.stringify({ object: "list", data: models }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
      return new Response(JSON.stringify({ error: `Unsupported path: ${url.pathname}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    const body: any = await req.json().catch(() => ({}))
    const messages: Array<any> = Array.isArray(body?.messages) ? body.messages : []
    const stream = body?.stream === true
    const model = normalizeCursorModel(body?.model)

    // Session continuity: on a follow-up turn, resume cursor-agent's own session
    // and send only the new user message so it keeps native context; on the first
    // turn, send the full history and capture the session id from the stream.
    const convKey = conversationKey(workspaceDirectory, messages)
    const priorSession = cursorSessions.get(convKey)
    const resuming = priorSession !== undefined && isContinuation(messages)
    const prompt =
      (resuming ? lastUserPrompt(messages) : buildPromptFromMessages(messages)) || buildPromptFromMessages(messages)
    const captureSession = (event: StreamJsonEvent) => {
      if (event.session_id) cursorSessions.set(convKey, event.session_id)
    }

    const runner = resolveCursorAgentRunner()
    const cmd = [
      runner.command,
      ...runner.args,
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--workspace",
      workspaceDirectory,
    ]
    if (resuming) cmd.push("--resume", priorSession!)
    cmd.push("--model", model)
    if (FORCE_TOOL_MODE) cmd.push("--force")

    const child = bunAny.Bun.spawn({
      windowsHide: true,
      cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...bunAny.Bun.env,
        ...runner.env,
      },
    })

    child.stdin.write(prompt)
    child.stdin.end()

    if (!stream) {
      const [stdoutText, stderrText] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const stdout = (stdoutText || "").trim()
      const stderr = (stderrText || "").trim()
      const exitCode = await child.exited

      let assistantText = ""
      let reasoningText = ""
      let sawPartials = false
      for (const line of stdout.split("\n")) {
        const event = parseStreamJsonLine(line)
        if (!event) continue
        captureSession(event)
        if (event.type === "assistant" && event.message?.content?.some((c) => c.type === "text")) {
          const text = extractText(event)
          if (!text) continue
          const isPartial = event.timestamp_ms !== undefined
          if (isPartial) {
            assistantText += text
            sawPartials = true
          } else if (!sawPartials) {
            assistantText = text
          }
        }
        if (event.type === "thinking" && event.text !== undefined) reasoningText += event.text
        if (event.type === "assistant" && event.message?.content?.some((c) => c.type === "thinking")) {
          reasoningText += extractThinkingFromAssistant(event)
        }
      }

      if (exitCode !== 0 && !assistantText) {
        if (isCursorAuthError(stderr) || isCursorAuthError(stdout)) {
          return new Response(
            JSON.stringify({
              error: {
                message: CURSOR_AUTH_HINT,
                type: "authentication_error",
              },
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            },
          )
        }
        const errSource = stderr || stdout || `cursor-agent exited with code ${exitCode}`
        return new Response(JSON.stringify({ error: stripAnsi(errSource) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }

      const message: any = { role: "assistant", content: assistantText }
      if (reasoningText) message.reasoning_content = reasoningText

      return new Response(
        JSON.stringify({
          id: `cursor-acp-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    const id = `cursor-acp-${Date.now()}`
    const created = Math.floor(Date.now() / 1000)
    const converter = new StreamToSseConverter(model, { id, created })

    let stderrBuffer = ""
    const stderrDrain = (async () => {
      try {
        const reader = child.stderr.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) stderrBuffer += decoder.decode(value, { stream: true })
        }
      } catch {}
    })()

    let streamClosed = false
    let stoppedByProxy = false
    const stopChild = () => {
      stoppedByProxy = true
      try {
        child.kill()
      } catch {}
    }
    const abortListener = () => stopChild()
    req.signal.addEventListener("abort", abortListener, { once: true })

    const sse = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const lineBuffer = new LineBuffer()
        const safeEnqueue = (data: Uint8Array) => {
          if (streamClosed) return
          try {
            controller.enqueue(data)
          } catch {
            streamClosed = true
          }
        }

        safeEnqueue(encoder.encode(formatSseStart(model, { id, created })))

        void (async () => {
          try {
            const reader = child.stdout.getReader()
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              if (!value) continue
              for (const line of lineBuffer.push(value)) {
                const event = parseStreamJsonLine(line)
                if (!event) continue
                captureSession(event)
                for (const out of converter.handleEvent(event)) {
                  safeEnqueue(encoder.encode(out))
                }
              }
            }
            for (const line of lineBuffer.flush()) {
              const event = parseStreamJsonLine(line)
              if (!event) continue
              captureSession(event)
              for (const out of converter.handleEvent(event)) {
                safeEnqueue(encoder.encode(out))
              }
            }

            const exitCode = await child.exited
            await stderrDrain
            if (exitCode !== 0) {
              if (stoppedByProxy) {
                return
              }
              const rawStderr = stderrBuffer.trim()
              const msg = isCursorAuthError(rawStderr)
                ? CURSOR_AUTH_HINT
                : stripAnsi(
                    rawStderr ||
                      `cursor-agent exited with code ${exitCode} (signal=${exitCode === 137 ? "SIGKILL" : "unknown"})`,
                  )
              log.warn("cursor-agent streaming exited with error", {
                exitCode,
                stderr: msg.slice(0, 500),
                model,
              })
              const errChunk = {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: msg }, finish_reason: "stop" }],
              }
              safeEnqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`))
              safeEnqueue(encoder.encode(formatSseDone()))
              return
            }

            const doneChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }
            safeEnqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`))
            safeEnqueue(encoder.encode(formatSseDone()))
          } catch (err) {
            if (stoppedByProxy) {
              return
            }
            const msg = err instanceof Error ? err.message : String(err)
            log.warn("cursor-agent streaming threw", { error: msg })
            const errChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: msg }, finish_reason: "stop" }],
            }
            safeEnqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`))
            safeEnqueue(encoder.encode(formatSseDone()))
          } finally {
            streamClosed = true
            req.signal.removeEventListener("abort", abortListener)
            try {
              controller.close()
            } catch {}
            try {
              if (!stoppedByProxy) child.kill()
            } catch {}
          }
        })()
      },
      cancel() {
        streamClosed = true
        stopChild()
      },
    })

    return new Response(sse, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}

type CursorToolOutcome = {
  type: "text" | "json" | "error"
  value: unknown
}

function extractCursorToolResult(toolObj: CursorToolCallEntry | undefined): CursorToolOutcome {
  const result = toolObj?.result
  if (!result) return { type: "text", value: "" }
  if (result.error) {
    const asText = z.string().safeParse(result.error)
    return {
      type: "error",
      value: asText.success ? asText.data : JSON.stringify(result.error),
    }
  }
  const success = result.success ?? result
  const text = CursorSuccessTextSchema.parse(success)
  if (text !== null) return { type: "text", value: text }
  return { type: "json", value: success }
}

// Converts cursor-agent stream-json events into nikcli LLMEvents. Unlike the SSE
// path (which goes through streamText and would EXECUTE tool calls), these events
// are fed straight to the processor via toProcessorStream, so cursor's own tool
// activity renders as native nikcli tool cards WITHOUT nikcli re-executing them.
export class CursorEventToLLM {
  private tracker = new DeltaTracker()
  private sawAssistantPartials = false
  private sawThinkingPartials = false
  private startedTools = new Set<string>()

  handle(event: StreamJsonEvent): LLMEvent[] {
    if (event.type === "assistant" && event.message?.content?.some((c) => c.type === "text")) {
      if (isBufferedFlush(event)) return []
      const isPartial = event.timestamp_ms !== undefined
      if (isPartial) {
        const text = extractText(event)
        if (!text) return []
        this.sawAssistantPartials = true
        return [{ type: "text-delta", text } as LLMEvent]
      }
      if (this.sawAssistantPartials) return []
      const delta = this.tracker.nextText(extractText(event))
      return delta ? [{ type: "text-delta", text: delta } as LLMEvent] : []
    }

    if (event.type === "thinking") {
      if (isBufferedFlush(event)) return []
      const text = event.text ?? ""
      if (event.timestamp_ms !== undefined) {
        if (!text) return []
        this.sawThinkingPartials = true
        return [{ type: "reasoning-delta", text } as LLMEvent]
      }
      if (this.sawThinkingPartials) return []
      const delta = this.tracker.nextThinking(text)
      return delta ? [{ type: "reasoning-delta", text: delta } as LLMEvent] : []
    }

    if (event.type === "assistant" && event.message?.content?.some((c) => c.type === "thinking")) {
      if (isBufferedFlush(event)) return []
      const isPartial = event.timestamp_ms !== undefined
      const text = extractThinkingFromAssistant(event)
      if (isPartial) {
        if (!text) return []
        this.sawThinkingPartials = true
        return [{ type: "reasoning-delta", text } as LLMEvent]
      }
      if (this.sawThinkingPartials) return []
      const delta = this.tracker.nextThinking(text)
      return delta ? [{ type: "reasoning-delta", text: delta } as LLMEvent] : []
    }

    if (event.type === "tool_call") {
      const entry = event.tool_call
      if (!entry) return []
      const key = Object.keys(entry).find((k) => k.endsWith("ToolCall") && k !== "toolCallId")
      if (!key) return []
      const id = (event.call_id ?? crypto.randomUUID()).replace(/\s+/g, "")
      const label = cursorToolLabel(key)
      if (event.subtype === "started") {
        if (this.startedTools.has(id)) return []
        this.startedTools.add(id)
        return [
          {
            type: "tool-call",
            id,
            name: label,
            input: entry[key]?.args ?? {},
            providerExecuted: true,
          } as LLMEvent,
        ]
      }
      if (event.subtype === "completed") {
        // Ensure a matching tool-call was emitted (defensive against a lone completed).
        const events: LLMEvent[] = []
        if (!this.startedTools.has(id)) {
          this.startedTools.add(id)
          events.push({
            type: "tool-call",
            id,
            name: label,
            input: entry[key]?.args ?? {},
            providerExecuted: true,
          } as LLMEvent)
        }
        const result = extractCursorToolResult(entry[key])
        if (result.type === "error" || event.is_error) {
          events.push({
            type: "tool-error",
            id,
            name: label,
            message: String(result.value ?? event.error?.message ?? "Tool failed"),
            providerExecuted: true,
          } as LLMEvent)
        } else {
          events.push({
            type: "tool-result",
            id,
            name: label,
            result,
            providerExecuted: true,
          } as LLMEvent)
        }
        return events
      }
      return []
    }

    return []
  }
}

export type CursorStreamInput = {
  messages: Array<any>
  system?: string[]
  model: string | undefined
  workspaceDirectory: string
  abort: AbortSignal
}

// Drive cursor-agent and surface it as a native LLMEvent stream (text, reasoning,
// tool cards, usage). Wired in session/llm.ts for provider "cursor" so the whole
// nikcli rendering/persistence pipeline applies, minus tool execution.
export async function* streamCursorLLMEvents(input: CursorStreamInput): AsyncIterable<LLMEvent> {
  const model = normalizeCursorModel(input.model)
  const convKey = conversationKey(input.workspaceDirectory, input.messages)
  const priorSession = cursorSessions.get(convKey)
  const resuming = priorSession !== undefined && isContinuation(input.messages)

  let prompt = resuming ? lastUserPrompt(input.messages) : buildPromptFromMessages(input.messages)
  if (!prompt) prompt = buildPromptFromMessages(input.messages)
  if (!resuming && input.system?.length) {
    prompt = `SYSTEM: ${input.system.join("\n\n")}\n\n${prompt}`
  }

  const runner = resolveCursorAgentRunner()
  const cmd = [
    runner.command,
    ...runner.args,
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    input.workspaceDirectory,
  ]
  if (resuming) cmd.push("--resume", priorSession!)
  cmd.push("--model", model)
  if (FORCE_TOOL_MODE) cmd.push("--force")

  const bunAny = globalThis as any
  const child = bunAny.Bun.spawn({
    windowsHide: true,
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...bunAny.Bun.env, ...runner.env },
  })
  child.stdin.write(prompt)
  child.stdin.end()

  const onAbort = () => {
    try {
      child.kill()
    } catch {}
  }
  input.abort.addEventListener("abort", onAbort, { once: true })

  const converter = new CursorEventToLLM()
  const lineBuffer = new LineBuffer()
  let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined
  let sawAuthError = false
  let resultError: string | undefined

  yield { type: "request-start", id: `cursor-${Date.now()}` } as LLMEvent

  const mapEvent = (event: StreamJsonEvent): LLMEvent[] => {
    if (event.session_id) cursorSessions.set(convKey, event.session_id)
    if (event.type === "result") {
      if (event.is_error) {
        // Prefer the human-readable `result` string over subtype ("success" can
        // still appear with is_error=true when the protocol session closed cleanly).
        const fromResult = CursorResultTextSchema.parse(event.result)
        const fromErrors = event.errors?.join("; ") ?? ""
        resultError = fromResult || fromErrors || event.error?.message || "cursor-agent reported an error"
      }
      const u = event.usage
      if (u) {
        usage = {
          inputTokens: u.inputTokens ?? u.input_tokens,
          outputTokens: u.outputTokens ?? u.output_tokens,
          cacheReadTokens: u.cacheReadTokens ?? u.cache_read_tokens,
        }
      }
    }
    return converter.handle(event)
  }

  try {
    if (input.abort.aborted) {
      throw new DOMException("Aborted", "AbortError")
    }

    const reader = child.stdout.getReader()
    while (true) {
      if (input.abort.aborted) {
        throw new DOMException("Aborted", "AbortError")
      }
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      for (const line of lineBuffer.push(value)) {
        if (isCursorAuthError(line)) sawAuthError = true
        const event = parseStreamJsonLine(line)
        if (!event) continue
        for (const out of mapEvent(event)) yield out
      }
    }
    for (const line of lineBuffer.flush()) {
      if (isCursorAuthError(line)) sawAuthError = true
      const event = parseStreamJsonLine(line)
      if (!event) continue
      for (const out of mapEvent(event)) yield out
    }

    const exitCode = await child.exited
    if (input.abort.aborted) {
      throw new DOMException("Aborted", "AbortError")
    }

    if (sawAuthError || resultError || exitCode !== 0) {
      const stderrText = await new Response(child.stderr).text().catch(() => "")
      if (sawAuthError || isCursorAuthError(stderrText)) {
        yield {
          type: "provider-error",
          message: CURSOR_AUTH_HINT,
          retryable: false,
        } as LLMEvent
        return
      }
      if (resultError) {
        yield {
          type: "provider-error",
          message: resultError,
          retryable: false,
        } as LLMEvent
        return
      }
      const msg = stripAnsi(stderrText).trim() || `cursor-agent exited with code ${exitCode}`
      yield {
        type: "provider-error",
        message: msg,
        retryable: false,
      } as LLMEvent
      return
    }

    yield {
      type: "request-finish",
      reason: "stop",
      ...(usage
        ? {
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadTokens,
            },
          }
        : undefined),
    } as LLMEvent
  } finally {
    input.abort.removeEventListener("abort", onAbort)
    try {
      child.kill()
    } catch {}
  }
}

type CursorModelInfo = {
  name: string
  family: string
  context: number
  output: number
  reasoning?: boolean
  image?: boolean
}

const CURSOR_MODELS = {
  "claude-sonnet-4-5": {
    name: "Claude Sonnet 4.5",
    family: "claude",
    context: 200_000,
    output: 32_000,
    image: true,
  },
  "claude-sonnet-4-5-thinking": {
    name: "Claude Sonnet 4.5 (Thinking)",
    family: "claude",
    context: 200_000,
    output: 32_000,
    reasoning: true,
    image: true,
  },
  "claude-sonnet-4": {
    name: "Claude Sonnet 4",
    family: "claude",
    context: 200_000,
    output: 16_000,
    image: true,
  },
  "claude-sonnet-4-thinking": {
    name: "Claude Sonnet 4 (Thinking)",
    family: "claude",
    context: 200_000,
    output: 16_000,
    reasoning: true,
    image: true,
  },
  "claude-opus-4-1": {
    name: "Claude Opus 4.1",
    family: "claude",
    context: 200_000,
    output: 32_000,
    image: true,
  },
  "claude-opus-4": {
    name: "Claude Opus 4",
    family: "claude",
    context: 200_000,
    output: 32_000,
    image: true,
  },
  "claude-3-5-sonnet": {
    name: "Claude 3.5 Sonnet",
    family: "claude",
    context: 200_000,
    output: 8_000,
    image: true,
  },
  "gpt-5": {
    name: "GPT-5",
    family: "openai",
    context: 272_000,
    output: 32_000,
    image: true,
  },
  "gpt-5.1": {
    name: "GPT-5.1",
    family: "openai",
    context: 272_000,
    output: 32_000,
    image: true,
  },
  "gpt-5.2": {
    name: "GPT-5.2",
    family: "openai",
    context: 272_000,
    output: 32_000,
    image: true,
  },
  "gpt-4.1": {
    name: "GPT-4.1",
    family: "openai",
    context: 1_047_576,
    output: 32_000,
    image: true,
  },
  o3: {
    name: "OpenAI o3",
    family: "openai",
    context: 200_000,
    output: 100_000,
    reasoning: true,
  },
  "o4-mini": {
    name: "OpenAI o4-mini",
    family: "openai",
    context: 200_000,
    output: 65_000,
    reasoning: true,
  },
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    family: "gemini",
    context: 1_048_576,
    output: 65_000,
    image: true,
    reasoning: true,
  },
  "gemini-2.5-flash": {
    name: "Gemini 2.5 Flash",
    family: "gemini",
    context: 1_048_576,
    output: 65_000,
    image: true,
  },
  "grok-4": {
    name: "Grok 4",
    family: "grok",
    context: 256_000,
    output: 16_000,
  },
  "grok-3": {
    name: "Grok 3",
    family: "grok",
    context: 131_072,
    output: 16_000,
  },
  "composer-1": {
    name: "Cursor Composer",
    family: "cursor",
    context: 200_000,
    output: 32_000,
  },
  "composer-2.5": {
    name: "Cursor Composer 2.5",
    family: "cursor",
    context: 200_000,
    output: 32_000,
  },
  composer: {
    name: "Cursor Composer",
    family: "cursor",
    context: 200_000,
    output: 32_000,
  },
  auto: {
    name: "Auto (cursor-agent)",
    family: "cursor",
    context: 200_000,
    output: 32_000,
  },
} satisfies Record<string, CursorModelInfo>

function inferFamilyFromModelId(id: string): string {
  const s = id.toLowerCase()
  if (s.includes("composer") || s === "auto" || s.includes("cursor-")) return "cursor"
  if (s.includes("claude")) return "claude"
  if (s.includes("codex")) return "openai"
  if (s.includes("gpt") || s.startsWith("o3") || s.startsWith("o4") || s.startsWith("o1")) return "openai"
  if (s.includes("gemini")) return "gemini"
  if (s.includes("grok")) return "grok"
  if (s.includes("deepseek")) return "deepseek"
  if (s.includes("llama")) return "meta"
  if (s.includes("mistral") || s.includes("codestral")) return "mistral"
  if (s.includes("qwen")) return "qwen"
  return "cursor"
}

function supportsReasoning(id: string): boolean {
  const s = id.toLowerCase()
  return (
    s.includes("thinking") ||
    s.startsWith("o1") ||
    s.startsWith("o3") ||
    s.startsWith("o4") ||
    s.includes("reasoning") ||
    s.includes("-r1")
  )
}

function supportsImage(id: string): boolean {
  const s = id.toLowerCase()
  if (s.includes("grok-3") || s.includes("grok-4")) return false
  if (s.startsWith("o3") || s.startsWith("o4")) return false
  return s.includes("claude") || s.includes("gpt-") || s.includes("gemini") || s.includes("vision")
}

type CursorContextWindow = {
  context: number
  output: number
}

function getContextWindow(id: string): CursorContextWindow {
  const s = id.toLowerCase()
  if (s.includes("gemini-2.5") || s.includes("gemini-1.5")) return { context: 1_048_576, output: 65_000 }
  if (s.includes("gpt-4.1")) return { context: 1_047_576, output: 32_000 }
  if (s.includes("gpt-5.4")) return { context: 1_000_000, output: 32_000 }
  if (s.includes("gpt-5.3-codex") || s.includes("gpt-5.2-codex") || s.includes("gpt-5.1-codex"))
    return { context: 272_000, output: 65_000 }
  if (s.includes("gpt-5")) return { context: 272_000, output: 32_000 }
  if (s.includes("grok-4")) return { context: 256_000, output: 16_000 }
  if (s.includes("grok-3")) return { context: 131_072, output: 16_000 }
  if (s.includes("claude-opus-4-7")) return { context: 1_000_000, output: 32_000 }
  if (s.includes("claude") && s.includes("opus")) return { context: 200_000, output: 32_000 }
  if (s.includes("claude-sonnet-4") || s.includes("claude-sonnet-4-5")) return { context: 200_000, output: 32_000 }
  if (s.includes("claude-3-5") || s.includes("claude-3.5")) return { context: 200_000, output: 8_000 }
  if (s.startsWith("o3")) return { context: 200_000, output: 100_000 }
  if (s.startsWith("o4")) return { context: 200_000, output: 65_000 }
  if (s.includes("deepseek")) return { context: 128_000, output: 16_000 }
  if (s.includes("composer")) return { context: 200_000, output: 32_000 }
  return { context: 200_000, output: 16_000 }
}

// Model ids are lowercase, dot/dash/underscore only (e.g. "claude-sonnet-4-5",
// "gpt-5.2", "composer-2.5", "auto"). Keeping this strict (no `i` flag) stops
// prose/header lines from being mistaken for models.
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const MODEL_HEADER_WORDS = new Set(["model", "models", "id", "name", "available", "no"])

// Parse `cursor-agent models` output tolerantly. Handles the "id - name" form,
// whitespace/tab columns, and bare-id lists, stripping "(current)"/"(default)"
// markers and bullets. Unknown future formats degrade gracefully to id-only.
function parseCursorModelsOutput(output: string): Array<{ id: string; name: string }> {
  const models: Array<{ id: string; name: string }> = []
  const seen = new Set<string>()
  for (const rawLine of stripAnsi(output).split("\n")) {
    let line = rawLine.trim()
    if (!line) continue
    line = line.replace(/^[-*•>\s]+/, "").trim()
    if (!line || /^no models/i.test(line)) continue
    line = line.replace(/\s*\((?:current|default|recommended|selected)\)\s*$/i, "").trim()

    let id: string
    let name: string
    const dash = line.match(/^([a-z0-9][a-z0-9._-]*)\s+-\s+(.+)$/)
    if (dash) {
      id = dash[1]
      name = dash[2].trim()
    } else {
      const columns = line
        .split(/\s{2,}|\t+/)
        .map((p) => p.trim())
        .filter(Boolean)
      id = (columns[0] ?? line).split(/\s+/)[0]
      name = columns.length > 1 ? columns.slice(1).join(" ") : id
    }

    if (!id || !MODEL_ID_RE.test(id) || MODEL_HEADER_WORDS.has(id.toLowerCase())) continue
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: name || id })
  }
  return models
}

/**
 * One discovery per process. `ModelsDev.get()` re-patches the catalog on every
 * call and each patch lands here, so without this the startup path pays a
 * synchronous Node CLI launch again for every caller.
 */
let discoveredCursorModels: Map<string, CursorModelInfo> | undefined

function discoverCursorModelsSync(): Map<string, CursorModelInfo> {
  discoveredCursorModels ??= discoverCursorModels()
  return discoveredCursorModels
}

function discoverCursorModels(): Map<string, CursorModelInfo> {
  const result = new Map<string, CursorModelInfo>()
  try {
    const runner = resolveCursorAgentRunner()
    // The runner falls back to a bare "cursor-agent", so a machine without the
    // CLI is only discovered by failing the spawn. Asking first keeps every
    // such startup off a subprocess it cannot use.
    if (!path.isAbsolute(runner.command) && !Bun.which(runner.command)) return result
    const out = spawnSync(runner.command, [...runner.args, "models"], {
      encoding: "utf-8",
      // Blocking, and on the startup path: the static catalog below is a fine
      // answer, waiting a quarter minute for a better one is not.
      timeout: 5000,
      env: runner.env,
    })
    if (out.status !== 0 || !out.stdout) return result
    // Not logged in → CLI returns an auth error / "no models"; keep the static
    // fallback rather than polluting the list with parsed noise.
    if (isCursorAuthError(out.stdout) || isCursorAuthError(out.stderr)) return result
    for (const { id, name } of parseCursorModelsOutput(out.stdout)) {
      const ctx = getContextWindow(id)
      result.set(id, {
        name,
        family: inferFamilyFromModelId(id),
        context: ctx.context,
        output: ctx.output,
        reasoning: supportsReasoning(id),
        image: supportsImage(id),
      })
    }
  } catch {}
  return result
}

function toCursorModelsDevModel(id: string, info: CursorModelInfo) {
  return {
    id,
    name: info.name,
    family: info.family,
    release_date: "2025-01-01",
    attachment: info.image ?? false,
    reasoning: info.reasoning ?? false,
    tool_call: true,
    temperature: true,
    cost: { input: 0, output: 0 },
    limit: { context: info.context, output: info.output },
    modalities: {
      input: info.image ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    options: {},
  }
}

export function cursorModelsDevProvider() {
  const discovered = discoverCursorModelsSync()
  const combined = new Map<string, CursorModelInfo>(Object.entries(CURSOR_MODELS))
  for (const [id, info] of discovered) {
    combined.set(id, info)
  }
  if (!combined.has("auto")) {
    combined.set("auto", {
      name: "Auto (cursor-agent)",
      family: "cursor",
      context: 200_000,
      output: 32_000,
    })
  }

  const models = Object.fromEntries([...combined].map(([id, info]) => [id, toCursorModelsDevModel(id, info)] as const))
  return {
    id: "cursor",
    name: "Cursor",
    env: ["CURSOR_API_KEY"],
    api: CURSOR_PROXY_BASE_URL,
    npm: "@ai-sdk/openai-compatible",
    models,
  }
}

export async function CursorAuthPlugin(input: PluginInput): Promise<Hooks> {
  const workspaceDirectory = process.env.CURSOR_ACP_WORKSPACE?.trim() || input.directory || process.cwd()

  return {
    auth: {
      provider: "cursor",
      async loader(getAuth, provider) {
        const auth = await importStoredCursorSession(input, getAuth)
        if (!auth) return {}
        if (auth.type !== "api" && auth.type !== "oauth") return {}

        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: auth.type === "api" ? auth.key : OAUTH_DUMMY_KEY,
          baseURL: CURSOR_PROXY_BASE_URL,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth?.type === "oauth" && (!currentAuth.access || currentAuth.expires < Date.now() - 30_000)) {
              // cursor-agent owns this session and renews it itself; the copy
              // here is only a mirror. Newer CLIs keep the token in the OS
              // keychain, so a missing cli-config.json does not mean signed
              // out — the proxy answers a real logout with CURSOR_AUTH_HINT.
              log.info("cursor token expired, reloading from cli config")
              const refreshed = await refreshFromCliConfig(input)
              if (!refreshed) log.info("no cursor cli config to mirror; deferring to cursor-agent's own session")
            }

            return handleCursorProxyRequest(new Request(requestInput, init), workspaceDirectory)
          },
        }
      },
      methods: [
        {
          label: "Sign in with Cursor",
          type: "oauth",
          authorize: async () => {
            const result = await startCursorOAuth()
            return {
              url: result.url,
              instructions: result.instructions,
              method: "auto" as const,
              callback: result.callback,
            }
          },
        },
        {
          label: "Import existing Cursor session",
          type: "oauth",
          authorize: async () => {
            const found = await readCliConfig()
            if (!found) {
              throw new Error(
                "No existing Cursor session found. Run `cursor-agent login` first, or use the browser login above.",
              )
            }
            const tokens = cliConfigToOAuth(found.config)
            if (!tokens.access) {
              throw new Error("Existing Cursor config is missing an access token.")
            }
            return {
              url: CURSOR_LOGIN_URL,
              instructions: "Importing your existing Cursor session...",
              method: "auto" as const,
              callback: async () => ({
                type: "success" as const,
                access: tokens.access,
                refresh: tokens.refresh,
                expires: tokens.expires,
              }),
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
