/**
 * The gadget runtime: what `Gadget.create` returns and `nikcli-gadget run` drives.
 *
 * One gadget is one paired device with a command set, an optional display and
 * optional buttons. The runtime sends hello on every connect, holds the feed
 * open, runs one invocation at a time (the bridge serializes them too, so a
 * second one here is a bug on the other end, not a case to handle), posts
 * results, and reconnects with bounded backoff when the feed drops.
 */
import { arch, platform, hostname } from "node:os"
import {
  GadgetError,
  LIMITS,
  PROTOCOL_VERSION,
  parseHello,
  slugify,
  treeProblem,
  type CommandSpec,
  type DisplaySpec,
  type Frame,
  type Hello,
  type JsonSchema,
  type MessageResponse,
  type Tree,
} from "./protocol.ts"
import { Transport, backoff } from "./transport.ts"
import { fingerprint, readPairing, writePairing, type PairingState } from "./state.ts"
import * as system from "./commands/system.ts"
import * as file from "./commands/file.ts"
import * as health from "./commands/health.ts"
import { unpackBitmap, type Display } from "./display/index.ts"
import type { Button } from "./button/index.ts"

/** A feed that stayed up this long counts as a good connection and resets the backoff. */
const STABLE_MS = 10_000

export const SDK_VERSION = "1.427.0"

export interface CommandContext {
  /** Aborted when the command's time is up. Pass it to anything that can hang. */
  readonly signal: AbortSignal
  readonly deadline: number
  readonly maxOutputBytes: number
  readonly callID: string
  readonly env: NodeJS.ProcessEnv
  readonly log: (message: string) => void
}

export type CommandResult = string | { output: string; exitCode?: number; isError?: boolean; truncated?: boolean }

export type CommandHandler<Args = Record<string, unknown>> = (args: Args, ctx: CommandContext) => Promise<CommandResult>

export interface CommandDefinition<Args = Record<string, unknown>> {
  readonly description: string
  readonly args: JsonSchema
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly run: CommandHandler<Args>
}

export interface GadgetOptions {
  /** Shown in nikcli; its slug is the device id. Defaults to the hostname. */
  readonly name?: string
  readonly version?: string
  /** `system.run`, `file.read`, `file.write` and `device.health` are included unless false. */
  readonly builtins?: boolean
  /** Directories `file.read`/`file.write` may touch. Absent means anywhere the account can. */
  readonly fileRoots?: readonly string[]
  readonly commands?: Readonly<Record<string, CommandDefinition<any>>>
  readonly display?: Display
  readonly buttons?: Button
  readonly audio?: boolean
  /** Called with the text of a `message` frame when there is no display to show it on. */
  readonly onMessage?: (text: string, sessionID?: string) => void
  readonly log?: (message: string) => void
  readonly fetch?: typeof globalThis.fetch
}

export interface RunOptions {
  readonly signal?: AbortSignal
  /** Override the stored pairing (tests, or a gadget run from a config file). */
  readonly pairing?: PairingState
}

export class Gadget {
  readonly name: string
  readonly version: string
  readonly commands: ReadonlyMap<string, CommandDefinition<any>>
  readonly display: Display | undefined
  readonly buttons: Button | undefined
  readonly audio: boolean
  private readonly log: (message: string) => void
  private readonly onMessage: ((text: string, sessionID?: string) => void) | undefined
  private readonly fetchImpl: typeof globalThis.fetch | undefined
  private transport: Transport | undefined
  private pairing: PairingState | undefined

  constructor(options: GadgetOptions = {}) {
    this.name = (options.name ?? hostname()).trim() || "gadget"
    this.version = options.version ?? SDK_VERSION
    this.display = options.display
    this.buttons = options.buttons
    this.audio = options.audio ?? false
    this.log = options.log ?? ((message) => console.error(`[nikcli-gadget] ${message}`))
    this.onMessage = options.onMessage
    this.fetchImpl = options.fetch
    const commands = new Map<string, CommandDefinition<any>>()
    if (options.builtins !== false) {
      commands.set(system.spec.name, { ...system.spec, run: system.run })
      commands.set(file.readSpec.name, { ...file.readSpec, run: file.read(options.fileRoots) })
      commands.set(file.writeSpec.name, { ...file.writeSpec, run: file.write(options.fileRoots) })
      commands.set(health.spec.name, { ...health.spec, run: health.run })
    }
    for (const [name, definition] of Object.entries(options.commands ?? {})) commands.set(name, definition)
    this.commands = commands
    // Validate our own declaration before the bridge does, so a typo in a
    // command name fails at construction with the same message it would get there.
    parseHello(this.declaration("0".repeat(32)))
  }

