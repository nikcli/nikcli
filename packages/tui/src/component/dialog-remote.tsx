import { useScrollAcceleration } from "@tui/util/scroll"
import { createMemo, createSignal, Show, For, onCleanup, onMount } from "solid-js"
import { pipe } from "remeda"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { connectToTerminal, generateQRMatrix, type TunnelProvider, type TerminalConnection } from "@nikcli-ai/remote"
import { QRCode, useQRRepaint } from "@tui/component/qr"
import { remoteService, type RemoteSession } from "@nikcli-ai/util/remote-tunnel"

interface RemoteConfig {
  enableTunnel?: boolean
  provider?: string
}

interface ConfigWithRemote {
  remote?: RemoteConfig
}

const REMOTE_BRIDGE_MARKER = "__nikcliRemoteBridge"

interface Device {
  id: string
  name: string
  connectedAt: Date
}

/**
 * `props`, not `{ connection }`.
 *
 * Destructuring reads the prop once, at call time, and this one is handed
 * `terminalConnection()!` — a signal. A reconnect replaces the connection and
 * the view would go on reading, writing and closing the dead one, which is the
 * failure that looks like the terminal simply stopping.
 */
function TerminalView(props: { connection: TerminalConnection }) {
  const [output, setOutput] = createSignal<string[]>([
    "Connected to NikCLI remote terminal",
    "Type 'q' to disconnect",
    "",
  ])
  const [input, setInput] = createSignal("")

  onMount(() => {
    const run = async () => {
      for await (const chunk of props.connection.output) {
        setOutput((prev) => [...prev, chunk])
      }
    }
    run()
  })

  const handleKey = (key: string) => {
    if (key === "\r") {
      props.connection.write(input() + "\n")
      setOutput((prev) => [...prev, `> ${input()}`])
      setInput("")
    } else if (key === "\x7f") {
      setInput((prev) => prev.slice(0, -1))
    } else if (key === "q") {
      props.connection.close()
    } else if (key.length === 1) {
      setInput((prev) => prev + key)
    }
  }

  useKeyboard((evt) => {
    if (evt.ctrl || evt.meta) return
    if (evt.name === "return") {
      handleKey("\r")
      return
    }
    if (evt.name === "backspace") {
      handleKey("\x7f")
      return
    }
    if (evt.sequence && evt.sequence.length === 1) {
      handleKey(evt.sequence)
    }
  })

  return (
    <box flexDirection="column">
      <box border={["top", "bottom", "left", "right"]} borderColor="blue" padding={1} flexGrow={1}>
        <box flexDirection="column">
          <For each={output().slice(-30)}>{(line) => <text fg="white">{line}</text>}</For>
        </box>
      </box>
      <box marginTop={1}>
        <text fg="gray">{"> "}</text>
        <text fg="white">{input()}</text>
        <text fg="gray">_</text>
      </box>
      <text fg="gray" marginTop={1}>
        Press keys to type, Enter to send, 'q' to disconnect
      </text>
    </box>
  )
}

