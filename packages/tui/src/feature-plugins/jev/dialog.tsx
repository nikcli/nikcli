/**
 * `/jev` — the JEV Trader surfaces.
 *
 * Three dialogs, in the shape the other integration plugins already use: a
 * `DialogSelect` settings sheet (like `/background`), a prompt chain for the
 * endpoint and the key (like `/discord`), and read-only panels for what JEV
 * answers (like the Herdr status dialog and the live-telemetry viewer).
 *
 * The panels never write: JEV is a trading terminal, and a TUI integration that
 * can place or close a position on `enter` is one mis-keyed `j` away from a real
 * loss. Reading the account, the positions, the watchlist and the agent's
 * signals is the whole scope on purpose.
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useKV } from "@tui/context/kv"
import { useTheme } from "@tui/context/theme"
import { DialogHeader, useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { useScrollAcceleration } from "@tui/util/scroll"
import { checkConnection, fetchOverview, fetchSignals } from "./client"
import { actionDirection, type JevOverview, type JevSignal } from "./model"
import {
  cleanApiPrefix,
  cleanBaseUrl,
  DEFAULT_BASE_URL,
  direction,
  endpointLabel,
  envApiKey,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedMoney,
  isAuthenticated,
  keyLabel,
  parseWatchlist,
  refreshLabel,
  stepRefresh,
  watchlistLabel,
  type JevSettings,
} from "./settings"
import { readSettings, refresh, writeSettings } from "./store"

type Row =
  | "overview"
  | "signals"
  | "endpoint"
  | "prefix"
  | "key"
  | "watchlist"
  | "refresh"
  | "currency"
  | "enabled"
  | "test"
  | "clear"

/**
 * What a panel refetches on.
 *
 * A string rather than the settings object: `readSettings` builds a fresh
 * object on every read, so keying a resource on it would refetch on any
 * unrelated key-value write. The API key is represented by its masked label —
 * enough to notice it changed, without a secret in a reactive key.
 */
function fetchKey(settings: JevSettings): string {
  return [
    settings.baseUrl,
    settings.apiPrefix,
    settings.enabled ? "on" : "off",
    settings.watchlist.join(","),
    keyLabel(settings),
    refresh.current,
  ].join("|")
}

/** Auto-refresh while a panel is open, at the configured interval. */
function useAutoRefresh(seconds: () => number, tick: () => void) {
  createEffect(() => {
    const every = seconds()
    if (every <= 0) return
    const timer = setInterval(tick, every * 1000)
    onCleanup(() => clearInterval(timer))
  })
}