  /** The declaration the bridge receives on every connect. Reads (and on first use creates) this install's identity. */
  hello(): Hello {
    return this.declaration(fingerprint())
  }

  private declaration(machine: string): Hello {
    const specs: CommandSpec[] = [...this.commands].map(([name, definition]) => ({
      name,
      description: definition.description,
      args: definition.args,
      ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
      ...(definition.maxOutputBytes === undefined ? {} : { maxOutputBytes: definition.maxOutputBytes }),
    }))
    const display: DisplaySpec | undefined = this.display?.spec
    return {
      protocol: PROTOCOL_VERSION,
      name: this.name,
      version: this.version,
      platform: { os: platform(), arch: arch(), machine },
      commands: specs,
      ...(display ? { display } : {}),
      ...(this.buttons ? { buttons: this.buttons.keys } : {}),
      ...(this.audio ? { audio: true } : {}),
    }
  }

  get id(): string {
    return this.pairing?.id ?? slugify(this.name)
  }

  /**
   * Pair with a bridge: trade the code shown by `nikcli` for a token and store
   * it. When the gadget has buttons the bridge waits for one press before it
   * accepts a hello; `confirm` resolves once that press is reported.
   */
  async pair(server: string, code: string, options?: { signal?: AbortSignal }): Promise<PairingState> {
    const transport = new Transport({ server, fetch: this.fetchImpl })
    const response = await transport.pair(
      {
        code: code.trim(),
        name: this.name,
        platform: { os: platform(), arch: arch(), machine: fingerprint() },
        fingerprint: fingerprint(),
        button: this.buttons !== undefined,
        version: this.version,
      },
      options?.signal,
    )
    const state: PairingState = {
      server: transport.server,
      id: response.id,
      token: response.token,
      name: this.name,
      confirmed: !response.confirm,
      pairedAt: Date.now(),
    }
    writePairing(state)
    this.pairing = state
    this.transport = transport.with(response.token)
    if (response.confirm) {
      this.log("pairing needs a button press to finish")
      await this.waitForConfirmPress(options?.signal)
      await this.transport.confirm(options?.signal)
      this.pairing = { ...state, confirmed: true }
      writePairing(this.pairing)
    }
    return this.pairing
  }

