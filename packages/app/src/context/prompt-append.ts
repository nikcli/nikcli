import type { Prompt, TextPart } from "./prompt"

/**
 * Add a block of text to the end of what the user has already composed.
 *
 * Two call sites reach for this — the terminal's "send output to chat" and the
 * visual editor's element capture — and both used to do it by flattening the
 * prompt to its text and replacing the whole thing:
 *
 *     prompt.current().map((p) => (p.type === "text" ? p.content : "")).join("")
 *
 * which maps every file mention, agent mention and pasted image to the empty
 * string and then throws the originals away. Attaching a screenshot, typing
 * "@src/app.ts fix this:" and pressing the button silently deleted both.
 *
 * The parts are kept and the text is appended to the last one when that is text,
 * so the editor still sees the canonical shape it renders from.
 */
export function appendTextToPrompt(prompt: Prompt, text: string): Prompt {
  if (!text) return prompt

  const parts = [...prompt]
  const last = parts[parts.length - 1]

  if (last?.type === "text") {
    const existing = last.content.replace(/\s+$/, "")
    // A blank line between what was typed and what was pasted in; nothing at all
    // when the composer was empty, so the block does not start on line three.
    const content = existing ? `${existing}\n\n${text}` : text
    parts[parts.length - 1] = { ...last, content, start: 0, end: content.length } satisfies TextPart
    return parts
  }

  // The prompt ends on a pill: the text becomes its own part rather than being
  // merged into an attachment.
  return [...parts, { type: "text", content: text, start: 0, end: text.length }]
}

/**
 * Drop the `@query` the mention menu was opened with.
 *
 * `addPart` does this with a DOM range when it inserts a pill. An option that
 * inserts text instead has no pill to swap the trigger for, so without this the
 * `@` stays behind and gets sent to the agent as a stray character.
 */
export function removeMentionTrigger(prompt: Prompt): Prompt {
  const last = prompt[prompt.length - 1]
  if (last?.type !== "text") return prompt
  const content = last.content.replace(/@\S*$/, "")
  if (content === last.content) return prompt
  const parts = [...prompt]
  parts[parts.length - 1] = { ...last, content, start: 0, end: content.length } satisfies TextPart
  return parts
}
