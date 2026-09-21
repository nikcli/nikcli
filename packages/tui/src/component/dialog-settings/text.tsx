import { createMemo } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useKV } from "@tui/context/kv"
import {
  DEFAULT_SESSION_STYLE,
  hasSessionStyle,
  readSessionStyle,
  writeSessionStyle,
  type SessionStyleRecipe,
} from "@tui/context/session-style"
import { DialogSettings } from "./index"

/**
 * How the TUI sets its words.
 *
 * Worth saying plainly, because the setting people look for here is not the one
 * that exists: **the typeface is your terminal's**. A program drawing into a
 * terminal cannot choose a font; it chooses which cells it writes and which
 * attributes it asks for. So what is on offer is weight and dimming — and those
 * are not a consolation prize, they are most of what makes a transcript read as
 * dense or as airy.
 *
 * The values are the same recipe `/studio` edits, stored per session or
 * globally, so changing it here and changing it there are the same change.
 */
const EMPHASIS: ReadonlyArray<{
  value: SessionStyleRecipe["emphasis"]
  title: string
  description: string
}> = [
  {
    value: "regular",
    title: "Regular",
    description: "Titles bold, body and detail at their normal weight",
  },
  {
    value: "quiet",
    title: "Quiet",
    description: "Body and metadata dimmed, titles unbolded — the transcript steps back",
  },
  {
    value: "strong",
    title: "Strong",
    description: "Body bolded and nothing dimmed — for a bright terminal or a projector",
  },
]

export function DialogSettingsText() {
  const dialog = useDialog()
  const kv = useKV()

  const current = createMemo(() => (hasSessionStyle(kv) ? readSessionStyle(kv) : DEFAULT_SESSION_STYLE))

  const options = createMemo((): DialogSelectOption<SessionStyleRecipe["emphasis"]>[] =>
    EMPHASIS.map((entry) => ({
      title: entry.title,
      value: entry.value,
      description: entry.description,
      category: "Emphasis",
      // The current value carries the check, because a list of three options
      // with no indication of which is live is a list you have to leave to
      // find out.
      footer: entry.value === current().emphasis ? "current" : undefined,
    })),
  )

  return (
    <DialogSelect
      title="Text"
      placeholder="Weight and dimming — the typeface is your terminal's"
      options={options()}
      onSelect={(option) => {
        writeSessionStyle(kv, "global", { ...current(), emphasis: option.value })
        dialog.replace(() => <DialogSettings />)
      }}
      back={() => dialog.replace(() => <DialogSettings />)}
    />
  )
}
