import { describe, expect, test } from "bun:test"
import { appendTextToPrompt, removeMentionTrigger } from "./prompt-append"
import type { Prompt } from "./prompt"

const textPart = (content: string) => ({ type: "text" as const, content, start: 0, end: content.length })
const filePart = (path: string) => ({ type: "file" as const, path, content: `@${path}`, start: 0, end: path.length })
const agentPart = (name: string) => ({ type: "agent" as const, name, content: `@${name}`, start: 0, end: name.length })
const imagePart = () => ({
  type: "image" as const,
  id: "img-1",
  filename: "shot.png",
  mime: "image/png",
  dataUrl: "data:image/png;base64,AAA",
})

describe("appendTextToPrompt", () => {
  test("appends to an empty composer without a leading blank line", () => {
    expect(appendTextToPrompt([textPart("")], "block")).toEqual([textPart("block")])
  })

  test("separates the block from what was already typed", () => {
    const result = appendTextToPrompt([textPart("fix this:")], "block")
    expect(result).toHaveLength(1)
    expect((result[0] as { content: string }).content).toBe("fix this:\n\nblock")
  })

  test("does not stack blank lines when the composer already ends in whitespace", () => {
    const result = appendTextToPrompt([textPart("fix this:\n\n  ")], "block")
    expect((result[0] as { content: string }).content).toBe("fix this:\n\nblock")
  })

  test.each([
    ["a file mention", filePart("src/app.ts")],
    ["an agent mention", agentPart("reviewer")],
    ["a pasted image", imagePart()],
  ])("keeps %s that comes before the text", (_name, part) => {
    const before: Prompt = [part as Prompt[number], textPart(" fix this:")]
    const result = appendTextToPrompt(before, "block")
    expect(result[0]).toEqual(part as Prompt[number])
    expect(result).toHaveLength(2)
  })

  test("keeps every attachment, not just the first", () => {
    const before: Prompt = [filePart("a.ts"), imagePart(), agentPart("reviewer"), textPart("go")]
    const result = appendTextToPrompt(before, "block")
    expect(result.slice(0, 3)).toEqual(before.slice(0, 3))
  })

  test("adds its own part when the prompt ends on an attachment", () => {
    const before: Prompt = [textPart("look at "), filePart("a.ts")]
    const result = appendTextToPrompt(before, "block")
    expect(result).toHaveLength(3)
    expect(result[2]).toEqual(textPart("block"))
    // The text already typed is untouched, not merged into the tail.
    expect(result[0]).toEqual(textPart("look at "))
  })

  test("appending twice keeps both blocks and all attachments", () => {
    const once = appendTextToPrompt([imagePart(), textPart("a")], "first")
    const twice = appendTextToPrompt(once, "second")
    expect(twice[0]).toEqual(imagePart())
    expect((twice[1] as { content: string }).content).toBe("a\n\nfirst\n\nsecond")
  })

  test("empty text changes nothing at all", () => {
    const before: Prompt = [filePart("a.ts"), textPart("x")]
    expect(appendTextToPrompt(before, "")).toBe(before)
  })

  test("does not mutate the prompt it was given", () => {
    const before: Prompt = [textPart("x")]
    const snapshot = JSON.stringify(before)
    appendTextToPrompt(before, "block")
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe("removeMentionTrigger", () => {
  test("drops the trigger the menu was opened with", () => {
    const result = removeMentionTrigger([textPart("fix this: @")])
    expect((result[0] as { content: string }).content).toBe("fix this: ")
  })

  test("drops the partial query typed after it", () => {
    const result = removeMentionTrigger([textPart("look at @term")])
    expect((result[0] as { content: string }).content).toBe("look at ")
  })

  test("leaves an address alone, because it is not at the caret as a trigger", () => {
    // Only a trailing run is removed; an email mid-sentence keeps its @.
    const result = removeMentionTrigger([textPart("mail a@b.com and then")])
    expect((result[0] as { content: string }).content).toBe("mail a@b.com and then")
  })

  test("changes nothing when there is no trigger", () => {
    const before: Prompt = [textPart("plain text")]
    expect(removeMentionTrigger(before)).toBe(before)
  })

  test("changes nothing when the prompt ends on an attachment", () => {
    const before: Prompt = [textPart("see @"), filePart("a.ts")]
    expect(removeMentionTrigger(before)).toBe(before)
  })

  test("keeps every attachment before it", () => {
    const before: Prompt = [imagePart(), filePart("a.ts"), textPart(" and @")]
    const result = removeMentionTrigger(before)
    expect(result.slice(0, 2)).toEqual(before.slice(0, 2))
    expect((result[2] as { content: string }).content).toBe(" and ")
  })

  test("composes with appending, which is how it is used", () => {
    const cleaned = removeMentionTrigger([imagePart(), textPart("fix this: @")])
    const result = appendTextToPrompt(cleaned, "[Terminal 1]")
    expect(result[0]).toEqual(imagePart())
    expect((result[1] as { content: string }).content).toBe("fix this:\n\n[Terminal 1]")
  })
})
