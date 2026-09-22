import { FooterHint } from "@tui/ui/footer-hints"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import open from "open"
import { DialogHeader, useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useSDK } from "@tui/context/sdk"
import { Clipboard } from "@tui/util/clipboard"
import { UserApi } from "@tui/util/user-api"
import { useAttempts } from "@tui/util/lifecycle"
import { UserSession } from "@nikcli-ai/util/user-session"
import type { UserSchema } from "@nikcli-ai/util/user-schema"

/**
 * Device-code sign-in to the nikcli account issuer (auth.nikcli-ai.dev).
 * On success the issuer JWT is stored locally and `GET /user/me` provisions
 * the matching local user on the server (`ensureExternalUser` lives there).
 * One sign-in covers both the account plane and the TUI/server session.
 * LLM provider credentials (`/connect`, auth.json) and mobile pairing tokens
 * are separate and unaffected.
 */
export function DialogAccountLogin(props: {
  onComplete?: (user: UserSchema.PublicUser | null) => void
  clearOnComplete?: boolean
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()

  const [active, setActive] = createSignal<UserApi.AccountInfo>()
  const [start, setStart] = createSignal<UserApi.LoginStart>()
  const [status, setStatus] = createSignal("Contacting auth.nikcli-ai.dev…")
  const [error, setError] = createSignal<string>()
  const [browserOpened, setBrowserOpened] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())
  // A retry supersedes the running attempt: `stale()` covers both the dialog
  // being closed and an older `begin()` resuming after `r` started a new one.
  const attempts = useAttempts()

  /** Minutes:seconds left before the code stops working, or undefined. */
  const remaining = () => {
    const expiresAt = start()?.expiresAt
    if (!expiresAt) return undefined
    const seconds = Math.max(0, Math.round((expiresAt - now()) / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }

  const ticker = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(ticker))

  onMount(() => {
    void UserApi.account(sdk)
      .then((info) => setActive(info ?? undefined))
      .catch(() => undefined)
    void begin()
  })

  async function begin() {
    const { signal, stale } = attempts.start()
    setError(undefined)
    setStart(undefined)
    setBrowserOpened(true)
    setStatus("Contacting auth.nikcli-ai.dev…")
    try {
      const started = await UserApi.accountLogin(sdk, signal)
      if (stale()) return
      if (!started.ok) throw new Error(started.error)
      const result = started.data
      setStart(result)
      setStatus("Waiting for approval in the browser…")
      // The complete URL carries the code, so the browser page arrives with
      // the field already filled — no retyping, no transcription mistakes.
      const opened = await openVerification(result)
      if (stale()) return
      setBrowserOpened(opened)
      if (!opened) setStatus("Could not open a browser — open the link below to approve.")
      // `onPending` had no wire form and needed none: it only rewrote this
      // status line, and the line is the same for every poll that has not
      // finished yet. Set it once, before waiting.
      if (!error()) {
        setStatus(
          opened
            ? "Waiting for approval in the browser… (esc to cancel)"
            : "Waiting for approval… open the link below (esc to cancel)",
        )
      }
      // One request that blocks until the browser approves. Escape aborts it.
      const session = await UserApi.accountComplete(
        sdk,
        { deviceCode: result.deviceCode, expiresIn: result.expiresIn },
        signal,
      )
      if (stale()) return
      if (!session.ok) throw new Error(session.error)

      // The issuer JWT is what `Auth.resolveBearer` already accepts. Saving it
      // and asking `/user/me` is what provisions the local user — the TUI must
      // not write `UserDB` itself.
      await UserSession.save(session.data.accessToken)
      if (stale()) return
      // `/user/me` is what provisions the local user; a null answer means the
      // issuer token is good but this install has no user behind it. Reporting
      // that as a success is how a half-provisioned account looked signed in.
      const localUser = await UserApi.me(sdk)
      if (stale()) return
      if (!localUser) throw new Error("Signed in, but this install could not be provisioned — try again")
      toast.show({
        message: session.data.email ? `Signed in as ${session.data.email}` : "Signed in to your nikcli account",
        variant: "success",
      })
      props.onComplete?.(localUser)
      if (props.clearOnComplete !== false) dialog.clear()
    } catch (cause) {
      if (stale()) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus("Sign-in did not complete")
    }
  }

  async function openVerification(result: UserApi.LoginStart): Promise<boolean> {
    return open(result.verificationUrlComplete)
      .then(() => true)
      .catch(() => false)
  }

  async function copyCode() {
    const value = start()?.userCode
    if (!value) return
    await Clipboard.copy(value)
      .then(() => toast.show({ message: "Code copied", variant: "success" }))
      .catch(toast.error)
  }

  async function copyUrl() {
    const value = start()?.verificationUrlComplete
    if (!value) return
    await Clipboard.copy(value)
      .then(() => toast.show({ message: "Sign-in link copied", variant: "success" }))
      .catch(toast.error)
  }

  useKeyboard((event) => {
    if (event.name === "escape") {
      dialog.clear()
      return
    }
    if (event.ctrl || event.meta) return
    if (event.name === "y") {
      event.preventDefault()
      void copyCode()
      return
    }
    if (event.name === "u") {
      event.preventDefault()
      void copyUrl()
      return
    }
    // Reopening the browser is the fix for the most common stall: the tab was
    // closed, or `open` silently landed on the wrong browser.
    if (event.name === "o") {
      event.preventDefault()
      const result = start()
      if (!result) return
      void openVerification(result).then((opened) => {
        // Reopening belongs to no attempt: only disposal invalidates it.
        if (attempts.disposed) return
        setBrowserOpened(opened)
        if (!opened) toast.show({ message: "Could not open a browser — copy the link with u", variant: "error" })
      })
      return
    }
    if (event.name === "r" && error()) {
      event.preventDefault()
      void begin()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <DialogHeader title="Sign in to nikcli" hint="esc close" />

      <Show when={active()}>
        {(value) => (
          <text fg={theme.foreground.muted} wrapMode="word">
            Currently signed in as {value().email} — completing a new sign-in switches the active account.
          </text>
        )}
      </Show>

      <text fg={error() ? theme.status.error.fg : theme.foreground.muted} wrapMode="word">
        {error() ?? status()}
      </text>

      <Show when={start()}>
        {(value) => (
          <box flexDirection="column" gap={1}>
            <box flexDirection="column">
              <text fg={theme.foreground.muted}>
                {browserOpened() ? "Opened in your browser (code prefilled)" : "Open this link to approve"}
              </text>
              <text fg={theme.accent.alt} selectable wrapMode="word">
                {value().verificationUrlComplete}
              </text>
            </box>
            <box flexDirection="column">
              <text fg={theme.foreground.muted}>
                {`Code, if the page asks for it${remaining() ? ` — expires in ${remaining()}` : ""}`}
              </text>
              <text attributes={TextAttributes.BOLD} fg={theme.accent.fg} selectable>
                {value().userCode}
              </text>
            </box>
          </box>
        )}
      </Show>

      <box flexDirection="row" gap={2} marginTop={1}>
        <Show when={start()}>
          <text fg={theme.foreground.muted}>o reopen</text>
          <text fg={theme.foreground.muted}>u copy link</text>
          <text fg={theme.foreground.muted}>y copy code</text>
        </Show>
        <Show when={error()}>
          <FooterHint keys="r" label="retry" />
        </Show>
        <FooterHint keys="esc" label="close" />
      </box>
    </box>
  )
}
