import type { ReplyVoice } from "./model"
import { t } from "@nikcli-ai/ade/i18n"

/**
 * D19, in the user's words: «ugo per maschile, e piper per femminile,
 * selezionabile dalle impostazioni». Each Piper voice states its licence where
 * it is chosen: both derive from the English lessac voice, whose dataset is
 * licensed for research only.
 */
export const REPLY_VOICE_CHOICES: readonly {
  value: ReplyVoice
  title: string
  desc: string
  licence?: string
}[] = [
  {
    value: "ugo",
    get title() { return t("vui.reply.male") },
    get desc() { return t("vui.reply.ugo") },
    get licence() { return t("vui.reply.ugo.licence") },
  },
  {
    value: "paola",
    get title() { return t("vui.reply.female") },
    get desc() { return t("vui.reply.paola") },
    get licence() { return t("vui.reply.paola.licence") },
  },
  { value: "system", get title() { return t("vui.reply.system") }, get desc() { return t("vui.reply.system.desc") } },
]
