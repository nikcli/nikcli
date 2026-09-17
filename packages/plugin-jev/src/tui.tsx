/**
 * JEV Trader — an installable nikcli TUI plugin.
 *
 * Registers `/jev` (aliases `/jev-trader`, `/trader`) plus the `jev.*` commands
 * in the palette. An unconfigured instance opens the connect prompt; a
 * configured one opens the portfolio, the way `/discord` opens its wizard or
 * its manager.
 *
 * Everything here goes through the public plugin api (`api.ui.*`, `api.kv`,
 * `api.theme`, `api.keymap`) and nothing through the TUI's internals: that is
 * the whole difference between a plugin that ships inside nikcli and one a user
 * installs. It also means the surfaces are built out of the host's own dialog
 * components, so they inherit its theme, its keybinds and its search.
 *
 * Read-only on purpose. JEV is a trading terminal, and a TUI panel that can
 * place or close a position on `enter` is one mis-keyed `j` away from a real
 * loss — the plugin reads the account, the positions, the watchlist and the
 * agent's signals, and never writes.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiDialogSelectOption } from "@nikcli-ai/plugin/tui"
import { checkConnection, fetchOverview, fetchSignals } from "./client"
import { actionDirection, type JevOverview, type JevPosition, type JevQuote, type JevSignal } from "./model"
import {
  cleanApiPrefix,
  cleanBaseUrl,
  DEFAULT_BASE_URL,
  endpointLabel,
  envApiKey,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatSignedMoney,
  isAuthenticated,
  isConfigured,
  keyLabel,
  parseWatchlist,
  readSettings,
  watchlistLabel,
  writeSettings,
  type JevSettings,
} from "./settings"

export const id = "@nikcli-ai/plugin-jev"

function settingsOf(api: TuiPluginApi): JevSettings {
  return readSettings(api.kv)
}

function update(api: TuiPluginApi, patch: Partial<JevSettings>): JevSettings {
  return writeSettings(api.kv, patch)
}

function fail(api: TuiPluginApi, error: unknown, fallback: string): void {
  api.ui.toast({
    message: error instanceof Error ? error.message : fallback,
    variant: "error",
    duration: 6000,
  })
}

/** A row that only reports: the host dims a disabled row, which is what an info line wants. */
function info(
  value: string,
  title: string,
  description: string,
  footer: string,
  category: string,
): TuiDialogSelectOption<string> {
  return { value, title, description, footer, category, disabled: true }
}

function positionRow(position: JevPosition, currency: string): TuiDialogSelectOption<string> {
  const size = `${position.side === "short" ? "-" : ""}${formatQuantity(position.quantity)}`
  const price = position.lastPrice ?? position.entryPrice
  return {
    value: `position:${position.symbol}`,
    title: position.symbol,
    description: `${size} @ ${formatMoney(price, currency)}`,
    footer: `${formatSignedMoney(position.pnl, currency)} · ${formatPercent(position.pnlPercent)}`,
    category: "Positions",
    disabled: true,
  }
}

function quoteRow(quote: JevQuote): TuiDialogSelectOption<string> {
  return {
    value: `quote:${quote.symbol}`,
    title: quote.symbol,
    description: quote.price === undefined ? "no quote" : formatQuantity(quote.price),
    footer: formatPercent(quote.changePercent),
    category: "Watchlist",
    disabled: true,
  }
}

function signalRow(signal: JevSignal): TuiDialogSelectOption<string> {
  const lean = actionDirection(signal.action)
  const confidence = signal.confidence === undefined ? "" : ` · ${Math.round(signal.confidence)}%`
  return {
    value: `signal:${signal.symbol}:${signal.action}`,
    title: `${lean === "up" ? "▲" : lean === "down" ? "▼" : "•"} ${signal.symbol}`,
    description: signal.rationale ?? signal.at ?? "",
    footer: `${signal.action}${confidence}`,
    category: "Signals",
    disabled: true,
  }
}

function accountRows(overview: JevOverview, currency: string): TuiDialogSelectOption<string>[] {
  const portfolio = overview.portfolio
  if (!portfolio) {
    return [
      {
        value: "account:none",
        title: "No portfolio figures",
        description: "JEV answered without any account numbers",
        category: "Account",
        disabled: true,
      },
    ]
  }
  return [
    info(
      "account:equity",
      "Equity",
      "Account value as JEV reports it",
      formatMoney(portfolio.equity, currency),
      "Account",
    ),
    info("account:cash", "Cash", "Uninvested balance", formatMoney(portfolio.cash, currency), "Account"),
    info(
      "account:day",
      "Day P&L",
      "Since the session opened",
      `${formatSignedMoney(portfolio.pnlDay, currency)} · ${formatPercent(portfolio.pnlDayPercent)}`,
      "Account",
    ),
    info(
      "account:total",
      "Total P&L",
      "Lifetime, as JEV accounts for it",
      `${formatSignedMoney(portfolio.pnlTotal, currency)} · ${formatPercent(portfolio.pnlTotalPercent)}`,
      "Account",
    ),
  ]
}