  private waitForConfirmPress(signal?: AbortSignal): Promise<void> {
    const buttons = this.buttons
    if (!buttons) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const stop = buttons.start(() => {
        stop()
        resolve()
      })
      signal?.addEventListener(
        "abort",
        () => {
          stop()
          reject(new Error("pairing aborted"))
        },
        { once: true },
      )
    })
  }

  /** Push a message into a session (or start one) without the agent asking first. */
  async send(text: string, sessionID?: string, signal?: AbortSignal): Promise<MessageResponse> {
    const { transport, pairing } = this.connection()
    return transport.message(pairing.id, { text, ...(sessionID ? { sessionID } : {}) }, signal)
  }

  async health() {
    return health.collect()
  }

  private connection(pairing = this.pairing ?? readPairing()) {
    if (!pairing) throw new GadgetError("NotPaired", "this gadget is not paired: run `nikcli-gadget pair` first")
    this.pairing = pairing
    this.transport ??= new Transport({ server: pairing.server, token: pairing.token, fetch: this.fetchImpl })
    return { transport: this.transport, pairing }
  }

  /** Connect, serve the feed, reconnect on failure. Resolves only when `signal` aborts. */
  async run(options: RunOptions = {}): Promise<void> {
    const { transport, pairing } = this.connection(options.pairing)
    const signal = options.signal ?? new AbortController().signal
    const stopButtons = this.buttons?.start((key) => {
      transport
        .event(pairing.id, { kind: "press", key })
        .catch((error: Error) => this.log(`press ${key} not delivered: ${error.message}`))
    })
    let attempt = 0
    try {
      while (!signal.aborted) {
        try {
          await transport.hello(pairing.id, this.hello(), signal)
          this.log(`connected to ${transport.server} as ${pairing.id}`)
          const connected = Date.now()
          await transport.feed(
            pairing.id,
            async (frame) => {
              // One frame going wrong (a display that cannot draw, a handler that throws) must not take the command channel down with it.
              try {
                await this.handle(frame, transport, pairing)
              } catch (error) {
                this.log(`${frame.type} frame failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            },
            signal,
          )
          if (signal.aborted) break
          // A feed that ends by itself right away (two processes sharing one token evict each other) backs off like any failure.
          const stable = Date.now() - connected >= STABLE_MS
          attempt = stable ? 0 : attempt + 1
          const wait = stable ? 0 : backoff(attempt - 1)
          this.log(`feed closed by the bridge; reconnecting${wait ? ` in ${Math.round(wait / 1000)}s` : ""}`)
          if (wait) await sleep(wait, signal)
        } catch (error) {
          if (signal.aborted) break
          if (error instanceof GadgetError && (error.tag === "TokenRevoked" || error.tag === "NotPaired")) {
            this.log(`${error.message}; pair again with \`nikcli-gadget pair\``)
            throw error
          }
          const wait = backoff(attempt++)
          this.log(`${error instanceof Error ? error.message : String(error)}; retrying in ${Math.round(wait / 1000)}s`)
          await sleep(wait, signal)
        }
      }
    } finally {
      stopButtons?.()
    }
  }

  private async handle(frame: Frame, transport: Transport, pairing: PairingState): Promise<void> {
    switch (frame.type) {
      case "hello":
      case "ping":
        return
      case "bye":
        this.log(`bridge said bye: ${frame.reason}`)
        return
      case "message":
        if (this.display && this.display.spec.format === "tree") {
          await this.display.draw(
            {
              type: "Box",
              props: { direction: "column", gap: 1 },
              children: [{ type: "Markdown", props: { text: frame.text } }],
            },
            this.display.spec,
          )
        }
        this.onMessage?.(frame.text, frame.sessionID)
        if (!this.display && !this.onMessage) this.log(`message: ${frame.text}`)
        return
      case "show": {
        if (!this.display) return
        if ("bitmap" in frame) {
          if (!this.display.drawBitmap) {
            this.log(`refusing bitmap frame ${frame.frameID}: the display does not take bitmaps`)
            return
          }
          try {
            await this.display.drawBitmap(unpackBitmap(frame.bitmap))
          } catch (error) {
            this.log(
              `refusing bitmap frame ${frame.frameID}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          return
        }
        const problem = treeProblem(frame.tree)
        if (problem) {
          this.log(`refusing frame ${frame.frameID}: ${problem}`)
          return
        }
        await this.display.draw(frame.tree as Tree, frame.viewport)
        return
      }
      case "invoke": {
        const started = Date.now()
        const result = await this.invoke(frame)
        await transport.result(pairing.id, { callID: frame.callID, ...result }).catch((error: Error) => {
          this.log(`result for ${frame.callID} not delivered after ${Date.now() - started}ms: ${error.message}`)
        })
        return
      }
    }
  }

  /** Run one invocation to a result the bridge accepts; never throws. */
  async invoke(frame: Extract<Frame, { type: "invoke" }>): Promise<Omit<import("./protocol.ts").ResultBody, "callID">> {
    const definition = this.commands.get(frame.command)
    if (!definition) return { output: `unknown command ${frame.command}`, isError: true }
    const controller = new AbortController()
    const remaining = frame.timeoutMs
    if (!Number.isFinite(remaining) || remaining <= 0) return { output: "invalid timeout", isError: true }
    const timer = setTimeout(() => controller.abort(new Error("deadline reached")), remaining)
    const maxOutputBytes = Math.min(definition.maxOutputBytes ?? LIMITS.DEFAULT_OUTPUT_BYTES, LIMITS.MAX_OUTPUT_BYTES)
    try {
      const value = await definition.run(frame.args ?? {}, {
        signal: controller.signal,
        deadline: Date.now() + remaining,
        maxOutputBytes,
        callID: frame.callID,
        env: process.env,
        log: this.log,
      })
      const result = typeof value === "string" ? { output: value } : value
      const encoded = Buffer.from(result.output, "utf8")
      if (encoded.byteLength > maxOutputBytes) {
        return {
          ...result,
          output:
            encoded.subarray(0, maxOutputBytes).toString("utf8") + `\n[output truncated at ${maxOutputBytes} bytes]`,
          truncated: true,
        }
      }
      return result
    } catch (error) {
      if (controller.signal.aborted) return { output: `command aborted at its deadline`, isError: true, exitCode: 124 }
      return { output: error instanceof Error ? error.message : String(error), isError: true }
    } finally {
      clearTimeout(timer)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}
