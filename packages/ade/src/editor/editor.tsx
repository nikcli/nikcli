import { createSignal, createMemo, Show, For } from "solid-js"
import { type Buffer, saveBlockedReason, lineCount, positionOf } from "./buffer"
import "./editor.css"
import { t } from "../i18n"

export interface EditorProps {
  buffer: Buffer | undefined
  loading?: boolean
  onChange: (draft: string) => void
  onSave: () => void
  onRevert?: () => void
}

export function Editor(props: EditorProps) {
  let gutterRef: HTMLDivElement | undefined
  let textareaRef: HTMLTextAreaElement | undefined

  const [cursor, setCursor] = createSignal({ line: 1, column: 1 })

  const saveBlocked = () => (props.buffer ? saveBlockedReason(props.buffer) : t("editor.noFile"))

  const totalLines = () => (props.buffer ? lineCount(props.buffer.draft) : 1)
  const lineNumbers = createMemo(() => {
    const count = totalLines()
    const result = new Array<number>(count)
    for (let i = 0; i < count; i++) {
      result[i] = i + 1
    }
    return result
  })

  const updateCursor = (e: Event & { currentTarget: HTMLTextAreaElement }) => {
    const offset = e.currentTarget.selectionStart ?? 0
    setCursor(positionOf(props.buffer?.draft ?? "", offset))
  }

  const handleInput = (e: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    props.onChange(e.currentTarget.value)
    updateCursor(e)
  }

  const handleScroll = (e: Event & { currentTarget: HTMLTextAreaElement }) => {
    if (gutterRef) {
      gutterRef.scrollTop = e.currentTarget.scrollTop
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault()
      if (props.buffer && !saveBlockedReason(props.buffer)) {
        props.onSave()
      }
    }
  }

  return (
    <div data-component="editor" onKeyDown={handleKeyDown} tabIndex={-1}>
      <Show when={props.loading}>
        <div data-slot="empty">{t("editor.loading")}</div>
      </Show>

      <Show when={!props.loading && !props.buffer}>
        <div data-slot="empty">{t("editor.noFile")}</div>
      </Show>

      <Show when={!props.loading && props.buffer}>
        {(buf) => (
          <>
            <Show when={buf().truncated}>
              <div data-slot="banner">
                {t("editor.truncatedBanner")}
              </div>
            </Show>

            <div data-slot="header">
              <div data-slot="file-info">
                <span data-slot="file-path" title={buf().path}>
                  {buf().path}
                </span>
                <span
                  data-slot="dirty-badge"
                  data-dirty={buf().dirty ? "true" : "false"}
                >
                  {buf().dirty ? t("editor.modified") : t("editor.saved")}
                </span>
              </div>

              <div data-slot="actions">
                <Show when={props.onRevert}>
                  <button
                    type="button"
                    data-slot="btn"
                    onClick={() => props.onRevert?.()}
                    disabled={!buf().dirty}
                    title={buf().dirty ? t("editor.revert.tip") : t("editor.revert.none")}
                  >
                    {t("editor.revert")}
                  </button>
                </Show>

                <button
                  type="button"
                  data-slot="btn"
                  data-variant="primary"
                  onClick={() => props.onSave()}
                  disabled={saveBlocked() !== undefined}
                  title={saveBlocked() ?? t("editor.save.tip")}
                >
                  {t("editor.save")}
                </button>
              </div>
            </div>

            <div data-slot="body">
              <div data-slot="gutter" ref={gutterRef} aria-hidden="true">
                <For each={lineNumbers()}>
                  {(num) => <span data-slot="gutter-line">{num}</span>}
                </For>
              </div>

              <div data-slot="textarea-wrap">
                <textarea
                  data-slot="textarea"
                  ref={textareaRef}
                  value={buf().draft}
                  onInput={handleInput}
                  onScroll={handleScroll}
                  onClick={updateCursor}
                  onKeyUp={updateCursor}
                  onSelect={updateCursor}
                  spellcheck={false}
                  aria-label={t("editor.label", buf().path)}
                />
              </div>
            </div>

            <div data-slot="statusbar">
              <div data-slot="status-section">
                <span data-slot="status-item" title={buf().path}>
                  <span data-slot="status-mono">{buf().path}</span>
                </span>
                <Show when={buf().truncated}>
                  <span data-slot="status-item" style={{ color: "var(--ade-working)" }}>
                    {t("editor.truncated")}
                  </span>
                </Show>
              </div>

              <div data-slot="status-section">
                <span data-slot="status-item">
                  <span data-slot="status-mono">
                    {t("editor.cursor", cursor().line, cursor().column)}
                  </span>
                </span>
                <span data-slot="status-item">
                  <span data-slot="status-mono">
                    {t("editor.lines", lineNumbers().length)}
                  </span>
                </span>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