/** Account, open positions and the watchlist, in one sheet. */
export function openPortfolio(api: TuiPluginApi): void {
  const settings = settingsOf(api)
  void fetchOverview(settings)
    .then((overview) => {
      const currency = overview.portfolio?.currency ?? settings.currency
      const Select = api.ui.DialogSelect
      const rows: TuiDialogSelectOption<string>[] = [
        ...accountRows(overview, currency),
        ...overview.positions.map((position) => positionRow(position, currency)),
        ...overview.quotes.map((quote) => quoteRow(quote)),
      ]
      if (overview.positions.length === 0) {
        rows.push({
          value: "positions:none",
          title: "No open positions",
          category: "Positions",
          disabled: true,
        })
      }
      for (const [index, message] of overview.errors.entries()) {
        rows.push({ value: `error:${index}`, title: message, category: "Problems", disabled: true })
      }
      rows.push(
        {
          value: "action:refresh",
          title: "Refresh",
          description: "Ask JEV again",
          category: "Actions",
          onSelect: () => openPortfolio(api),
        },
        {
          value: "action:signals",
          title: "Signals ▸",
          description: "What the JEV agent is calling right now",
          category: "Actions",
          onSelect: () => openSignals(api),
        },
        {
          value: "action:settings",
          title: "Settings ▸",
          description: "Endpoint, API key and watchlist",
          category: "Actions",
          onSelect: () => openSettings(api),
        },
      )
      api.ui.dialog.replace(() => <Select title={`JEV Trader · ${endpointLabel(settings)}`} options={rows} />)
    })
    .catch((error: unknown) => fail(api, error, "Could not read JEV"))
}

/** What the JEV agent is calling, in the order JEV returned it. */
export function openSignals(api: TuiPluginApi): void {
  const settings = settingsOf(api)
  void fetchSignals(settings)
    .then((result) => {
      const Select = api.ui.DialogSelect
      const rows: TuiDialogSelectOption<string>[] = []
      if (result.error !== undefined) {
        rows.push({ value: "error", title: result.error, category: "Signals", disabled: true })
      } else if (result.data.length === 0) {
        rows.push({ value: "empty", title: "No signals right now", category: "Signals", disabled: true })
      } else {
        rows.push(...result.data.map((signal) => signalRow(signal)))
      }
      rows.push(
        {
          value: "action:refresh",
          title: "Refresh",
          description: "Ask JEV again",
          category: "Actions",
          onSelect: () => openSignals(api),
        },
        {
          value: "action:portfolio",
          title: "Portfolio ▸",
          description: "Account, open positions and the watchlist",
          category: "Actions",
          onSelect: () => openPortfolio(api),
        },
      )
      api.ui.dialog.replace(() => <Select title={`JEV signals · ${endpointLabel(settings)}`} options={rows} />)
    })
    .catch((error: unknown) => fail(api, error, "Could not read JEV signals"))
}

function promptEndpoint(api: TuiPluginApi, next: () => void): void {
  const Prompt = api.ui.DialogPrompt
  const settings = settingsOf(api)
  api.ui.dialog.replace(() => (
    <Prompt
      title="JEV endpoint"
      placeholder={DEFAULT_BASE_URL}
      value={settings.baseUrl || DEFAULT_BASE_URL}
      description={() => (
        <text fg={api.theme.current.foreground.muted}>
          The JEV Trader deployment to read from. Enter keeps the hosted one.
        </text>
      )}
      onConfirm={(input) => {
        const baseUrl = cleanBaseUrl(input)
        if (baseUrl === "") {
          api.ui.toast({ message: "That is not a URL JEV can be reached at", variant: "error" })
          promptEndpoint(api, next)
          return
        }
        update(api, { baseUrl, enabled: true })
        next()
      }}
      onCancel={() => openSettings(api)}
    />
  ))
}

