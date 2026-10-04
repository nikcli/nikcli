/**
 * The gadget registry: who is paired, who is online, and what is in flight.
 *
 * Pure logic with no sockets, so every rule in the spec has a test that does
 * not need a network: the pairing window, the token that is hashed at rest and
 * bound to a fingerprint, the one-at-a-time invocation queue with its deadline,
 * the message rate limit. `bridge.ts` puts HTTP in front of it.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { renderBitmap } from "@nikcli-ai/gadget/display"
import {
  GadgetError,
  LIMITS,
  TOKEN_PREFIX,
  parseHello,
  slugify,
  treeProblem,
  type Frame,
  type GadgetInfo,
  type Hello,
  type InvokeRequest,
  type InvokeResult,
  type PairRequest,
  type PairResponse,
  type PairWindow,
  type Platform,
  type ResultBody,
  type Tree,
} from "@nikcli-ai/gadget/protocol"

/** Where the bridge pushes frames. `send` returns false when the feed is too far behind to take it. */
export interface Feed {
  send(frame: Frame): boolean
  close(reason: string): void
}

interface DeviceRecord {
  id: string
  name: string
  tokenHash: string
  fingerprint: string
  platform: Platform
  version?: string
  createdAt: number
  confirmed: boolean
  lastSeen?: number
  hello?: Hello
  /** Sessions this device started; the only ones it may continue. Newest last, capped. */
  sessions?: string[]
}

interface Persisted {
  devices: DeviceRecord[]
  revoked: string[]
}

interface Pending {
  readonly callID: string
  readonly command: string
  readonly args: Record<string, unknown>
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly resolve: (result: InvokeResult) => void
  readonly reject: (error: GadgetError) => void
  started?: number
  timer?: ReturnType<typeof setTimeout>
}

interface Live {
  feed: Feed
  current?: Pending
  queue: Pending[]
}

export interface RegistryOptions {
  /** JSON file holding paired devices; absent keeps everything in memory. */
  readonly file?: string
  readonly now?: () => number
  /** Where a pairing client should point, shown with the code. */
  readonly url?: () => string
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class Registry {
  private readonly records = new Map<string, DeviceRecord>()
  private readonly revoked = new Set<string>()
  private readonly live = new Map<string, Live>()
  /** Message times per device. Kept here, not on the live feed: a device that sends with no feed open is the common case. */
  private readonly messageTimes = new Map<string, number[]>()
  /** Devices whose hello was accepted by this process. The stored declaration survives a restart; the proof of the fingerprint does not. */
  private readonly greeted = new Set<string>()
  private window: { code: string; expiresAt: number; failures: number } | undefined
  private readonly now: () => number
  private readonly file: string | undefined
  private readonly urlOf: () => string
  private sequence = 0

  constructor(options: RegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.file = options.file
    this.urlOf = options.url ?? (() => "")
    this.load()
  }

  // -------------------------------------------------------------- storage

  private load() {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>
      for (const record of raw.devices ?? []) {
        if (typeof record?.id === "string" && typeof record.tokenHash === "string") this.records.set(record.id, record)
      }
      for (const entry of raw.revoked ?? []) if (typeof entry === "string") this.revoked.add(entry)
    } catch {
      // A corrupt file reads as "nobody is paired": devices pair again, which is the safe direction.
    }
  }

