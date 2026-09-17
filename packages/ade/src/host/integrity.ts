/**
 * Whether a Windows folder carries the Low mandatory integrity label.
 *
 * On this kind of machine the checkout can live under `%USERPROFILE%\Favorites`,
 * which Windows labels Low on purpose (it is Internet Explorer's bookmarks
 * folder). The label is inherited by everything created inside, including
 * the `ade-desktop.exe` cargo builds. A process started from a Low image runs
 * at Low integrity, and so does everything it starts: nikcli then dies on
 * `EPERM` opening its log in `%LOCALAPPDATA%`, Claude Code cannot save its
 * transcript, Codex finds its database read-only. The fix is to label the
 * build output Medium before the binary is built.
 *
 * `icacls` prints the label in the machine's language — "Mandatory Label\Low
 * Mandatory Level" in English, "Etichetta obbligatoria\Livello obbligatorio
 * basso" in Italian — so both spellings are matched.
 */
export function hasLowLabel(icaclsOutput: string): boolean {
  return icaclsOutput
    .split(/\r?\n/)
    .some((line) => /Mandatory Label\\Low Mandatory Level|Livello obbligatorio basso/i.test(line))
}
