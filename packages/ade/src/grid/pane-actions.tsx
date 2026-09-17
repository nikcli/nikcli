import type { JSX } from "solid-js"
import { t } from "../i18n"

/*
 * Expand and close, as every pane shows them at the right of its header.
 *
 * One component so a pane cannot get its own icons, sizes or rules: the
 * session pane had one set, the others copied another, and the video pane's
 * were never revealed at all (0.6.1). The styles are `.hA .act` in `pane.css`,
 * so the header this sits in carries `class="pill hA"`. `children` goes
 * before expand, for a pane's own button in the same row.
 */
export function PaneActions(props: { onExpand?: () => void; onClose?: () => void; children?: JSX.Element }) {
  return (
    <span class="acts" data-slot="pane-actions">
      {props.children}
      <button
        type="button"
        class="act"
        data-slot="pane-action"
        onClick={() => props.onExpand?.()}
        aria-label={t("pane.expand")}
        title={t("pane.expand")}
      >
        <svg class="gi" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="act"
        data-slot="pane-action"
        onClick={() => props.onClose?.()}
        aria-label={t("pane.close")}
        title={t("pane.close")}
      >
        <svg class="gi" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
    </span>
  )
}

/*
 * A folder. On a session it stands for the project directory, the one case
 * where the session runs without a tree of its own, so it gets a glyph of its
 * own: colour alone could not separate it from the milder degradations. On a
 * video pane it opens another file.
 */
export function FolderGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2.5 4.5a1 1 0 0 1 1-1h2.8l1.7 2h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />
    </svg>
  )
}