export function DialogJev() {
  const dialog = useDialog()
  const kv = useKV()
  const { theme } = useTheme()
  const toast = useToast()

  const settings = createMemo(() => readSettings(kv))
  const update = (patch: Partial<JevSettings>) => writeSettings(kv, patch)

  const value = (text: string, muted = false) => (
    <span
      style={{
        fg: muted ? theme.foreground.muted : theme.foreground.default,
        attributes: muted ? undefined : TextAttributes.BOLD,
      }}
    >
      {text}
    </span>
  )

  const promptEndpoint = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="JEV endpoint"
        placeholder={DEFAULT_BASE_URL}
        value={settings().baseUrl}
        description={() => (
          <text fg={theme.foreground.muted}>
            The JEV Trader deployment to read from. Leave the default for the hosted one.
          </text>
        )}
        onConfirm={(input) => {
          const baseUrl = cleanBaseUrl(input)
          if (baseUrl === "" && input.trim() !== "") {
            toast.show({ message: "That is not a URL JEV can be reached at", variant: "error" })
            return
          }
          update({ baseUrl: baseUrl || DEFAULT_BASE_URL })
          refresh.next()
          dialog.replace(() => <DialogJev />)
        }}
        onCancel={() => dialog.replace(() => <DialogJev />)}
      />
    ))

  const promptKey = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="JEV API key"
        placeholder="Paste the key, or leave empty to clear it"
        allowEmpty
        description={() => (
          <text fg={theme.foreground.muted}>
            Stored in the TUI key-value store. Set NIKCLI_JEV_API_KEY instead to keep it out of disk — the environment
            wins over what is stored here.
          </text>
        )}
        onConfirm={(input) => {
          update({ apiKey: input.trim() })
          refresh.next()
          toast.show({
            message: input.trim() === "" ? "JEV API key cleared" : "JEV API key saved",
            variant: "success",
          })
          dialog.replace(() => <DialogJev />)
        }}
        onCancel={() => dialog.replace(() => <DialogJev />)}
      />
    ))

  const promptWatchlist = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="JEV watchlist"
        placeholder="AAPL NVDA BTC-USD"
        value={settings().watchlist.join(" ")}
        allowEmpty
        description={() => <text fg={theme.foreground.muted}>Tickers, separated by spaces or commas.</text>}
        onConfirm={(input) => {
          update({ watchlist: parseWatchlist(input) })
          refresh.next()
          dialog.replace(() => <DialogJev />)
        }}
        onCancel={() => dialog.replace(() => <DialogJev />)}
      />
    ))

  const promptPrefix = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="JEV API prefix"
        placeholder="/api"
        value={settings().apiPrefix}
        allowEmpty
        description={() => (
          <text fg={theme.foreground.muted}>
            Path the JEV REST routes hang off. Only a deployment that mounts them elsewhere needs to change this.
          </text>
        )}
        onConfirm={(input) => {
          update({ apiPrefix: cleanApiPrefix(input) })
          refresh.next()
          dialog.replace(() => <DialogJev />)
        }}
        onCancel={() => dialog.replace(() => <DialogJev />)}
      />
    ))

  const promptCurrency = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="Display currency"
        placeholder="USD"
        value={settings().currency}
        description={() => (
          <text fg={theme.foreground.muted}>Used when JEV does not say which currency an amount is in.</text>
        )}
        onConfirm={(input) => {
          update({ currency: input.trim().toUpperCase() })
          dialog.replace(() => <DialogJev />)
        }}
        onCancel={() => dialog.replace(() => <DialogJev />)}
      />
    ))

  const test = () => {
    const current = settings()
    toast.show({ message: "Checking JEV…", variant: "info" })
    void checkConnection(current)
      .then((result) => {
        if (!result.ok) {
          toast.show({ message: result.error, variant: "error", duration: 6000 })
          return
        }
        const equity = result.portfolio?.equity
        toast.show({
          message:
            equity === undefined
              ? `JEV reachable at ${endpointLabel(current)}`
              : `JEV connected · equity ${formatMoney(equity, result.portfolio?.currency ?? current.currency)}`,
          variant: "success",
          duration: 5000,
        })
      })
      .catch((error: unknown) => {
        toast.show({
          message: error instanceof Error ? error.message : "Could not reach JEV",
          variant: "error",
          duration: 6000,
        })
      })
  }

  const options = createMemo((): DialogSelectOption<Row>[] => {
    const current = settings()
    return [
      {
        value: "overview",
        title: "Portfolio ▸",
        description: "Account, open positions and the watchlist",
        category: "Terminal",
        onSelect: () => dialog.replace(() => <DialogJevOverview />),
      },
      {
        value: "signals",
        title: "Signals ▸",
        description: "What the JEV agent is calling right now",
        category: "Terminal",
        onSelect: () => dialog.replace(() => <DialogJevSignals />),
      },
      {
        value: "endpoint",
        title: "Endpoint",
        description: "The JEV deployment to read from",
        category: "Connection",
        footer: value(endpointLabel(current), current.baseUrl === ""),
        onSelect: promptEndpoint,
      },
      {
        value: "key",
        title: "API key",
        description: isAuthenticated(current)
          ? "Sent as both a bearer token and x-api-key"
          : "JEV will only answer its public routes without one",
        category: "Connection",
        footer: value(keyLabel(current), !isAuthenticated(current)),
        onSelect: promptKey,
      },
      {
        value: "prefix",
        title: "API prefix",
        description: "Where the REST routes are mounted",
        category: "Connection",
        footer: value(current.apiPrefix === "" ? "none" : current.apiPrefix, current.apiPrefix === ""),
        onSelect: promptPrefix,
      },
      {
        value: "test",
        title: "Test connection",
        description: "Ask JEV for the portfolio once and report what came back",
        category: "Connection",
        disabled: current.baseUrl === "" || !current.enabled,
        onSelect: test,
      },
      {
        value: "watchlist",
        title: "Watchlist",
        description: "Tickers quoted in the portfolio panel",
        category: "Preferences",
        footer: value(watchlistLabel(current.watchlist), current.watchlist.length === 0),
        onSelect: promptWatchlist,
      },
      {
        value: "refresh",
        title: "Auto-refresh",
        description: "How often an open JEV panel refetches",
        category: "Preferences",
        footer: value(refreshLabel(current.refreshSeconds), current.refreshSeconds === 0),
        onSelect: () => update({ refreshSeconds: stepRefresh(current.refreshSeconds) }),
      },
      {
        value: "currency",
        title: "Display currency",
        description: "Fallback for amounts JEV sends without one",
        category: "Preferences",
        footer: value(current.currency),
        onSelect: promptCurrency,
      },
      {
        value: "enabled",
        title: current.enabled ? "Disable JEV" : "Enable JEV",
        description: "Keep the connection configured but stop calling out",
        category: "Preferences",
        footer: value(current.enabled ? "enabled" : "disabled", !current.enabled),
        onSelect: () => update({ enabled: !current.enabled }),
      },
      {
        value: "clear",
        title: "Forget connection",
        description: "Clear the stored key and the watchlist",
        category: "Preferences",
        disabled: current.apiKey === "" && current.watchlist.length === 0,
        onSelect: (ctx) => {
          update({ apiKey: "", watchlist: [] })
          toast.show({ message: "JEV connection forgotten", variant: "success" })
          ctx.clear()
        },
      },
    ]
  })

  return <DialogSelect title="JEV Trader" placeholder="Search settings..." options={options()} />
}

