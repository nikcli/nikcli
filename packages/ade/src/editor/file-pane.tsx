import { Show } from "solid-js"
import { Editor } from "./editor"
import type { Buffer } from "./buffer"
import "./file-pane.css"
import { t } from "../i18n"

export interface FilePaneProps {
  path: string
  buffer: Buffer | undefined
  loading?: boolean
  focused?: boolean
  onChange: (draft: string) => void
  onSave: () => void
  onRevert?: () => void
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}

/**
 * A file, in the grid, wearing the same chrome as everything else.
 *
 * Sessions, browsers and files are all panes: they close the same way, expand
 * the same way, and show focus the same way. An editor that opened somewhere
 * else would be a second kind of window to learn.
 *
 * The unsaved mark lives in the header rather than only in the editor's status
 * bar, because at four panes wide the status bar is the first thing to be
 * scrolled out of sight.
 */
export function FilePane(props: FilePaneProps) {
  const name = () => props.path.split(/[\\/]/).pop() ?? props.path

  return (
    <article
      data-component="file-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          >
            <path d="M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z" />
            <path d="M9 1.5V5h3.5" />
          </svg>
        </span>
        <h2 data-slot="pane-title" title={props.path}>
          {name()}
          <Show when={props.buffer?.dirty}>
            <span data-slot="pane-dirty" title={t("editor.unsaved")}>
              •
            </span>
          </Show>
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

      <div data-slot="pane-editor">
        <Editor
          buffer={props.buffer}
          loading={props.loading}
          onChange={props.onChange}
          onSave={props.onSave}
          onRevert={props.onRevert}
        />
      </div>
    </article>
  )
}