export function DialogRemote() {
  const sync = useSync()
  const scrollAcceleration = useScrollAcceleration()
  const sdk = useSDK()
  const toast = useToast()
  const renderer = useRenderer()
  const [query, setQuery] = createSignal("")
  // The matrix, not the ASCII art: rendering re-parsed half-block text lost the
  // half that each glyph encodes, so every `▀` came out as a full dark module
  // and the symbol could not be scanned.
  const [qrData, setQrData] = createSignal<boolean[][]>()
  useQRRepaint(qrData)
  const [sessionInfo, setSessionInfo] = createSignal<{ url: string; localUrl: string; port: number } | null>(null)
  const [isStarting, setIsStarting] = createSignal(false)
  const [devices, setDevices] = createSignal<Device[]>([])
  const [terminalConnection, setTerminalConnection] = createSignal<TerminalConnection | null>(null)
  let cleanupListeners: (() => void) | null = null
  let detachRendererBridge: (() => void) | null = null

  const currentRemote = () => (sync.data.config as ConfigWithRemote | undefined)?.remote

  const providers = [
    { id: "localtunnel", name: "Localtunnel", description: "Quick tunnel via localtunnel.me" },
    { id: "cloudflared", name: "Cloudflared", description: "Cloudflare tunnel (requires cloudflared CLI)" },
    { id: "ngrok", name: "Ngrok", description: "Ngrok tunnel (requires ngrok auth token)" },
    { id: "remotosh", name: "Remotosh", description: "Remotosh tunnel (requires remotosh CLI)" },
    { id: "none", name: "Local Only", description: "No tunnel - use local network IP" },
  ]

  onCleanup(() => {
    cleanupListeners?.()
    cleanupListeners = null
    detachRendererBridge?.()
    detachRendererBridge = null
  })

  const startRemoteSession = async () => {
    setIsStarting(true)
    try {
      if (!remoteService.isInitialized()) {
        await remoteService.init()
      }

      if (remoteService.hasActiveSession()) {
        const existing = remoteService.getSession()
        if (existing) {
          syncSessionInfo(existing)
        }
        toast.show({ message: "Remote session already active", variant: "info" })
        return
      }

      const enableTunnel = currentRemote()?.enableTunnel ?? true
      const configuredProvider = currentRemote()?.provider as TunnelProvider | undefined
      const tunnelProvider = configuredProvider || "localtunnel"
      const useTunnel = enableTunnel && tunnelProvider !== "none"
      const session = await remoteService.startSession()
      attachRendererBridge()
      renderer.requestRender()
      let sessionUrl = buildSessionUrl(session, session.localUrl || session.qrUrl)

      if (useTunnel) {
        const provider = await remoteService.createSessionTunnel({
          enableTunnel: true,
          provider: configuredProvider,
        })

        if (!provider) {
          toast.show({ message: "No tunnel providers available; using local network only", variant: "warning" })
        } else {
          sessionUrl = session.tunnelUrl || session.qrUrl
        }
      }

      session.qrUrl = sessionUrl
      syncSessionInfo(session)
      try {
        attachRemoteListeners()
      } catch (e) {
        console.error("Failed to attach remote listeners:", e)
        toast.show({ message: "Session started but listener attachment failed", variant: "warning" })
      }

      toast.show({ message: "Remote session started", variant: "success" })
    } catch (e) {
      stopRemoteSession({ silent: true })
      toast.show({ message: `Failed to start remote session: ${e}`, variant: "error" })
    } finally {
      setIsStarting(false)
    }
  }

  const stopRemoteSession = (options: { silent?: boolean } = {}) => {
    if (terminalConnection()) {
      terminalConnection()!.close()
      setTerminalConnection(null)
    }
    detachRendererBridge?.()
    detachRendererBridge = null
    if (remoteService.hasActiveSession()) {
      remoteService.stopSession().catch(() => {})
    }
    setQrData(undefined)
    setSessionInfo(null)
    setDevices([])
    cleanupListeners?.()
    cleanupListeners = null
    if (!options.silent) {
      toast.show({ message: "Remote session stopped", variant: "info" })
    }
  }

  const viewDeviceTerminal = async () => {
    const info = sessionInfo()
    if (!info?.localUrl) return

    try {
      const secret = remoteService.getSessionSecret()
      const wsUrl = buildWsUrl(info)
      const conn = await connectToTerminal(wsUrl, secret)
      setTerminalConnection(conn)
      toast.show({ message: "Terminal connected", variant: "success" })
    } catch (e) {
      toast.show({ message: `Failed to connect to device: ${e}`, variant: "error" })
    }
  }

  const options = createMemo(() => {
    const q = query().trim().toLowerCase()
    const needle = q

    const allOptions = [
      {
        value: { action: "start" },
        title: qrData() ? "Stop Remote Session" : "Start Remote Session",
        description: qrData() ? "Session active" : "Start server and show QR code",
        category: "Remote",
        disabled: isStarting(),
        onSelect: async () => {
          if (qrData()) {
            stopRemoteSession()
          } else {
            await startRemoteSession()
          }
        },
      },
      ...devices().map((device) => ({
        value: { deviceID: device.id },
        title: device.name,
        description: `Connected at ${device.connectedAt.toLocaleTimeString()}`,
        category: "Devices",
        onSelect: () => viewDeviceTerminal(),
      })),
      ...pipe(
        providers,
        (providers) =>
          providers.filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle)),
        (providers) =>
          providers.map((provider) => {
            const isCurrent = provider.id === currentRemote()?.provider
            return {
              value: { providerID: provider.id },
              title: provider.name,
              description: provider.description,
              category: "Tunnel Provider",
              disabled: isCurrent,
              onSelect: async () => {
                const { error } = await sdk.client.config.update({
                  payload: { remote: { provider: provider.id, enableTunnel: provider.id !== "none" } } as any,
                })
                if (error) {
                  toast.show({ message: "Failed to update remote config", variant: "error" })
                  return
                }
                toast.show({ message: "Remote config updated", variant: "success" })
              },
            }
          }),
      ),
    ]

    return allOptions
  })

  return (
    <box flexDirection="column">
      <Show when={isStarting()}>
        <text fg="yellow">Starting remote session...</text>
      </Show>
      <Show when={terminalConnection()}>
        <TerminalView connection={terminalConnection()!} />
      </Show>
      <Show when={!terminalConnection() && !qrData()}>
        <DialogSelect onFilter={setQuery} skipFilter={true} title="Remote Control" options={options() as any} />
      </Show>
      <Show when={!terminalConnection() && qrData()}>
        <box border={["top", "bottom", "left", "right"]} borderColor="green" padding={1}>
          <box flexDirection="row" gap={2}>
            <box flexDirection="column" width={50}>
              <text attributes={TextAttributes.BOLD} fg="green">
                Remote Session Active
              </text>
              <scrollbox
                scrollAcceleration={scrollAcceleration()}
                flexDirection="column"
                maxHeight={3}
                scrollbarOptions={{ visible: false }}
              >
                <text fg="cyan">{sessionInfo()?.url}</text>
              </scrollbox>
              <text fg="gray">Local: {sessionInfo()?.localUrl}</text>
              <box marginTop={1}>
                <text fg="gray">Devices connected: {devices().length}</text>
              </box>
              <box marginTop={1}>
                <text fg="gray">Scan QR or open URL on phone</text>
              </box>
              <box marginTop={1}>
                <text fg="gray">Press 'q' to stop</text>
              </box>
            </box>
            <QRCode matrix={qrData()!} />
          </box>
        </box>
      </Show>
    </box>
  )

  function attachRemoteListeners() {
    cleanupListeners?.()

    const onConnected = (session: RemoteSession, device: any) => {
      setDevices((prev) => [
        ...prev,
        { id: device.id, name: device.name || device.userAgent || "Unknown", connectedAt: new Date() },
      ])
      if (session) {
        syncSessionInfo(session)
      }
      toast.show({ message: `Device connected: ${device.name || device.id}`, variant: "success" })
    }

    const onDisconnected = (session: RemoteSession, device: any) => {
      setDevices((prev) => prev.filter((d) => d.id !== device.id))
      if (session) {
        syncSessionInfo(session)
      }
      toast.show({ message: "Device disconnected", variant: "info" })
    }

    const onStopped = () => {
      stopRemoteSession({ silent: true })
    }

    remoteService.on("device:connected", onConnected)
    remoteService.on("device:disconnected", onDisconnected)
    remoteService.on("session:stopped", onStopped)

    cleanupListeners = () => {
      remoteService.off("device:connected", onConnected)
      remoteService.off("device:disconnected", onDisconnected)
      remoteService.off("session:stopped", onStopped)
    }
  }

  function attachRendererBridge() {
    if (detachRendererBridge || !renderer) return
    const target = renderer as unknown as {
      realStdoutWrite?: typeof process.stdout.write
      stdout?: NodeJS.WriteStream
    }
    const stdout = target.stdout ?? process.stdout
    const forward = (data: string | Uint8Array) => {
      const text = typeof data === "string" ? data : Buffer.from(data).toString()
      remoteService.writeToTerminal(text)
    }

    const originalReal = target.realStdoutWrite
    if (originalReal) {
      if ((originalReal as any)[REMOTE_BRIDGE_MARKER]) return

      const bridge = ((
        data: string | Uint8Array,
        encoding?: BufferEncoding | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
      ) => {
        const result =
          typeof encoding === "function"
            ? (originalReal as any).call(stdout, data, encoding)
            : (originalReal as any).call(stdout, data, encoding, cb)
        forward(data)
        return result
      }) as typeof stdout.write
      ;(bridge as any)[REMOTE_BRIDGE_MARKER] = true
      target.realStdoutWrite = bridge

      detachRendererBridge = () => {
        target.realStdoutWrite = originalReal
        detachRendererBridge = null
      }
      return
    }

    const base = stdout.write
    if ((base as any)[REMOTE_BRIDGE_MARKER]) return

    const bridge = ((
      data: string | Uint8Array,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ) => {
      const result =
        typeof encoding === "function"
          ? (base as any).call(stdout, data, encoding)
          : (base as any).call(stdout, data, encoding, cb)
      forward(data)
      return result
    }) as typeof stdout.write
    ;(bridge as any)[REMOTE_BRIDGE_MARKER] = true
    stdout.write = bridge

    detachRendererBridge = () => {
      stdout.write = base
      detachRendererBridge = null
    }
  }

  function syncSessionInfo(session: RemoteSession) {
    const url = session.tunnelUrl || session.qrUrl
    generateQRMatrix(url)
      .then((matrix) => {
        setQrData(matrix ?? undefined)
      })
      .catch(() => {
        setQrData(undefined)
      })
    setSessionInfo({
      url,
      localUrl: session.localUrl || session.qrUrl,
      port: session.port ?? remoteService.getServerPort(),
    })
    setDevices(
      (session.connectedDevices || []).map((device) => ({
        id: device.id,
        name: device.userAgent || "Unknown",
        connectedAt: new Date(device.connectedAt),
      })),
    )
  }

  function buildSessionUrl(session: RemoteSession, baseUrl: string) {
    const url = new URL(baseUrl)
    url.searchParams.set("s", session.id)
    const secret = remoteService.getSessionSecret()
    if (secret) {
      url.searchParams.set("t", secret)
    }
    return url.toString()
  }

  function buildWsUrl(info: { localUrl: string; port: number }) {
    if (info.port) {
      return `ws://localhost:${info.port}`
    }
    if (info.localUrl.startsWith("https://")) {
      return info.localUrl.replace(/^https:\/\//, "wss://")
    }
    if (info.localUrl.startsWith("http://")) {
      return info.localUrl.replace(/^http:\/\//, "ws://")
    }
    return info.localUrl
  }
}