  private save() {
    if (!this.file) return
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const body: Persisted = { devices: [...this.records.values()], revoked: [...this.revoked].slice(-512) }
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  // -------------------------------------------------------------- pairing

  /** Open a pairing window and return its code. A new window replaces an open one. */
  openPairing(): PairWindow {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0")
    this.window = { code, expiresAt: this.now() + LIMITS.PAIR_WINDOW_MS, failures: 0 }
    return { code, expiresAt: this.window.expiresAt, url: this.urlOf() }
  }

  get pairing(): { open: boolean; expiresAt?: number } {
    if (!this.window || this.window.expiresAt <= this.now()) return { open: false }
    return { open: true, expiresAt: this.window.expiresAt }
  }

  closePairing() {
    this.window = undefined
  }

  /** Trade the code for a token. The code is single use; five wrong guesses close the window. */
  pair(request: PairRequest): PairResponse {
    const window = this.window
    if (!window || window.expiresAt <= this.now()) {
      this.window = undefined
      throw new GadgetError("PairingClosed", "no pairing window is open: ask nikcli to pair a gadget first")
    }
    if (typeof request?.code !== "string" || !same(request.code.trim(), window.code)) {
      window.failures++
      if (window.failures >= 5) this.window = undefined
      throw new GadgetError("PairingClosed", "wrong pairing code")
    }
    if (typeof request.name !== "string" || !request.name.trim())
      throw new GadgetError("BadRequest", "name is required")
    if (typeof request.fingerprint !== "string" || request.fingerprint.length < 8 || request.fingerprint.length > 128) {
      throw new GadgetError("BadRequest", "fingerprint must be 8-128 characters")
    }
    const platform = request.platform
    if (!platform || typeof platform.os !== "string" || typeof platform.arch !== "string") {
      throw new GadgetError("BadRequest", "platform.os and platform.arch are required")
    }
    this.window = undefined

    // The same machine pairing again replaces its record: a fresh token, the same id.
    const existing = [...this.records.values()].find((record) => record.fingerprint === request.fingerprint)
    if (existing) this.dropLive(existing.id, "re-paired")
    const id = existing?.id ?? this.freeID(slugify(request.name))
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`
    const confirm = request.button === true
    const record: DeviceRecord = {
      id,
      name: request.name.trim(),
      tokenHash: hash(token),
      fingerprint: request.fingerprint,
      platform: { os: platform.os, arch: platform.arch, ...(platform.machine ? { machine: platform.machine } : {}) },
      ...(request.version ? { version: request.version } : {}),
      createdAt: this.now(),
      confirmed: !confirm,
    }
    if (existing) this.revoked.add(existing.tokenHash)
    this.records.set(id, record)
    this.save()
    return { id, token, confirm }
  }

  private freeID(base: string): string {
    if (!this.records.has(base)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base.slice(0, 58)}-${n}`
      if (!this.records.has(candidate)) return candidate
    }
  }

  /** The button was pressed: the device may now say hello. */
  confirm(id: string) {
    const record = this.require(id)
    record.confirmed = true
    this.save()
  }

  // ----------------------------------------------------------------- auth

  /** The device a bearer token belongs to. Throws `TokenRevoked` or `NotPaired`. */
  authenticate(token: string | undefined): DeviceRecord {
    if (!token || !token.startsWith(TOKEN_PREFIX)) throw new GadgetError("NotPaired", "a gadget token is required")
    const digest = hash(token)
    for (const record of this.records.values()) {
      if (same(record.tokenHash, digest)) return record
    }
    if (this.revoked.has(digest)) throw new GadgetError("TokenRevoked", "this token was revoked: pair the gadget again")
    throw new GadgetError("NotPaired", "unknown token: pair the gadget first")
  }

  private require(id: string): DeviceRecord {
    const record = this.records.get(id)
    if (!record) throw new GadgetError("NotPaired", `no gadget named ${id}`)
    return record
  }

  // ---------------------------------------------------------------- hello

  /** Replace a device's declaration. A bad hello leaves the previous one in place. */
  hello(id: string, value: unknown): Hello {
    const record = this.require(id)
    if (!record.confirmed) throw new GadgetError("Unconfirmed", "press the gadget's button to finish pairing first")
    const hello = parseHello(value)
    // Required, not only checked when present. The fingerprint identifies a device; it does not authenticate one (a MAC-derived
    // value is guessable on a LAN, and whoever can read the token can read the identity file), so this notices a token copied to
    // another machine by mistake, not a determined thief. A thief is stopped by revoking the token.
    if (hello.platform.machine === undefined || !same(hello.platform.machine, record.fingerprint)) {
      throw new GadgetError("Denied", "this hello does not carry the fingerprint the gadget paired with")
    }
    this.greeted.add(id)
    record.hello = hello
    record.name = hello.name
    record.platform = hello.platform
    record.version = hello.version
    record.lastSeen = this.now()
    this.save()
    return hello
  }

  // ----------------------------------------------------------------- feed

  /** Attach the device's feed. Returns the detach function the transport calls on close. */
  attach(id: string, feed: Feed): () => void {
    const record = this.require(id)
    if (!record.hello || !this.greeted.has(id))
      throw new GadgetError("HelloInvalid", "send hello before opening the feed")
    this.dropLive(id, "replaced by a newer connection")
    const live: Live = { feed, queue: [] }
    this.live.set(id, live)
    record.lastSeen = this.now()
    feed.send({ type: "hello", id, time: this.now() })
    return () => {
      if (this.live.get(id) === live) this.detach(id, "feed closed")
    }
  }

  /** Tear down a device's live state, failing everything waiting on it. */
  private dropLive(id: string, reason: string) {
    const live = this.live.get(id)
    if (!live) return
    this.detach(id, reason)
    try {
      live.feed.close(reason)
    } catch {
      // The transport is already gone.
    }
  }