/** First run: endpoint, then key, then straight into the portfolio. */
export function DialogJevConnect() {
  const dialog = useDialog()
  const kv = useKV()
  const { theme } = useTheme()
  const toast = useToast()

  const askKey = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="JEV API key"
        placeholder="Paste the key from your JEV account"
        allowEmpty
        description={() => (
          <text fg={theme.foreground.muted}>
            Or set NIKCLI_JEV_API_KEY and leave this empty — the environment wins. Empty also works for a deployment
            that needs no key.
          </text>
        )}
        onConfirm={(input) => {
          const settings = writeSettings(kv, { apiKey: input.trim(), enabled: true })
          refresh.next()
          toast.show({ message: "Checking JEV…", variant: "info" })
          void checkConnection(settings)
            .then((result) => {
              if (!result.ok) {
                toast.show({ message: result.error, variant: "error", duration: 6000 })
                dialog.replace(() => <DialogJev />)
                return
              }
              dialog.replace(() => <DialogJevOverview />)
            })
            .catch(() => dialog.replace(() => <DialogJev />))
        }}
        onCancel={() => dialog.replace(() => <DialogJev />)}
      />
    ))

  return (
    <DialogPrompt
      title="Connect JEV Trader"
      placeholder={DEFAULT_BASE_URL}
      value={readSettings(kv).baseUrl || DEFAULT_BASE_URL}
      description={() => (
        <text fg={theme.foreground.muted}>The JEV deployment to read from. Enter to keep the hosted one.</text>
      )}
      onConfirm={(input) => {
        const baseUrl = cleanBaseUrl(input) || DEFAULT_BASE_URL
        writeSettings(kv, { baseUrl, enabled: true })
        if (envApiKey() !== "") {
          // The key is already in the environment; nothing left to ask.
          refresh.next()
          dialog.replace(() => <DialogJevOverview />)
          return
        }
        askKey()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

function Amount(props: { value: number | undefined; currency?: string; signed?: boolean; percent?: boolean }) {
  const { theme } = useTheme()
  const lean = createMemo(() => direction(props.value))
  const color = createMemo(() => {
    if (!props.signed && !props.percent) return theme.foreground.default
    if (lean() === "up") return theme.status.success.fg
    if (lean() === "down") return theme.status.error.fg
    return theme.foreground.muted
  })
  const text = createMemo(() => {
    if (props.percent) return formatPercent(props.value)
    return props.signed ? formatSignedMoney(props.value, props.currency) : formatMoney(props.value, props.currency)
  })
  return (
    <text fg={color()} wrapMode="none">
      {text()}
    </text>
  )
}

function Field(props: { label: string; children?: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <box width={10} flexShrink={0}>
        <text fg={theme.foreground.muted} wrapMode="none">
          {props.label}
        </text>
      </box>
      {props.children}
    </box>
  )
}

/** Portfolio, open positions and the watchlist, in one panel. */
export function DialogJevOverview() {
  const kv = useKV()
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const scrollAcceleration = useScrollAcceleration()

  const settings = createMemo(() => readSettings(kv))
  const [manual, setManual] = createSignal(0)
  const [data, { refetch }] = createResource(
    () => `${fetchKey(settings())}|${manual()}`,
    () => fetchOverview(readSettings(kv)),
  )

  useAutoRefresh(
    () => settings().refreshSeconds,
    () => setManual((value) => value + 1),
  )

  onMount(() => dialog.setSize("large"))

  useKeyboard((evt) => {
    if (evt.name === "r") {
      evt.preventDefault()
      void refetch()
    }
    if (evt.name === "s") {
      evt.preventDefault()
      dialog.replace(() => <DialogJevSignals />)
    }
    if (evt.name === "c") {
      evt.preventDefault()
      dialog.replace(() => <DialogJev />)
    }
  })

  const listHeight = createMemo(() => Math.max(6, dimensions().height - 11))
  const currency = createMemo(() => data()?.portfolio?.currency ?? settings().currency)

  return (
    <box gap={1}>
      <box paddingLeft={2} paddingRight={2}>
        <DialogHeader title="JEV Trader" subtitle={endpointLabel(settings())} />
      </box>

      <scrollbox
        viewportCulling={true}
        scrollAcceleration={scrollAcceleration()}
        height={listHeight()}
        backgroundColor={theme.surface.offset}
      >
        <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <Show when={!settings().enabled}>
            <text fg={theme.status.warning.fg}>JEV is switched off — enable it from /jev.</text>
          </Show>

          <Show when={data.loading && data() === undefined}>
            <text fg={theme.foreground.muted}>Asking JEV…</text>
          </Show>

          <Show when={data()}>
            {(overview) => (
              <>
                <Portfolio overview={overview()} currency={currency()} />
                <Positions overview={overview()} currency={currency()} />
                <Quotes overview={overview()} />
                <For each={overview().errors}>{(message) => <text fg={theme.status.error.fg}>{message}</text>}</For>
              </>
            )}
          </Show>
        </box>
      </scrollbox>

      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.foreground.muted}>
          {data.loading ? "refreshing…" : `auto-refresh ${refreshLabel(settings().refreshSeconds)}`}
        </text>
        <text fg={theme.foreground.muted}>r refresh · s signals · c settings · esc close</text>
      </box>
    </box>
  )
}

function Portfolio(props: { overview: JevOverview; currency: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme.foreground.default}>
        <b>Account</b>
      </text>
      <Show
        when={props.overview.portfolio}
        fallback={<text fg={theme.foreground.muted}>No portfolio figures reported.</text>}
      >
        {(portfolio) => (
          <box flexDirection="column" gap={0}>
            <Field label="Equity">
              <Amount value={portfolio().equity} currency={props.currency} />
            </Field>
            <Field label="Cash">
              <Amount value={portfolio().cash} currency={props.currency} />
            </Field>
            <Field label="Day P&L">
              <box flexDirection="row" gap={1}>
                <Amount value={portfolio().pnlDay} currency={props.currency} signed />
                <Amount value={portfolio().pnlDayPercent} currency={props.currency} percent />
              </box>
            </Field>
            <Field label="Total P&L">
              <box flexDirection="row" gap={1}>
                <Amount value={portfolio().pnlTotal} currency={props.currency} signed />
                <Amount value={portfolio().pnlTotalPercent} currency={props.currency} percent />
              </box>
            </Field>
          </box>
        )}
      </Show>
    </box>
  )
}

function Positions(props: { overview: JevOverview; currency: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme.foreground.default}>
        <b>Positions</b>
        <span style={{ fg: theme.foreground.muted }}> ({props.overview.positions.length})</span>
      </text>
      <Show when={props.overview.positions.length === 0}>
        <text fg={theme.foreground.muted}>No open positions.</text>
      </Show>
      <For each={props.overview.positions}>
        {(position) => (
          <box flexDirection="row" gap={1}>
            <box width={10} flexShrink={0}>
              <text fg={theme.foreground.default} wrapMode="none">
                {position.symbol}
              </text>
            </box>
            <box width={12} flexShrink={0}>
              <text fg={theme.foreground.muted} wrapMode="none">
                {position.side === "short" ? "-" : ""}
                {formatQuantity(position.quantity)}
              </text>
            </box>
            <box width={14} flexShrink={0}>
              <Amount value={position.lastPrice ?? position.entryPrice} currency={props.currency} />
            </box>
            <box width={16} flexShrink={0}>
              <Amount value={position.pnl} currency={props.currency} signed />
            </box>
            <box flexShrink={1} minWidth={0}>
              <Amount value={position.pnlPercent} currency={props.currency} percent />
            </box>
          </box>
        )}
      </For>
    </box>
  )
}

