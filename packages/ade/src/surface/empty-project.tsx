import { Show } from "solid-js"
import { t } from "../i18n"

export interface EmptyProjectProps {
  /** False in the browser build, where nothing can be read or run. */
  hasHost: boolean
  onOpenProject?: () => void
}

/**
 * What ADE shows before it has a project.
 *
 * Two different absences, and they must not be told the same way: no folder
 * chosen yet is a step away from working, while running in the browser is a
 * wall. The second one gets no button, because there is nothing behind it.
 */
export function EmptyProject(props: EmptyProjectProps) {
  return (
    <div data-component="ade-empty">
      <div data-slot="empty-card">
        <span data-slot="empty-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
            <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2.5 3h8.3A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
          </svg>
        </span>

        <h2 data-slot="empty-title">{t("empty.title")}</h2>

        <Show
          when={props.hasHost}
          fallback={
            <p data-slot="empty-text">
              {t("empty.browser")}
            </p>
          }
        >
          <p data-slot="empty-text">
            {t("empty.desktop")}
          </p>
          <button type="button" data-slot="empty-action" onClick={() => props.onOpenProject?.()}>
            {t("empty.open")}
          </button>
        </Show>
      </div>
    </div>
  )
}
