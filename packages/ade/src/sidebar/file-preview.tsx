import { Show, createSignal, createEffect, onCleanup } from "solid-js"
import { getHost } from "../host/shell"
import { basename } from "../host/path"
import { t } from "../i18n"

export interface FilePreviewProps {
  path: string
}

export function FilePreview(props: FilePreviewProps) {
  const [content, setContent] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    const path = props.path
    if (!path) return

    /*
     * Cancellation registered through `onCleanup`, not returned.
     *
     * Returning a function from a Solid effect is a React habit that Solid
     * reads as a value: the return becomes the `prev` argument of the next
     * run, and is never called. So `cancelled` was never set, and switching
     * files fast meant two reads in flight with no ordering between them —
     * the slower one won, and the preview showed a different file from the
     * one selected in the tree.
     */
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })

    setLoading(true)
    setError(null)
    setContent(null)

    getHost().then((host) => {
      if (cancelled) return
      if (!host?.readTextFile) {
        setError(t("preview.noHost"))
        setLoading(false)
        return
      }

      host.readTextFile(path, 1_048_576).then((res) => {
        if (cancelled) return
        if (res.bytes === 0 && res.text === "") {
          // Is it an error or empty?
          setContent("")
        } else if (res.text === "" && res.bytes > 0) {
          setError(t("preview.binary"))
        } else {
          setContent(res.text)
          if (res.truncated) {
            setError(t("preview.truncated"))
          }
        }
        setLoading(false)
      })
    })
  })

  return (
    <div data-component="file-preview">
      <header data-slot="preview-header">
        <span data-slot="preview-title">{basename(props.path)}</span>
      </header>
      <div data-slot="preview-body">
        <Show when={loading()}>
          <div data-slot="preview-message">{t("preview.loading")}</div>
        </Show>
        <Show when={error()}>
          <div data-slot="preview-message" data-error="true">
            {error()}
          </div>
        </Show>
        <Show when={content() !== null}>
          <pre data-slot="preview-content">
            <code>
              {content()
                ?.split("\n")
                .map((line, i) => (
                  <div data-slot="preview-line">
                    <span data-slot="preview-line-num">{i + 1}</span>
                    <span data-slot="preview-line-text">{line}</span>
                  </div>
                ))}
            </code>
          </pre>
        </Show>
      </div>
    </div>
  )
}
