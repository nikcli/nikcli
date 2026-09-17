/**
 * The tile a plugin pane is drawn in.
 *
 * Reuses `session-pane`'s own `data-component` and slots rather than
 * introducing a parallel set of chrome styles: a plugin's tile sits in the
 * same grid, next to sessions and browsers, and one that looked different
 * would read as a different kind of object than it is. Only the body is the
 * plugin's; the header, the focus ring and the two window buttons are ADE's,
 * and stay ADE's — a plugin that could draw its own close button could draw
 * one that does not close.
 */
import { ErrorBoundary, Show, type JSX } from "solid-js"
import { t } from "../i18n"

export interface PluginPaneProps {
  id: string
  title: string
  focused?: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
  /** Called as the plugin's `render`, inside an error boundary. */
  render: () => JSX.Element
}

export function PluginPane(props: PluginPaneProps) {
  return (
    <article
      data-component="session-pane"
      data-pane-id={props.id}
      data-status="done"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" title={props.title}>
          <span data-slot="pane-glyph" aria-hidden="true">
            ⧉
          </span>
        </span>
        <h2 data-slot="pane-title" title={props.title}>
          {props.title}
        </h2>
        <div data-slot="pane-actions">
          <button
            type="button"
            data-slot="pane-action"
            onClick={() => props.onExpand?.()}
            aria-label={t("pane.expand")}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M1 4.5V1h3.5M11 7.5V11H7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path
                d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      {/*
        A plugin that throws while rendering takes its own tile down and
        nothing else. Without the boundary the throw propagates to the grid,
        which is rendering every other session in the same tree — one bad
        plugin would blank the whole workbench, agents included.
      */}
      <div data-slot="pane-plugin">
        <ErrorBoundary
          fallback={(error: unknown) => (
            <div data-slot="pane-plugin-error" role="alert">
              <p>{t("plugins.renderFailed")}</p>
              <Show when={error instanceof Error ? error.message : String(error)}>
                {(text) => <code>{text()}</code>}
              </Show>
            </div>
          )}
        >
          {props.render()}
        </ErrorBoundary>
      </div>
    </article>
  )
}

/**
 * One sidebar section, with the same boundary for the same reason.
 *
 * The sidebar is one component for the whole column: a section that throws
 * would take the project list and the file tree with it.
 */
export function PluginSection(props: { title: string; render: () => JSX.Element }) {
  return (
    <section data-slot="sidebar-section-plugin">
      <div data-slot="sidebar-section-title">{props.title}</div>
      <ErrorBoundary
        fallback={
          <div data-slot="sidebar-section-error" role="alert">
            {t("plugins.sectionFailed")}
          </div>
        }
      >
        {props.render()}
      </ErrorBoundary>
    </section>
  )
}
