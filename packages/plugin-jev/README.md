# @nikcli-ai/plugin-jev

[JEV Trader](https://jev-trader.vercel.app/) in the nikcli TUI: account and P&L, open positions,
watchlist quotes, and what the JEV agent is calling — behind `/jev`.

An installable TUI plugin, not a built-in: it is loaded from your nikcli config like any other
plugin, and it talks to the host only through the public plugin api.

**Read-only by design.** The plugin never places, changes or closes an order. A terminal panel that
could is one mis-keyed `j` away from a real loss.

## Install

```bash
nikcli plug install @nikcli-ai/plugin-jev     # once published
nikcli plug install ./packages/plugin-jev     # from a checkout
nikcli plug list
```

`plug install` adds the plugin to the `plugin` list in the nearest `nikcli.json`. You can also add
it by hand:

```jsonc
{
  "plugin": ["@nikcli-ai/plugin-jev"],
}
```

## Use

| Command                           | What it opens                                                       |
| --------------------------------- | ------------------------------------------------------------------- |
| `/jev` (`/jev-trader`, `/trader`) | The portfolio, or the connect prompt when nothing is configured yet |
| `jev.settings`                    | Endpoint, API key, prefix, watchlist, display currency              |
| `jev.portfolio`                   | Account, open positions, watchlist quotes                           |
| `jev.signals`                     | What the JEV agent is calling right now                             |
| `jev.test`                        | One request, reported as a toast                                    |
| `jev.toggle`                      | Keep the connection configured but stop calling out                 |

The `jev.*` commands are also in the command palette, under **Integrations**.

## Configuration

Settings live in the TUI key-value store under `jev_trader`, edited from `/jev` — nothing lands in
a shared config file except the plugin entry itself.

| Setting          | Default                         | Notes                                                          |
| ---------------- | ------------------------------- | -------------------------------------------------------------- |
| Endpoint         | `https://jev-trader.vercel.app` | Any JEV deployment; a bare host is read as `https://`          |
| API prefix       | `/api`                          | Where the REST routes are mounted; `/` means none              |
| API key          | none                            | `NIKCLI_JEV_API_KEY` or `JEV_API_KEY` wins over the stored one |
| Watchlist        | empty                           | Tickers quoted in the portfolio sheet                          |
| Display currency | `USD`                           | Used when JEV does not say                                     |

The key is sent as both `authorization: Bearer …` and `x-api-key`, and is masked (`••••1234`)
everywhere it is shown.

## What it expects from JEV

Four `GET` routes under the prefix:

| Route                 | Read as                                           |
| --------------------- | ------------------------------------------------- |
| `/portfolio`          | Equity, cash, day and total P&L, currency         |
| `/positions`          | Symbol, side, quantity, entry and last price, P&L |
| `/quotes?symbols=A,B` | Symbol, price, change percent                     |
| `/signals`            | Symbol, action, confidence, rationale             |

The mapping is deliberately forgiving: field aliases (`equity` / `totalEquity` / `netLiquidation`),
numbers sent as strings, and lists wrapped in `{ data }`, `{ items }` or a named key are all read.
Anything genuinely missing renders as `—`, and each section reports its own error, so one dead route
does not blank the sheet.

Remote text is stripped of escape sequences and clamped before it reaches the screen buffer.

## Develop

```bash
bun test          # pure modules: settings, payload mapping, client
bun run typecheck
```
