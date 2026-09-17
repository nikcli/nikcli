/**
 * What a take must never show (S36): the fields that hold a secret.
 *
 * Covered by the page itself for as long as a take runs, so the value is never
 * drawn and no frame can contain it. The rule lives in `index.css` under
 * `html[data-ade-recording]`, and does not wait for every field to be marked:
 * a password input is a secret whether or not someone remembered
 * `data-sensitive`, and the OpenRouter key field turns into plain text when
 * «Mostra» is pressed.
 */

export const SENSITIVE_SELECTOR = '[data-sensitive], input[type="password"], #openrouter-key-field'

export const RECORDING_ATTRIBUTE = "data-ade-recording"

/** Covers or uncovers the secret fields; the user sees them covered too while filming. */
export function coverSecrets(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.setAttribute(RECORDING_ATTRIBUTE, "")
  else root.removeAttribute(RECORDING_ATTRIBUTE)
}