function Quotes(props: { overview: JevOverview }) {
  const { theme } = useTheme()
  return (
    <Show when={props.overview.quotes.length > 0}>
      <box flexDirection="column" gap={0}>
        <text fg={theme.foreground.default}>
          <b>Watchlist</b>
        </text>
        <For each={props.overview.quotes}>
          {(quote) => (
            <box flexDirection="row" gap={1}>
              <box width={10} flexShrink={0}>
                <text fg={theme.foreground.default} wrapMode="none">
                  {quote.symbol}
                </text>
              </box>
              <box width={14} flexShrink={0}>
                <text fg={theme.foreground.default} wrapMode="none">
                  {quote.price === undefined ? "—" : formatQuantity(quote.price)}
                </text>
              </box>
              <box flexShrink={1} minWidth={0}>
                <Amount value={quote.changePercent} currency="" percent />
              </box>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

/** What the JEV agent is calling, newest first as JEV ordered them. */
export function DialogJevSignals() {
  const kv = useKV()
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const scrollAcceleration = useScrollAcceleration()

  const settings = createMemo(() => readSettings(kv))
  const [manual, setManual] = createSignal(0)
  const [result, { refetch }] = createResource(
    () => `${fetchKey(settings())}|${manual()}`,
    () => fetchSignals(readSettings(kv)),
  )

  useAutoRefresh(
    () => settings().refreshSeconds,
    () => setManual((value) => value + 1),
  )

  onMount(() => dialog.setSize("large"))

  useKeyboard((evt) => {
    if (evt.name === "r") {
      evt.preventDefault()
      void refetch()
    }
    if (evt.name === "p") {
      evt.preventDefault()
      dialog.replace(() => <DialogJevOverview />)
    }
  })

  const listHeight = createMemo(() => Math.max(6, dimensions().height - 11))
  const signals = createMemo(() => result()?.data ?? [])

  return (
    <box gap={1}>
      <box paddingLeft={2} paddingRight={2}>
        <DialogHeader title="JEV signals" subtitle={endpointLabel(settings())} />
      </box>

      <scrollbox
        viewportCulling={true}
        scrollAcceleration={scrollAcceleration()}
        height={listHeight()}
        backgroundColor={theme.surface.offset}
      >
        <box flexDirection="column" gap={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <Show when={result.loading && result() === undefined}>
            <text fg={theme.foreground.muted}>Asking JEV…</text>
          </Show>
          <Show when={result()?.error}>{(message) => <text fg={theme.status.error.fg}>{message()}</text>}</Show>
          <Show when={result() !== undefined && result()?.error === undefined && signals().length === 0}>
            <text fg={theme.foreground.muted}>No signals right now.</text>
          </Show>
          <For each={signals()}>{(signal) => <Signal signal={signal} />}</For>
        </box>
      </scrollbox>

      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.foreground.muted}>
          {signals().length} signals · auto-refresh {refreshLabel(settings().refreshSeconds)}
        </text>
        <text fg={theme.foreground.muted}>r refresh · p portfolio · esc close</text>
      </box>
    </box>
  )
}

function Signal(props: { signal: JevSignal }) {
  const { theme } = useTheme()
  const color = createMemo(() => {
    const lean = actionDirection(props.signal.action)
    if (lean === "up") return theme.status.success.fg
    if (lean === "down") return theme.status.error.fg
    return theme.foreground.muted
  })
  return (
    <box flexDirection="row" gap={1}>
      <box width={10} flexShrink={0}>
        <text fg={theme.foreground.default} wrapMode="none">
          {props.signal.symbol}
        </text>
      </box>
      <box width={8} flexShrink={0}>
        <text fg={color()} wrapMode="none">
          {props.signal.action}
        </text>
      </box>
      <box width={7} flexShrink={0}>
        <text fg={theme.foreground.muted} wrapMode="none">
          {props.signal.confidence === undefined ? "—" : `${Math.round(props.signal.confidence)}%`}
        </text>
      </box>
      <box flexShrink={1} minWidth={0}>
        <text fg={theme.foreground.muted} wrapMode="none">
          {props.signal.rationale ?? props.signal.at ?? ""}
        </text>
      </box>
    </box>
  )
}
