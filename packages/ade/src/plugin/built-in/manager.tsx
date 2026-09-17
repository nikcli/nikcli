/**
 * ADE's own plugin manager, written as a v2 plugin.
 *
 * Deliberately: it is the only thing in this package that proves the pipe end
 * to end without a third-party plugin on disk. It registers a command, a pane
 * and a sidebar section — one of each of the three surfaces the adapter
 * offers — so if any of them stops being wired, the manager stops appearing
 * and someone notices on the next launch rather than the next bug report.
 *
 * The TUI's equivalent is `feature-plugins/system/plugins`, and this is the
 * same idea shrunk to what ADE can honestly do: there is no enable/disable
 * here, because without a config writer and a watcher a toggle would be a
 * button that forgets.
 */
import { For, Show } from "solid-js"
import { Plugin } from "@nikcli-ai/plugin/v2/ade"
import type { PluginRegistry } from "../registry"
import type { PluginStatus } from "../runtime"
import { contributionLabel, managerRows, managerSummary, type ManagerRow } from "./manager-rows"
import "./manager.css"
import { t } from "../../i18n"

export const MANAGER_ID = "ade.plugins"

function Rows(props: { rows: ManagerRow[]; dense?: boolean }) {
  return (
    <Show
      when={props.rows.length > 0}
      fallback={<p data-slot="plugin-empty">{t("settings.noPlugins")}</p>}
    >
      <ul data-slot="plugin-list" data-dense={props.dense ? "true" : undefined}>
        <For each={props.rows}>
          {(row) => (
            <li data-slot="plugin-row" data-active={row.active ? "true" : undefined}>
              <span data-slot="plugin-dot" aria-hidden="true" />
              <div data-slot="plugin-body">
                {/*
                  Text nodes, every one of them. The id and the spec come from
                  a third party, and the only reason they can be shown at all
                  is that Solid escapes what it interpolates — see ../trust.ts
                  for what is checked before a string gets this far.
                */}
                <span data-slot="plugin-id" title={row.spec}>
                  {row.id}
                </span>
                <Show when={row.error}>
                  <span data-slot="plugin-error">{row.error}</span>
                </Show>
                <Show when={!row.error && contributionLabel(row)}>
                  {(label) => <span data-slot="plugin-meta">{label()}</span>}
                </Show>
              </div>
              <span data-slot="plugin-source">{row.source === "internal" ? "interno" : "progetto"}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/**
 * Builds the manager over one runtime's state.
 *
 * A factory rather than a module-level definition because both accessors are
 * the runtime's own: reading them through a closure keeps the rows reactive,
 * and there is exactly one runtime per window to close over.
 */
export function createManagerPlugin(status: () => PluginStatus[], registry: PluginRegistry) {
  const rows = () =>
    managerRows({
      status: status(),
      commands: registry.commands(),
      panes: registry.panes(),
      sections: registry.sections(),
    })

  return Plugin.define({
    id: MANAGER_ID,
    setup(context) {
      context.ui.pane.register({
        name: "overview",
        title: "Plugin",
        render: () => (
          <div data-component="plugin-overview">
            <p data-slot="plugin-summary">{managerSummary(rows())}</p>
            <Rows rows={rows()} />
          </div>
        ),
      })

      context.ui.section.register({
        name: "installed",
        title: "Plugin",
        render: () => (
          <div data-component="plugin-section">
            <Rows rows={rows()} dense />
          </div>
        ),
      })

      context.ui.command.register({
        id: "overview",
        title: "Mostra i plugin caricati",
        group: "Plugin",
        keywords: ["estensioni", "componenti", "aggiuntivi"],
        run: () => {
          /*
           * One tile, not one per invocation.
           *
           * `pane.open` is happy to make a second; the command should not.
           * Running it twice from the palette used to be the obvious way to
           * end up with two identical panels and no way to tell them apart.
           */
          const existing = context.ui.pane.list().find((pane) => pane.name === "overview")
          if (existing) return
          context.ui.pane.open({ name: "overview" })
        },
      })
    },
  })
}
