/**
 * JEV Trader — internal TUI plugin.
 *
 * Mirrors `feature-plugins/background` and `feature-plugins/discord`: a
 * self-contained plugin that owns one integration end to end — its settings
 * (in the key-value store), its dialogs, and the commands that open them.
 * Nothing happens until the user connects an endpoint: an unconfigured
 * instance is silent, exactly like a background image with no source.
 *
 * `/jev` opens the portfolio when a key is available and the connect prompt
 * when it is not, the way `/discord` opens the manager or the token wizard.
 * Everything the plugin does is read-only — see the note in `./dialog`.
 */
import type { TuiPlugin, TuiPluginModule } from "@nikcli-ai/plugin/tui"
import { DialogJev, DialogJevConnect, DialogJevOverview, DialogJevSignals } from "./dialog"
import { endpointLabel, isAuthenticated, isConfigured, watchlistLabel } from "./settings"
import { readSettings, refresh, writeSettings } from "./store"

const id = "internal:jev"

const tui: TuiPlugin = async (api) => {
  // The runtime scopes the registration to the plugin's lifetime.
  api.keymap.registerLayer({
    commands: () => {
      const settings = readSettings(api.kv)
      const ready = isConfigured(settings) && isAuthenticated(settings)
      return [
        {
          name: "jev.open",
          title: "JEV Trader",
          namespace: "Integrations",
          description: ready
            ? `Portfolio and signals from ${endpointLabel(settings)}`
            : "Connect the JEV Trader terminal",
          slashName: "jev",
          slashAliases: ["jev-trader", "trader"],
          run() {
            api.ui.dialog.replace(() => (ready ? <DialogJevOverview /> : <DialogJevConnect />))
          },
        },
        {
          name: "jev.configure",
          title: "JEV settings",
          namespace: "Integrations",
          description: "Endpoint, API key, watchlist and auto-refresh",
          run() {
            api.ui.dialog.replace(() => <DialogJev />)
          },
        },
        {
          name: "jev.portfolio",
          title: "JEV portfolio",
          namespace: "Integrations",
          description: "Account, open positions and the watchlist",
          enabled: isConfigured(settings),
          run() {
            api.ui.dialog.replace(() => <DialogJevOverview />)
          },
        },
        {
          name: "jev.signals",
          title: "JEV signals",
          namespace: "Integrations",
          description: "What the JEV agent is calling right now",
          enabled: isConfigured(settings),
          run() {
            api.ui.dialog.replace(() => <DialogJevSignals />)
          },
        },
        {
          name: "jev.watchlist",
          title: "JEV watchlist",
          namespace: "Integrations",
          description: `Tickers quoted in the portfolio panel: ${watchlistLabel(settings.watchlist)}`,
          hidden: !isConfigured(settings),
          run() {
            api.ui.dialog.replace(() => <DialogJev />)
          },
        },
        {
          name: "jev.refresh",
          title: "JEV refresh",
          namespace: "Integrations",
          description: "Refetch whatever a JEV panel is showing",
          enabled: isConfigured(settings),
          run() {
            refresh.next()
            api.ui.toast({ message: "Refetching JEV…", variant: "info", duration: 2000 })
          },
        },
        {
          name: "jev.toggle",
          title: settings.enabled ? "Disable JEV" : "Enable JEV",
          namespace: "Integrations",
          description: "Keep the connection configured but stop calling out",
          enabled: isConfigured(settings),
          run() {
            const next = writeSettings(api.kv, { enabled: !readSettings(api.kv).enabled })
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
