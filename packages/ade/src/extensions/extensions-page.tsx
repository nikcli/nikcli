import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js"
import {
  afterInstallHint,
  cardAction,
  CATALOG_FILTERS,
  filterCatalog,
  installedServers,
  monogram,
  transportLabel,
  type CatalogFilter,
  type InstalledServer,
} from "./extensions"
import { MCP_CATALOG, type McpCatalogEntry } from "./mcp-catalog"
import { addMcpServerToProject, MCP_CONFIG_FILENAME, readProjectMcpConfig, removeMcpServerFromProject, type McpConfigIO } from "./mcp-config"
import "./extensions.css"
import { t } from "../i18n"
import { catalogText } from "./catalog-en"

/*
 * Logos are files in this folder, bundled at build time: Simple Icons (CC0,
 * pinned in `logos/SOURCES.md`) and the vendors' own SVGs where one was
 * verified. Nothing is fetched at runtime, so opening the page tells no
 * logo host which servers the user looks at, and it works offline.
 */
const LOGO_URLS = import.meta.glob("./logos/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>

function logoUrl(entry: McpCatalogEntry): { url: string; mono: boolean } | undefined {
  const file = entry.logo.kind === "simple-icons" ? `${entry.logo.id}.svg` : entry.logo.file
  const url = LOGO_URLS[`./logos/${file}`]
  // Simple Icons are single-colour marks, drawn in the theme's ink; official files keep their colours.
  return url ? { url, mono: entry.logo.kind === "simple-icons" } : undefined
}

function Logo(props: { entry?: McpCatalogEntry; name: string }) {
  const logo = () => (props.entry ? logoUrl(props.entry) : undefined)
  return (
    <Show
      when={logo()}
      fallback={
        <span data-slot="ext-logo" data-monogram="true" aria-hidden="true">
          {monogram(props.entry?.name ?? props.name)}
        </span>
      }
    >
      {(found) =>
        found().mono ? (
          <span
            data-slot="ext-logo"
            data-mono="true"
            aria-hidden="true"
            style={{ "mask-image": `url("${found().url}")`, "-webkit-mask-image": `url("${found().url}")` }}
          />
        ) : (
          <span data-slot="ext-logo" aria-hidden="true">
            <img src={found().url} alt="" />
          </span>
        )
      }
    </Show>
  )
}

export type ExtensionsTab = "installati" | "catalogo" | "plugin"

/**
 * Impostazioni › Estensioni: MCP servers and ADE plugins on one page.
 *
 * Installing writes only the project's `.mcp.json`, which Claude Code and the
 * other CLIs read when a session starts there; nothing global, and no secret
 * values — a definition carries `${VARIABILE}` references the agent resolves
 * from its environment.
 */
export function ExtensionsPage(props: {
  projectRoot: string | undefined
  io: McpConfigIO | undefined
  /** The plugin rows, as the settings panel already renders them. */
  plugins: () => JSX.Element
  pluginCount: number
  onOpenGuide: (url: string) => void
}) {
  const [tab, setTab] = createSignal<ExtensionsTab>("catalogo")
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<CatalogFilter>("tutti")
  const [busy, setBusy] = createSignal<string>()
  const [notice, setNotice] = createSignal<{ tone: "ok" | "error"; text: string }>()

  const [config, { refetch }] = createResource(
    () => (props.projectRoot && props.io ? props.projectRoot : undefined),
    async (root) => {
      try {
        return { raw: await readProjectMcpConfig(root, props.io!) }
      } catch (failure) {
        return { raw: undefined, error: failure instanceof Error ? failure.message : String(failure) }
      }
    },
  )

  const installed = createMemo<{ servers: InstalledServer[]; error?: string }>(() => {
    const current = config()
    if (!current) return { servers: [] }
    if (current.error) return { servers: [], error: current.error }
    try {
      return { servers: installedServers(current.raw) }
    } catch (failure) {
      return { servers: [], error: failure instanceof Error ? failure.message : String(failure) }
    }
  })

  const cards = createMemo(() => filterCatalog(MCP_CATALOG, query(), filter()))

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    if (busy()) return
    setBusy(key)
    setNotice(undefined)
    try {
      await action()
      setNotice({ tone: "ok", text: done })
      await refetch()
    } catch (failure) {
      setNotice({ tone: "error", text: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      setBusy(undefined)
    }
  }

  const add = (entry: McpCatalogEntry) =>
    run(
      entry.id,
      () => addMcpServerToProject(props.projectRoot!, entry.installation.config, props.io!),
      t("extensions.added", entry.name, MCP_CONFIG_FILENAME, afterInstallHint(entry)),
    )

  const remove = (server: InstalledServer) =>
    run(
      `rm:${server.name}`,
      () => removeMcpServerFromProject(props.projectRoot!, server.name, props.io!),
      t("extensions.removed", server.name, MCP_CONFIG_FILENAME),
    )

  const tabs: { id: ExtensionsTab; label: () => string }[] = [
    { id: "installati", label: () => t("extensions.tab.installed", installed().servers.length + props.pluginCount) },
    { id: "catalogo", label: () => t("extensions.tab.catalog", MCP_CATALOG.length) },
    { id: "plugin", label: () => t("extensions.tab.plugins", props.pluginCount) },
  ]

  return (
    <div data-component="extensions-page">
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {t("settings.extensions")}
        </h3>
        <p data-slot="section-desc">
          {t("extensions.desc", MCP_CONFIG_FILENAME)}
        </p>
      </div>

      <div data-slot="ext-tabs" role="tablist" aria-label={t("settings.extensions")}>
        <For each={tabs}>
          {(item) => (
            <button
              type="button"
              role="tab"
              data-slot="ext-tab"
              aria-selected={tab() === item.id}
              data-active={tab() === item.id ? "true" : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label()}
            </button>
          )}
        </For>
      </div>

      <Show when={notice()}>
        {(current) => (
          <p data-slot="ext-notice" data-tone={current().tone} role={current().tone === "error" ? "alert" : "status"}>
            {current().text}
          </p>
        )}
      </Show>
      <Show when={!props.projectRoot}>
        <p data-slot="ext-notice" data-tone="error">{t("extensions.noProject", MCP_CONFIG_FILENAME)}</p>
      </Show>

      <Show when={tab() === "catalogo"}>
        <div data-slot="ext-toolbar">
          <input
            type="search"
            data-slot="ext-search"
            placeholder={t("extensions.search")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            aria-label={t("extensions.search.label")}
          />
          <div data-slot="ext-filters" role="group" aria-label={t("extensions.filter")}>
            <For each={CATALOG_FILTERS}>
              {(item) => (
                <button
                  type="button"
                  data-slot="ext-filter"
                  aria-pressed={filter() === item.id}
                  data-active={filter() === item.id ? "true" : undefined}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={cards().length > 0} fallback={<p data-slot="settings-meta">{t("extensions.noMatch")}</p>}>
          <ul data-slot="ext-grid">
            <For each={cards()}>
              {(entry) => {
                const action = () => cardAction(entry, installed().servers)
                return (
                  <li data-slot="ext-card" data-origin={entry.origin}>
                    <div data-slot="ext-card-head">
                      <Logo entry={entry} name={entry.name} />
                      <div data-slot="ext-card-title">
                        <b>{entry.name}</b>
                        <Show when={entry.publisher !== entry.name}>
                          <span>{entry.publisher}</span>
                        </Show>
                      </div>
                      <span data-slot="ext-badge" data-origin={entry.origin}>
                        {entry.origin === "official" ? t("extensions.badge.official") : "community"}
                      </span>
                    </div>
                    <p data-slot="ext-card-desc">{catalogText(entry).description}</p>
                    <div data-slot="ext-card-meta">
                      <span>{transportLabel(entry.transport)}</span>
                      <span>{catalogText(entry).authentication}</span>
                    </div>
                    <Show when={entry.warning}>
                      <p data-slot="ext-warning">{catalogText(entry).warning}</p>
                    </Show>
                    <div data-slot="ext-card-actions">
                      <Show when={action().kind === "installed"}>
                        <span data-slot="ext-installed">{t("extensions.installed")}</span>
                        <Show when={installed().servers.find((server) => server.entry?.id === entry.id)?.note}>
                          {(note) => <span data-slot="settings-meta">{note()}</span>}
                        </Show>
                      </Show>
                      <Show when={action().kind === "add"}>
                        <button
                          type="button"
                          data-slot="settings-choice"
                          data-active="true"
                          disabled={!props.projectRoot || !props.io || busy() !== undefined}
                          onClick={() => void add(entry)}
                        >
                          {busy() === entry.id ? t("extensions.adding") : t("extensions.add")}
                        </button>
                      </Show>
                      <Show when={action().kind === "name-taken"}>
                        <span data-slot="ext-warning">
                          {t("extensions.nameTaken", entry.installation.config.name, MCP_CONFIG_FILENAME)}
                        </span>
                      </Show>
                      <Show when={action().kind === "guide"}>
                        <button
                          type="button"
                          data-slot="settings-choice"
                          onClick={() => props.onOpenGuide(entry.installation.guideUrl)}
                          title={t("extensions.guide.tip")}
                        >
                          {t("extensions.guide")}
                        </button>
                      </Show>
                      <button type="button" data-slot="ext-link" onClick={() => props.onOpenGuide(entry.sourceUrl)}>
                        {t("extensions.source")}
                      </button>
                    </div>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={tab() === "installati"}>
        <h4 data-slot="ext-group">{t("extensions.group.servers")}</h4>
        <Show when={installed().error}>
          <p data-slot="ext-notice" data-tone="error">{installed().error}</p>
        </Show>
        <Show
          when={installed().servers.length > 0}
          fallback={<p data-slot="settings-meta">{t("extensions.noServers", MCP_CONFIG_FILENAME)}</p>}
        >
          <ul data-slot="ext-installed-list">
            <For each={installed().servers}>
              {(server) => (
                <li data-slot="ext-row">
                  <Logo entry={server.entry} name={server.name} />
                  <div data-slot="ext-row-text">
                    <b>{server.entry?.name ?? server.name}</b>
                    <code>{server.detail || t("extensions.incomplete")}</code>
                    <Show when={server.note}>
                      <span data-slot="settings-meta">{server.note}</span>
                    </Show>
                    <Show when={server.variables.length > 0}>
                      <span data-slot="settings-meta">{t("extensions.variables", server.variables.join(", "))}</span>
                    </Show>
                  </div>
                  <button
                    type="button"
                    data-slot="settings-choice"
                    disabled={busy() !== undefined}
                    onClick={() => void remove(server)}
                  >
                    {busy() === `rm:${server.name}` ? t("extensions.removing") : t("hooks.remove")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <h4 data-slot="ext-group">{t("extensions.group.plugins")}</h4>
        {props.plugins()}
      </Show>

      <Show when={tab() === "plugin"}>{props.plugins()}</Show>
    </div>
  )
}
