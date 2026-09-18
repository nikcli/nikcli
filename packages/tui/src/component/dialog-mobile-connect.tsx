import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { generateQRMatrix } from "@nikcli-ai/remote"
import { buildMobilePairingDeepLink, getLocalIPs, isLoopbackHostname } from "@nikcli-ai/util/mobile-pairing"
import { DialogHeader, useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { Clipboard } from "@tui/util/clipboard"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { QRCode, qrCanImageFit, qrDialogBudget, qrFittedSize, useQRRepaint } from "@tui/component/qr"
import { createWorkspaceArchive, uploadWorkspaceArchive } from "@nikcli-ai/util/teleport-archive"
import { isPlainShortcut } from "@tui/util/keys"

type Pairing = {
  serverUrl: string
  urls: string[]
  token: string
  tokenID?: string
  deepLink: string
  matrix: boolean[][]
  expiresAt?: number
}

export type MobileDialogMode = "choose" | "cloud" | "local" | "teleport"

type RemoteServerConfig = {
  teleport?: {
    url?: string
    token?: string
  }
}

export function normalizeMobileServerUrl(raw: string): string | null {
  let value = raw.trim()
  if (!value) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return null
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    const pathname = url.pathname.replace(/\/+$/, "").replace(/\/mobile(?:\/teleport)?$/, "")
    return `${url.origin}${pathname}`
  } catch {
    return null
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

function pairingUrls(baseUrl: string): string[] {
  const url = new URL(baseUrl)
  if (!isLoopbackHostname(url.hostname) && url.hostname !== "0.0.0.0" && url.hostname !== "::") {
    return [url.toString().replace(/\/$/, "")]
  }
  return getLocalIPs().map((ip) => {
    const host = ip.includes(":") ? `[${ip}]` : ip
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`
  })
}

function isLikelyIPhoneHotspotUrl(value: string): boolean {
  try {
    const octets = new URL(value).hostname.split(".").map(Number)
    return (
      octets.length === 4 &&
      octets[0] === 172 &&
      octets[1] === 20 &&
      octets[2] === 10 &&
      (octets[3] ?? 0) >= 2 &&
      (octets[3] ?? 0) <= 14
    )
  } catch {
    return false
  }
}

/**
 * Whether to spell the pairing link out next to the QR.
 *
 * Every Windows terminal goes through ConPTY, and a frame there can lose
 * cells (see `shouldForceOverlayRepaint`). The QR is the densest thing the TUI
 * draws, so it is the first casualty — it comes out as a blank white square,
 * with no hint that anything is missing. The link carries the same payload the
 * QR encodes, so printing it keeps pairing possible on a terminal that cannot
 * draw the symbol. It is not shown elsewhere because it puts the pairing token
 * on screen in clear text, and `y` already copies it.
 */
export function shouldShowPairingLink(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
}

function PairingLink(props: { deepLink: string }) {
  const { theme } = useTheme()
  return (
    <Show when={shouldShowPairingLink()}>
      <box marginTop={1} flexDirection="column">
        <text fg={theme.foreground.muted} wrapMode="word">
          If the QR is blank, this terminal could not draw it. Press y to copy the same pairing link and open it on the
          phone:
        </text>
        <text fg={theme.accent.alt} selectable wrapMode="word">
          {props.deepLink}
        </text>
      </box>
    </Show>
  )
}

export function DialogMobileConnect(props: { sessionID?: string; initialMode?: MobileDialogMode }) {
  const [mode, setMode] = createSignal<MobileDialogMode>(props.initialMode ?? "choose")

  const options = createMemo<DialogSelectOption<MobileDialogMode>[]>(() => [
    {
      title: "Connect cloud server",
      value: "cloud",
      description: "Enter a remote nikcli server URL and mobile auth token, then scan its QR code.",
    },
    {
      title: "Connect local server",
      value: "local",
      description: "Start a protected LAN server and create a mobile pairing token automatically.",
    },
    {
      title: "Teleport session",
      value: "teleport",
      description: props.sessionID
        ? "Send the current session and workspace to a remote nikcli server."
        : "Open this dialog from an active session to use Teleport.",
      disabled: !props.sessionID,
    },
  ])

  return (
    <Show
      when={mode() !== "choose"}
      fallback={
        <DialogSelect
          title="Connect Nikcli Mobile"
          options={options()}
          onSelect={(option) => {
            if (!option.disabled) setMode(option.value)
          }}
        />
      }
    >
      <Show when={mode() === "local"}>
        <LocalMobileConnect onBack={() => setMode("choose")} />
      </Show>
      <Show when={mode() === "cloud"}>
        <RemoteServerPanel mode="cloud" onBack={() => setMode("choose")} />
      </Show>
      <Show when={mode() === "teleport" && props.sessionID}>
        <RemoteServerPanel mode="teleport" sessionID={props.sessionID} onBack={() => setMode("choose")} />
      </Show>
    </Show>
  )
}

function RemoteServerPanel(props: { mode: "cloud" | "teleport"; sessionID?: string; onBack: () => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  let urlInput: any
  let tokenInput: any

  const [pairing, setPairing] = createSignal<Pairing>()
  const [form, setForm] = createStore({
    url: "",
    token: "",
    focus: "url" as "url" | "token",
    busy: false,
    status: "",
  })
  const qrBudget = createMemo(() => qrDialogBudget(dimensions().width, dimensions().height))
  const qrFit = createMemo(() =>
    pairing()
      ? qrFittedSize(pairing()!.matrix, qrBudget().columns, qrBudget().rows, {
          image: qrCanImageFit(),
        })
      : { width: 0, height: 0, image: false },
  )
  const stacked = createMemo(() => dimensions().width < qrFit().width + 50)
  const repaintOnQR = useQRRepaint(() => pairing()?.matrix)

  onMount(() => {
    repaintOnQR()
    dialog.setSize(dimensions().width >= 100 ? "xlarge" : "large")
    const saved = (sync.data.config as RemoteServerConfig | undefined)?.teleport
    if (saved?.url) setForm("url", saved.url)
    if (saved?.token) setForm("token", saved.token)
    setTimeout(() => urlInput?.focus?.(), 1)
  })

  function focusField(field: "url" | "token") {
    setForm("focus", field)
    setTimeout(() => (field === "url" ? urlInput : tokenInput)?.focus?.(), 1)
  }

  async function saveRemoteServer(url: string, token: string) {
    await sdk.client.config.update({ payload: { teleport: { url, token } } as any }).catch(() => undefined)
  }

  async function connectCloud() {
    if (form.busy) return
    const base = normalizeMobileServerUrl(form.url)
    if (!base) {
      setForm("status", "Enter a valid HTTP or HTTPS server URL")
      focusField("url")
      return
    }
    const token = form.token.trim()
    if (!token) {
      setForm("status", "Enter a mobile auth token")
      focusField("token")
      return
    }

    setForm("busy", true)
    setForm("status", "Verifying server and mobile token…")
    try {
      const response = await fetch(`${base}/mobile/auth/token`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(
          response.status === 401 || response.status === 403
            ? "Unauthorized — use a mobile-scoped auth token"
            : `Server error ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`,
        )
      }

      const deepLink = buildMobilePairingDeepLink({
        serverUrl: base,
        token,
      })
      const matrix = await generateQRMatrix(deepLink)
      if (!matrix) throw new Error("QR generation is unavailable")
      await saveRemoteServer(base, token)
      setPairing({
        serverUrl: base,
        urls: [base],
        token,
        deepLink,
        matrix,
      })
      setForm("url", base)
      setForm("status", "Server verified — scan with the Nikcli mobile app")
    } catch (cause) {
      setForm("status", cause instanceof Error ? cause.message : String(cause))
    } finally {
      setForm("busy", false)
    }
  }

  async function teleport() {
    if (form.busy || !props.sessionID) return
    const base = normalizeMobileServerUrl(form.url)
    if (!base) {
      setForm("status", "Enter a valid HTTP or HTTPS server URL")
      focusField("url")
      return
    }
    const token = form.token.trim()
    if (!token) {
      setForm("status", "Enter a mobile auth token")
      focusField("token")
      return
    }

    setForm("busy", true)
    setForm("status", "Collecting session…")
    try {
      const [info, messages] = await Promise.all([
        sdk.client.session.get({ sessionID: props.sessionID }).then((response) => response.data),
        sdk.client.session.messages({ sessionID: props.sessionID }).then((response) => response.data ?? []),
      ])
      if (!info) throw new Error("Could not load the current session")

      let uploadID: string | undefined
      if (info.directory) {
        setForm("status", "Archiving workspace…")
        const archive = await createWorkspaceArchive(info.directory).catch(() => null)
        if (archive) {
          const size = formatBytes(archive.bytes)
          try {
            uploadID = await uploadWorkspaceArchive({
              base,
              token,
              archivePath: archive.path,
              onProgress: (sent, total) => {
                const percent = total ? Math.floor((sent / total) * 100) : 100
                setForm("status", `Uploading workspace ${size}… ${percent}%`)
              },
            })
          } finally {
            await archive.cleanup()
          }
        }
      }

      setForm("status", `Teleporting ${messages.length} messages${uploadID ? " + workspace" : ""}…`)
      const response = await fetch(`${base}/mobile/teleport`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: info.title,
          name: info.directory ? info.directory.split(/[\\/]/).filter(Boolean).pop() : undefined,
          origin: sdk.directory,
          permission: info.permission,
          messages,
          uploadID,
        }),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(
          response.status === 401 || response.status === 403
            ? "Unauthorized — use a mobile-scoped auth token"
            : `Server error ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`,
        )
      }

      const result = (await response.json().catch(() => null)) as {
        sessionID?: string
      } | null
      await saveRemoteServer(base, token)
      toast.show({
        message: result?.sessionID ? `Teleported to ${new URL(base).host} — open it on mobile` : "Session teleported",
        variant: "success",
      })
      dialog.clear()
    } catch (cause) {
      setForm("status", cause instanceof Error ? cause.message : "Failed to teleport session")
    } finally {
      setForm("busy", false)
    }
  }

  async function submit() {
    if (props.mode === "cloud") await connectCloud()
    else await teleport()
  }

  async function copyDeepLink() {
    const value = pairing()?.deepLink
    if (!value) return
    await Clipboard.copy(value)
      .then(() => toast.show({ message: "Mobile link copied", variant: "success" }))
      .catch(toast.error)
  }

  useKeyboard((event) => {
    if (event.name === "escape") {
      if (form.busy) return
      props.onBack()
      return
    }
    if (pairing()) {
      if (isPlainShortcut(event, "y")) {
        event.preventDefault()
        void copyDeepLink()
      }
      if (isPlainShortcut(event, "r")) {
        event.preventDefault()
        setPairing(undefined)
        setForm("status", "")
        focusField("url")
      }
      return
    }
    if (event.name === "tab") {
      event.preventDefault()
      focusField(form.focus === "url" ? "token" : "url")
      return
    }
    if (event.name === "return") {
      event.preventDefault()
      if (form.focus === "url") focusField("token")
      else void submit()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <DialogHeader
        title={props.mode === "cloud" ? "Connect cloud server" : "Teleport session"}
        hint="esc back"
        onClose={() => props.onBack()}
      />

      <Show
        when={pairing()}
        fallback={
          <>
            <text fg={theme.foreground.muted} wrapMode="word">
              {props.mode === "cloud"
                ? "Use a mobile-scoped Bearer token from the remote nikcli server."
                : "Send the current session and workspace to a remote nikcli server."}
            </text>
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={theme.foreground.muted}>Server URL:</text>
              <box
                flexGrow={1}
                border={["bottom"]}
                borderColor={form.focus === "url" ? theme.accent.fg : theme.border.subtle}
                onMouseUp={() => focusField("url")}
              >
                <input
                  value={form.url}
                  onInput={(value) => {
                    setForm("url", value)
                    setForm("status", "")
                  }}
                  placeholder="https://my-nikcli-server.example.com"
                  cursorColor={theme.accent.fg}
                  focusedTextColor={theme.foreground.default}
                  ref={(value) => (urlInput = value)}
                />
              </box>
            </box>
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={theme.foreground.muted}>Auth token:</text>
              <box
                flexGrow={1}
                border={["bottom"]}
                borderColor={form.focus === "token" ? theme.accent.fg : theme.border.subtle}
                onMouseUp={() => focusField("token")}
              >
                <input
                  value={form.token}
                  onInput={(value) => {
                    setForm("token", value)
                    setForm("status", "")
                  }}
                  placeholder="nkm_…"
                  cursorColor={theme.accent.fg}
                  focusedTextColor={theme.foreground.default}
                  ref={(value) => (tokenInput = value)}
                />
              </box>
            </box>
            <Show when={form.status}>
              <text fg={form.busy ? theme.foreground.muted : theme.status.warning.fg} wrapMode="word">
                {form.status}
              </text>
            </Show>
            <box marginTop={1} flexDirection="row" justifyContent="flex-end" gap={1}>
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={form.busy ? theme.surface.offset : theme.accent.fg}
                onMouseUp={() => !form.busy && void submit()}
              >
                <text fg={form.busy ? theme.foreground.muted : theme.badge.fg}>
                  {form.busy
                    ? props.mode === "cloud"
                      ? "Verifying…"
                      : "Teleporting…"
                    : props.mode === "cloud"
                      ? "Create QR"
                      : "Teleport"}
                </text>
              </box>
            </box>
          </>
        }
      >
        {(value) => (
          <>
            <text fg={theme.status.success.fg}>{form.status}</text>
            <box flexDirection={stacked() ? "column" : "row"} gap={2} alignItems={stacked() ? "center" : "flex-start"}>
              <box flexDirection="column" gap={1} flexGrow={1} minWidth={32}>
                <text attributes={TextAttributes.BOLD} fg={theme.accent.fg}>
                  Scan from Nikcli Mobile
                </text>
                <text fg={theme.foreground.muted} wrapMode="word">
                  This QR connects the app directly to the verified cloud server.
                </text>
                <text fg={theme.foreground.muted}>Server URL</text>
                <text fg={theme.accent.alt} selectable wrapMode="word">
                  {value().serverUrl}
                </text>
                <text fg={theme.foreground.muted}>Pairing token</text>
                <text fg={theme.foreground.default}>{value().token.slice(0, 8)}••••••••••••••••</text>
                <PairingLink deepLink={value().deepLink} />
              </box>
              <box height={qrFit().height} width={qrFit().width} flexShrink={0}>
                <QRCode matrix={value().matrix} maxColumns={qrBudget().columns} maxRows={qrBudget().rows} />
              </box>
            </box>
            <box flexDirection="row" gap={2} marginTop={1}>
              <text fg={theme.foreground.muted}>y copy link</text>
              <text fg={theme.foreground.muted}>r edit server</text>
              <text fg={theme.foreground.muted}>esc back</text>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}

function LocalMobileConnect(props: { onBack: () => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const [pairing, setPairing] = createSignal<Pairing>()
  const [selectedURL, setSelectedURL] = createSignal(0)
  const [status, setStatus] = createSignal("Preparing a secure mobile link…")
  const [error, setError] = createSignal<string>()
  const [connected, setConnected] = createSignal(false)
  let activityTimer: ReturnType<typeof setInterval> | undefined

  const qrBudget = createMemo(() => qrDialogBudget(dimensions().width, dimensions().height))
  const qrFit = createMemo(() =>
    pairing()
      ? qrFittedSize(pairing()!.matrix, qrBudget().columns, qrBudget().rows, {
          image: qrCanImageFit(),
        })
      : { width: 0, height: 0, image: false },
  )
  const stacked = createMemo(() => dimensions().width < qrFit().width + 50)
  const repaintOnQR = useQRRepaint(() => pairing()?.matrix)

  onMount(() => {
    repaintOnQR()
    dialog.setSize(dimensions().width >= 100 ? "xlarge" : "large")
    void createPairing()
  })

  onCleanup(() => {
    if (activityTimer) clearInterval(activityTimer)
  })

  useKeyboard((event) => {
    if (event.name === "escape") {
      props.onBack()
      return
    }
    if (event.name === "tab" && (pairing()?.urls.length ?? 0) > 1) {
      event.preventDefault()
      void selectURL((selectedURL() + 1) % pairing()!.urls.length)
      return
    }
    if (isPlainShortcut(event, "y")) {
      event.preventDefault()
      void copyDeepLink()
      return
    }
    if (isPlainShortcut(event, "r")) {
      event.preventDefault()
      void createPairing()
    }
  })

  async function resolveBaseUrl() {
    setStatus("Starting a token-protected LAN server…")
    // The host opens the LAN socket, not this process: with a background
    // service the engine runs elsewhere, and a listener bound here would serve
    // the phone from a second engine.
    const started = await sdk.client.mobile.host.lan.start({ mdns: true }, { throwOnError: true })
    const url = started.data?.url
    if (!url) throw new Error("The host did not open a LAN listener for mobile pairing")
    return url
  }

  async function createPairing() {
    setError(undefined)
    setConnected(false)
    setStatus("Preparing a secure mobile link…")
    try {
      const baseUrl = await resolveBaseUrl()
      const urls = pairingUrls(baseUrl)
      if (urls.length === 0) {
        throw new Error("No LAN address found. Connect both devices to the same network or use a public server URL.")
      }
      const response = await sdk.client.mobile.auth.token.create(
        { name: "mobile-app", expiresInDays: 90 },
        { throwOnError: true },
      )
      const created = response.data
      if (!created) throw new Error("The host did not return a pairing token")
      const serverUrl = urls[0]!
      const deepLink = buildMobilePairingDeepLink({
        serverUrl,
        token: created.token,
        directory: sdk.directory,
      })
      const matrix = await generateQRMatrix(deepLink)
      if (!matrix) throw new Error("QR generation is unavailable")
      setSelectedURL(0)
      setPairing({
        serverUrl,
        urls,
        token: created.token,
        tokenID: created.info.id,
        deepLink,
        matrix,
        expiresAt: created.info.expiresAt,
      })
      setStatus("Scan the QR code with the Nikcli mobile app")
      watchConnection(created.info.id)
    } catch (cause) {
      setPairing(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus("Could not create the mobile link")
    }
  }

  async function selectURL(index: number) {
    const current = pairing()
    if (!current) return
    const serverUrl = current.urls[index]
    if (!serverUrl) return
    const deepLink = buildMobilePairingDeepLink({
      serverUrl,
      token: current.token,
      directory: sdk.directory,
    })
    const matrix = await generateQRMatrix(deepLink)
    if (!matrix) return
    setSelectedURL(index)
    setPairing({ ...current, serverUrl, deepLink, matrix })
  }

  function watchConnection(tokenID: string) {
    if (activityTimer) clearInterval(activityTimer)
    activityTimer = setInterval(() => {
      // Server state, so read it from the server: the token's `lastUsedAt` is what proves the
      // phone actually connected.
      void sdk.client.mobile.auth.token.list().then((result) => {
        const token = (result.data ?? []).find((item) => item.id === tokenID)
        if (!token?.lastUsedAt) return
        setConnected(true)
        setStatus("Mobile app connected")
      })
    }, 1000)
  }

  async function copyDeepLink() {
    const value = pairing()?.deepLink
    if (!value) return
    await Clipboard.copy(value)
      .then(() => toast.show({ message: "Mobile link copied", variant: "success" }))
      .catch(toast.error)
  }

  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.foreground.default}>
          Connect local server
        </text>
        <text fg={theme.foreground.muted}>esc back</text>
      </box>
      <text fg={connected() ? theme.status.success.fg : error() ? theme.status.error.fg : theme.foreground.muted}>
        {status()}
      </text>

      <Show when={error()}>
        <box backgroundColor={theme.surface.offset} padding={1} flexDirection="column" gap={1}>
          <text fg={theme.status.error.fg} wrapMode="word">
            {error()}
          </text>
          <text fg={theme.foreground.muted}>Press r to try again.</text>
        </box>
      </Show>

      <Show when={pairing()}>
        {(value) => (
          <box flexDirection={stacked() ? "column" : "row"} gap={2} alignItems={stacked() ? "center" : "flex-start"}>
            <box flexDirection="column" gap={1} flexGrow={1} minWidth={32}>
              <text attributes={TextAttributes.BOLD} fg={theme.accent.fg}>
                Scan from Nikcli Mobile
              </text>
              <text fg={theme.foreground.muted} wrapMode="word">
                The QR securely pairs this server and workspace. It enables mobile sessions, approvals, remote actions
                and Teleport workflows.
              </text>
              <box marginTop={1} flexDirection="column">
                <text fg={theme.foreground.muted}>Server URL</text>
                <text fg={theme.accent.alt} selectable wrapMode="word">
                  {value().serverUrl}
                </text>
              </box>
              <Show when={value().urls.length > 1}>
                <text fg={theme.foreground.muted}>
                  tab switches network interface ({selectedURL() + 1}/{value().urls.length})
                </text>
              </Show>
              <Show when={isLikelyIPhoneHotspotUrl(value().serverUrl)}>
                <text fg={theme.status.warning.fg} wrapMode="word">
                  iPhone Personal Hotspot may block access from the phone to connected devices. Use the same Wi-Fi
                  network, Tailscale, or the cloud server if this connection times out.
                </text>
              </Show>
              <box marginTop={1} flexDirection="column">
                <text fg={theme.foreground.muted}>Pairing token</text>
                <text fg={theme.foreground.default}>{value().token.slice(0, 8)}••••••••••••••••</text>
              </box>
              <text fg={theme.foreground.muted}>
                Expires {value().expiresAt ? new Date(value().expiresAt!).toLocaleDateString() : "never"}
              </text>
              <PairingLink deepLink={value().deepLink} />
              <Show when={connected()}>
                <text attributes={TextAttributes.BOLD} fg={theme.status.success.fg}>
                  ● Connected
                </text>
              </Show>
            </box>
            <box height={qrFit().height} width={qrFit().width} flexShrink={0}>
              <QRCode matrix={value().matrix} maxColumns={qrBudget().columns} maxRows={qrBudget().rows} />
            </box>
          </box>
        )}
      </Show>

      <box flexDirection="row" gap={2} marginTop={1}>
        <text fg={theme.foreground.muted}>y copy link</text>
        <text fg={theme.foreground.muted}>r new token</text>
        <Show when={(pairing()?.urls.length ?? 0) > 1}>
          <text fg={theme.foreground.muted}>tab next interface</text>
        </Show>
        <text fg={theme.foreground.muted}>esc back</text>
      </box>
    </box>
  )
}