function promptKey(api: TuiPluginApi, next: () => void): void {
  const Prompt = api.ui.DialogPrompt
  api.ui.dialog.replace(() => (
    <Prompt
      title="JEV API key"
      placeholder="Paste the key from your JEV account"
      description={() => (
        <text fg={api.theme.current.foreground.muted}>
          Stored in the TUI key-value store. Set NIKCLI_JEV_API_KEY (or JEV_API_KEY) instead to keep it off disk — the
          environment wins over what is stored here.
        </text>
      )}
      onConfirm={(input) => {
        update(api, { apiKey: input.trim() })
        api.ui.toast({ message: "JEV API key saved", variant: "success" })
        next()
      }}
      onCancel={() => openSettings(api)}
    />
  ))
}

function promptWatchlist(api: TuiPluginApi): void {
  const Prompt = api.ui.DialogPrompt
  const settings = settingsOf(api)
  api.ui.dialog.replace(() => (
    <Prompt
      title="JEV watchlist"
      placeholder="AAPL NVDA BTC-USD"
      value={settings.watchlist.join(" ")}
      description={() => <text fg={api.theme.current.foreground.muted}>Tickers, separated by spaces or commas.</text>}
      onConfirm={(input) => {
        update(api, { watchlist: parseWatchlist(input) })
        openSettings(api)
      }}
      onCancel={() => openSettings(api)}
    />
  ))
}

function promptPrefix(api: TuiPluginApi): void {
  const Prompt = api.ui.DialogPrompt
  const settings = settingsOf(api)
  api.ui.dialog.replace(() => (
    <Prompt
      title="JEV API prefix"
      placeholder="/api"
      value={settings.apiPrefix || "/api"}
      description={() => (
        <text fg={api.theme.current.foreground.muted}>
          Path the JEV REST routes hang off. Only a deployment that mounts them elsewhere needs to change this; "/"
          means none.
        </text>
      )}
      onConfirm={(input) => {
        update(api, { apiPrefix: cleanApiPrefix(input) })
        openSettings(api)
      }}
      onCancel={() => openSettings(api)}
    />
  ))
}

function promptCurrency(api: TuiPluginApi): void {
  const Prompt = api.ui.DialogPrompt
  const settings = settingsOf(api)
  api.ui.dialog.replace(() => (
    <Prompt
      title="Display currency"
      placeholder="USD"
      value={settings.currency}
      description={() => (
        <text fg={api.theme.current.foreground.muted}>Used when JEV does not say which currency an amount is in.</text>
      )}
      onConfirm={(input) => {
        update(api, { currency: input.trim().toUpperCase() })
        openSettings(api)
      }}
      onCancel={() => openSettings(api)}
    />
  ))
}

function testConnection(api: TuiPluginApi): void {
  const settings = settingsOf(api)
  api.ui.toast({ message: "Checking JEV…", variant: "info" })
  void checkConnection(settings)
    .then((result) => {
      if (!result.ok) {
        api.ui.toast({ message: result.error, variant: "error", duration: 6000 })
        return
      }
      const equity = result.portfolio?.equity
      api.ui.toast({
        message:
          equity === undefined
            ? `JEV reachable at ${endpointLabel(settings)}`
            : `JEV connected · equity ${formatMoney(equity, result.portfolio?.currency ?? settings.currency)}`,
        variant: "success",
        duration: 5000,
      })
    })
    .catch((error: unknown) => fail(api, error, "Could not reach JEV"))
}

