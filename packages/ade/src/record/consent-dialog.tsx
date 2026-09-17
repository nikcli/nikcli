import { createSignal } from "solid-js"
import { Overlay, Surface } from "../ui/layout"
import type { RecordConsent } from "./record-panel"
import type { RecordTarget } from "./recording"
import { t } from "../i18n"

/**
 * The question ADE asks before an agent films it (S36).
 *
 * Every take, no remembered yes: a video shows everything on screen for as
 * long as it runs. The microphone is a separate switch, off until the user
 * turns it on for this take. Esc, a click outside and «No» all refuse, because
 * the safe answer must be the one you get by doing nothing.
 */
export function RecordConsentDialog(props: { target: RecordTarget; onAnswer: (answer: RecordConsent) => void }) {
  const [mic, setMic] = createSignal(false)
  const refuse = () => props.onAnswer({ allowed: false, mic: false })
  const what = () =>
    props.target.kind === "pane" ? t("record.consent.pane", props.target.paneId) : t("record.consent.window")
  return (
    <Overlay
      data-component="record-consent"
      place="center"
      onClose={refuse}
      onKeyDown={(event) => {
        if (event.key === "Escape") refuse()
      }}
    >
      <Surface size="sm" role="alertdialog" aria-modal="true" aria-label={t("record.consent.label")}>
        <header data-slot="sheet-head">
          <strong>{t("record.consent.title")}</strong>
        </header>
        <div data-slot="record-consent-body">
          <p>{t("record.consent.ask", what())}</p>
          <p data-slot="record-consent-note">{t("record.consent.note")}</p>
          <label data-slot="record-consent-mic">
            <input type="checkbox" checked={mic()} onChange={(event) => setMic(event.currentTarget.checked)} />
            {t("record.consent.mic")}
          </label>
        </div>
        <footer data-slot="record-consent-actions">
          <button
            type="button"
            data-slot="decision-ghost"
            ref={(button) => queueMicrotask(() => button.focus())}
            onClick={refuse}
          >
            {t("record.consent.no")}
          </button>
          <button
            type="button"
            data-slot="decision-submit"
            onClick={() => props.onAnswer({ allowed: true, mic: mic() })}
          >
            {t("record.consent.yes")}
          </button>
        </footer>
      </Surface>
    </Overlay>
  )
}