  private detach(id: string, reason: string) {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    const error = new GadgetError("Offline", `${id} went offline: ${reason}`)
    for (const pending of [live.current, ...live.queue]) {
      if (!pending) continue
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    live.current = undefined
    live.queue = []
  }

  online(id: string): boolean {
    return this.live.has(id)
  }

  /** Push a frame; a feed that cannot take it is evicted and everything waiting on it fails. */
  private push(id: string, frame: Frame): void {
    const live = this.live.get(id)
    if (!live) throw new GadgetError("Offline", `${id} is offline`)
    const limit = this.records.get(id)?.hello?.maxFrameBytes
    if (limit !== undefined && frame.type !== "ping" && frame.type !== "hello" && frame.type !== "bye") {
      const size = Buffer.byteLength(JSON.stringify(frame))
      if (size > limit) {
        // Refused here, before it is sent: a device cannot answer a frame it had no room to read, and the call would sit until its timeout.
        throw new GadgetError(
          "PayloadTooLarge",
          `${id} takes frames up to ${limit} bytes (its buffer) and this ${frame.type} needs ${size}`,
        )
      }
    }
    if (!live.feed.send(frame)) {
      this.dropLive(id, "feed fell behind")
      throw new GadgetError("Offline", `${id} fell behind and was disconnected`)
    }
  }

  /** Send a keep-alive to every online device; evicts the ones that cannot take it. */
  ping() {
    for (const id of [...this.live.keys()]) {
      try {
        this.push(id, { type: "ping", time: this.now() })
      } catch {
        // push() already dropped it.
      }
    }
  }

  // ---------------------------------------------------------- invocations

  /**
   * Run a command on a device and wait for its result. One command is in
   * flight per device; up to `QUEUE_DEPTH` wait behind it. The deadline starts
   * when the command is sent, not when it was queued.
   */
  invoke(id: string, request: InvokeRequest): Promise<InvokeResult> {
    const record = this.require(id)
    const live = this.live.get(id)
    if (!live || !record.hello) return Promise.reject(new GadgetError("Offline", `${id} is offline`))
    const spec = record.hello.commands.find((item) => item.name === request.command)
    if (!spec) {
      return Promise.reject(
        new GadgetError(
          "CommandUnknown",
          `${id} does not declare ${request.command} (it has ${record.hello.commands.map((c) => c.name).join(", ") || "none"})`,
        ),
      )
    }
    if (live.queue.length >= LIMITS.QUEUE_DEPTH) {
      return Promise.reject(
        new GadgetError("Busy", `${id} has ${LIMITS.QUEUE_DEPTH} commands waiting`, { retryAfterMs: 1_000 }),
      )
    }
    const timeoutMs = Math.min(request.timeoutMs ?? spec.timeoutMs ?? LIMITS.DEFAULT_TIMEOUT_MS, LIMITS.MAX_TIMEOUT_MS)
    return new Promise<InvokeResult>((resolve, reject) => {
      const pending: Pending = {
        callID: `call_${randomBytes(8).toString("hex")}`,
        command: request.command,
        args: request.args ?? {},
        timeoutMs,
        maxOutputBytes: Math.min(spec.maxOutputBytes ?? LIMITS.DEFAULT_OUTPUT_BYTES, LIMITS.MAX_OUTPUT_BYTES),
        resolve,
        reject,
      }
      live.queue.push(pending)
      this.pump(id)
    })
  }

  private pump(id: string) {
    const live = this.live.get(id)
    if (!live || live.current) return
    const next = live.queue.shift()
    if (!next) return
    live.current = next
    next.started = this.now()
    next.timer = setTimeout(() => {
      if (live.current !== next) return
      live.current = undefined
      next.reject(new GadgetError("Timeout", `${next.command} on ${id} did not answer within ${next.timeoutMs} ms`))
      this.pump(id)
    }, next.timeoutMs)
    try {
      this.push(id, {
        type: "invoke",
        callID: next.callID,
        command: next.command,
        args: next.args,
        timeoutMs: next.timeoutMs,
      })
    } catch (error) {
      if (!(error instanceof GadgetError)) throw error
      if (error.tag === "PayloadTooLarge" && live.current === next) {
        // The device is fine; this one call does not fit its buffer. Fail it and carry on with the queue.
        if (next.timer) clearTimeout(next.timer)
        live.current = undefined
        next.reject(error)
        this.pump(id)
      }
      // Any other failure dropped the device, which already rejected `next` through detach().
    }
  }

  /** A device's answer. One for a call that was already dropped (timed out, device gone) is discarded. */
  result(id: string, body: ResultBody): boolean {
    this.require(id)
    const live = this.live.get(id)
    const pending = live?.current
    if (!live || !pending || pending.callID !== body.callID) return false
    if (pending.timer) clearTimeout(pending.timer)
    live.current = undefined
    let output = typeof body.output === "string" ? body.output : ""
    let truncated = body.truncated === true
    const bytes = Buffer.byteLength(output)
    if (bytes > pending.maxOutputBytes) {
      output = Buffer.from(output).subarray(0, pending.maxOutputBytes).toString("utf8")
      truncated = true
    }
    pending.resolve({
      callID: pending.callID,
      output,
      ...(typeof body.exitCode === "number" ? { exitCode: body.exitCode } : {}),
      isError: body.isError === true,
      truncated,
      durationMs: this.now() - (pending.started ?? this.now()),
    })
    this.pump(id)
    return true
  }

  // ----------------------------------------------------- show and message

  /** Put a tree on the device's display. Returns the frame id. */
  show(id: string, tree: unknown): string {
    const record = this.require(id)
    const display = record.hello?.display
    if (!display) throw new GadgetError("CommandUnknown", `${id} has no display`)
    const problem = treeProblem(tree)
    if (problem) throw new GadgetError("PayloadTooLarge", `tree refused: ${problem}`)
    const frameID = `frame_${randomBytes(6).toString("hex")}`
    if (display.format === "bitmap") {
      // The panel has no layout engine: the bridge lays the tree out and sends pixels.
      let bitmap
      try {
        bitmap = renderBitmap(tree as Tree, display)
      } catch (error) {
        throw new GadgetError(
          "BadRequest",
          `tree could not be laid out: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.push(id, { type: "show", frameID, bitmap })
      return frameID
    }
    this.push(id, {
      type: "show",
      frameID,
      tree: tree as Tree,
      viewport: { columns: display.columns, rows: display.rows },
    })
    return frameID
  }

  /** Send text to the device (shown on its display, or logged). */
  tell(id: string, text: string, sessionID?: string) {
    this.require(id)
    this.push(id, { type: "message", text, ...(sessionID ? { sessionID } : {}) })
  }

  /** Account one message a device pushes into a session; throws `RateLimited` over the budget. */
  admitMessage(id: string, text: string) {
    this.require(id)
    if (typeof text !== "string" || !text.trim()) throw new GadgetError("BadRequest", "text is required")
    if (Buffer.byteLength(text) > LIMITS.TREE_MAX_TEXT * 2)
      throw new GadgetError("PayloadTooLarge", "message is too long")
    const now = this.now()
    const times = (this.messageTimes.get(id) ?? []).filter((at) => now - at < 60_000)
    if (times.length >= LIMITS.MESSAGE_RATE_PER_MIN) {
      const retryAfterMs = Math.max(1, 60_000 - (now - times[0]!))
      throw new GadgetError("RateLimited", `more than ${LIMITS.MESSAGE_RATE_PER_MIN} messages a minute`, {
        retryAfterMs,
      })
    }
    times.push(now)
    this.messageTimes.set(id, times)
  }

  /** Whether `sessionID` is one this device started. A device may continue only those. */
  ownsSession(id: string, sessionID: string): boolean {
    return this.require(id).sessions?.includes(sessionID) ?? false
  }

  /** Remember a session this device started. */
  rememberSession(id: string, sessionID: string) {
    const record = this.require(id)
    const sessions = (record.sessions ?? []).filter((existing) => existing !== sessionID)
    sessions.push(sessionID)
    record.sessions = sessions.slice(-50)
    this.save()
  }

  // ---------------------------------------------------------------- admin

  list(): GadgetInfo[] {
    return [...this.records.values()].map((record) => this.info(record))
  }

  get(id: string): GadgetInfo {
    return this.info(this.require(id))
  }

  private info(record: DeviceRecord): GadgetInfo {
    const hello = record.hello
    return {
      id: record.id,
      name: record.name,
      online: this.live.has(record.id),
      confirmed: record.confirmed,
      platform: record.platform,
      ...(record.version ? { version: record.version } : {}),
      commands: hello?.commands ?? [],
      ...(hello?.display ? { display: hello.display } : {}),
      ...(hello?.buttons ? { buttons: hello.buttons } : {}),
      ...(hello?.audio ? { audio: true } : {}),
      createdAt: record.createdAt,
      ...(record.lastSeen ? { lastSeen: record.lastSeen } : {}),
    }
  }

  /** Remove a device and revoke its token; its feed gets a goodbye. */
  revoke(id: string) {
    const record = this.require(id)
    const live = this.live.get(id)
    if (live) {
      try {
        live.feed.send({ type: "bye", reason: "revoked" })
      } catch {
        // Already closing.
      }
    }
    this.dropLive(id, "revoked")
    this.records.delete(id)
    this.messageTimes.delete(id)
    this.greeted.delete(id)
    this.revoked.add(record.tokenHash)
    this.save()
  }

  /** Stop everything: close every feed. The records stay on disk. */
  shutdown() {
    for (const id of [...this.live.keys()]) this.dropLive(id, "bridge stopping")
  }
}