export function openSettings(api: TuiPluginApi): void {
  const settings = settingsOf(api)
  const Select = api.ui.DialogSelect
  const rows: TuiDialogSelectOption<string>[] = [
    {
      value: "portfolio",
      title: "Portfolio ▸",
      description: "Account, open positions and the watchlist",
      category: "Terminal",
      disabled: !isConfigured(settings),
      onSelect: () => openPortfolio(api),
    },
    {
      value: "signals",
      title: "Signals ▸",
      description: "What the JEV agent is calling right now",
      category: "Terminal",
      disabled: !isConfigured(settings),
      onSelect: () => openSignals(api),
    },
    {
      value: "endpoint",
      title: "Endpoint",
      description: "The JEV deployment to read from",
      footer: endpointLabel(settings),
      category: "Connection",
      onSelect: () => promptEndpoint(api, () => openSettings(api)),
    },
    {
      value: "key",
      title: "API key",
      description: isAuthenticated(settings)
        ? "Sent as both a bearer token and x-api-key"
        : "JEV will only answer its open routes without one",
      footer: keyLabel(settings),
      category: "Connection",
      onSelect: () => promptKey(api, () => openSettings(api)),
    },
    {
      value: "key-clear",
      title: "Clear API key",
      description: envApiKey() === "" ? "Forget the stored key" : "Forget the stored key — the environment one stays",
      category: "Connection",
      disabled: settings.apiKey === "",
      onSelect: () => {
        update(api, { apiKey: "" })
        api.ui.toast({ message: "JEV API key cleared", variant: "success" })
        openSettings(api)
      },
    },
    {
      value: "prefix",
      title: "API prefix",
      description: "Where the REST routes are mounted",
      footer: settings.apiPrefix === "" ? "none" : settings.apiPrefix,
      category: "Connection",
      onSelect: () => promptPrefix(api),
    },
    {
      value: "test",
      title: "Test connection",
      description: "Ask JEV for the portfolio once and report what came back",
      category: "Connection",
      disabled: !isConfigured(settings) || !settings.enabled,
      onSelect: () => testConnection(api),
    },
    {
      value: "watchlist",
      title: "Watchlist",
      description: "Tickers quoted in the portfolio sheet",
      footer: watchlistLabel(settings.watchlist),
      category: "Preferences",
      onSelect: () => promptWatchlist(api),
    },
    {
      value: "watchlist-clear",
      title: "Clear watchlist",
      description: "Stop quoting tickers in the portfolio sheet",
      category: "Preferences",
      disabled: settings.watchlist.length === 0,
      onSelect: () => {
        update(api, { watchlist: [] })
        openSettings(api)
      },
    },
    {
      value: "currency",
      title: "Display currency",
      description: "Fallback for amounts JEV sends without one",
      footer: settings.currency,
      category: "Preferences",
      onSelect: () => promptCurrency(api),
    },
    {
      value: "enabled",
      title: settings.enabled ? "Disable JEV" : "Enable JEV",
      description: "Keep the connection configured but stop calling out",
      footer: settings.enabled ? "enabled" : "disabled",
      category: "Preferences",
      onSelect: () => {
        const next = update(api, { enabled: !settings.enabled })
        api.ui.toast({
          message: next.enabled ? "JEV enabled" : "JEV disabled",
          variant: next.enabled ? "success" : "info",
        })
        openSettings(api)
      },
    },
  ]
  api.ui.dialog.replace(() => <Select title="JEV Trader" placeholder="Search settings..." options={rows} />)
}

/** First run: endpoint, then key, then straight into the portfolio. */
export function openConnect(api: TuiPluginApi): void {
  promptEndpoint(api, () => {
    // The key may already be in the environment, in which case there is
    // nothing left to ask for.
    if (envApiKey() !== "") {
      openPortfolio(api)
      return
    }
    promptKey(api, () => openPortfolio(api))
  })
}

const tui: TuiPlugin = async (api) => {
  // The runtime scopes the registration to the plugin's lifetime, so a
  // deactivate or a hot reload takes the commands with it.
  api.keymap.registerLayer({
    commands: () => {
      const settings = settingsOf(api)
      const ready = isConfigured(settings) && isAuthenticated(settings)
      return [
        {
          name: "jev.open",
          title: "JEV Trader",
          namespace: "Integrations",
          description: ready ? `Portfolio and signals from ${endpointLabel(settings)}` : "Connect the JEV terminal",
          slashName: "jev",
          slashAliases: ["jev-trader", "trader"],
          run: () => (ready ? openPortfolio(api) : openConnect(api)),
        },
        {
          name: "jev.settings",
          title: "JEV settings",
          namespace: "Integrations",
          description: "Endpoint, API key, watchlist and display currency",
          run: () => openSettings(api),
        },
        {
          name: "jev.portfolio",
          title: "JEV portfolio",
          namespace: "Integrations",
          description: "Account, open positions and the watchlist",
          enabled: isConfigured(settings),
          run: () => openPortfolio(api),
        },
        {
          name: "jev.signals",
          title: "JEV signals",
          namespace: "Integrations",
          description: "What the JEV agent is calling right now",
          enabled: isConfigured(settings),
          run: () => openSignals(api),
        },
        {
          name: "jev.test",
          title: "JEV test connection",
          namespace: "Integrations",
          description: "Ask JEV for the portfolio once and report what came back",
          enabled: isConfigured(settings) && settings.enabled,
          run: () => testConnection(api),
        },
        {
          name: "jev.toggle",
          title: settings.enabled ? "Disable JEV" : "Enable JEV",
          namespace: "Integrations",
          description: "Keep the connection configured but stop calling out",
          enabled: isConfigured(settings),
          run: () => {
            const next = update(api, { enabled: !settingsOf(api).enabled })
            api.ui.toast({
              message: next.enabled ? "JEV enabled" : "JEV disabled",
              variant: next.enabled ? "success" : "info",
              duration: 3000,
            })
          },
        },
      ]
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
