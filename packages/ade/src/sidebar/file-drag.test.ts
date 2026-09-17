import { describe, expect, test } from "bun:test"
import {
  ADE_FILE_MIME,
  dragCarriesPaths,
  formatDroppedPaths,
  readDraggedPaths,
  writeDraggedPaths,
  type DragData,
} from "./file-drag"

/** A `DataTransfer` stand-in: the three methods these functions touch. */
function fakeTransfer(initial: Record<string, string> = {}): DragData & { store: Record<string, string> } {
  const store: Record<string, string> = { ...initial }
  return {
    store,
    get types() {
      return Object.keys(store)
    },
    getData: (format: string) => store[format] ?? "",
    setData: (format: string, data: string) => {
      store[format] = data
    },
  }
}

describe("dragging a folder", () => {
  test("a trailing slash survives the round trip", () => {
    // The slash is the only thing in the string that says "directory", and
    // `normalizePath` strips trailing slashes by design — correctly, for a
    // file. Losing it here turns `packages/ade/` into something that reads
    // like a file whose extension was forgotten.
    const data = fakeTransfer()
    writeDraggedPaths(data, ["C:/repo/packages/ade/"])
    expect(readDraggedPaths(data)).toEqual(["C:/repo/packages/ade/"])
  })

  test("a file keeps no slash it did not have", () => {
    const data = fakeTransfer()
    writeDraggedPaths(data, ["C:/repo/src/a.ts"])
    expect(readDraggedPaths(data)).toEqual(["C:/repo/src/a.ts"])
  })

  test("a dragged folder reaches the agent relative and marked", () => {
    expect(formatDroppedPaths(["C:/repo/packages/ade/"], "C:/repo")).toBe("packages/ade/")
  })

  test("a folder outside the project keeps its absolute path and its slash", () => {
    expect(formatDroppedPaths(["D:/altro/lib/"], "C:/repo")).toBe("D:/altro/lib/")
  })

  test("a folder with a space is quoted, slash included", () => {
    expect(formatDroppedPaths(["C:/repo/due parole/"], "C:/repo")).toBe('"due parole/"')
  })

  test("the project root dragged onto a session is '.', not nothing", () => {
    // Relative to itself the root is the empty string, which would reach the
    // agent as no argument at all — a drop that silently did nothing.
    expect(formatDroppedPaths(["C:/repo"], "C:/repo")).toBe(".")
    expect(formatDroppedPaths(["C:/repo/"], "C:/repo")).toBe(".")
  })

  test("backslashes from Windows still land as one normalised folder", () => {
    const data = fakeTransfer()
    writeDraggedPaths(data, ["C:\\repo\\packages\\ade\\"])
    expect(readDraggedPaths(data)).toEqual(["C:/repo/packages/ade/"])
  })
})

describe("writeDraggedPaths", () => {
  test("writes ADE's own type plus the two the rest of the world reads", () => {
    const data = fakeTransfer()
    writeDraggedPaths(data, ["C:/repo/src/a.ts"])

    expect(data.store[ADE_FILE_MIME]).toBe("C:/repo/src/a.ts")
    expect(data.store["text/plain"]).toBe("C:/repo/src/a.ts")
    expect(data.store["text/uri-list"]).toStartWith("file:///")
  })

  test("carries several paths", () => {
    const data = fakeTransfer()
    writeDraggedPaths(data, ["C:/repo/a.ts", "C:/repo/b.ts"])
    expect(readDraggedPaths(data)).toEqual(["C:/repo/a.ts", "C:/repo/b.ts"])
  })

  test("an empty drag writes nothing at all", () => {
    const data = fakeTransfer()
    writeDraggedPaths(data, ["", "   "])
    expect(Object.keys(data.store)).toEqual([])
  })
})

describe("readDraggedPaths", () => {
  test("round-trips what writeDraggedPaths produced", () => {
    const data = fakeTransfer()
    writeDraggedPaths(data, ["C:/repo/src/my file.ts"])
    expect(readDraggedPaths(data)).toEqual(["C:/repo/src/my file.ts"])
  })

  /*
   * A file dragged from Explorer or Finder arrives as `text/uri-list` and as
   * nothing else. Accepting it costs nothing and is the difference between a
   * gesture that works inside ADE and one that works.
   */
  test("reads a file dropped from the system file manager", () => {
    const data = fakeTransfer({
      "text/uri-list": "file:///C:/Users/x/repo/note.md\r\nfile:///C:/Users/x/repo/altro.ts",
    })
    expect(readDraggedPaths(data)).toEqual(["C:/Users/x/repo/note.md", "C:/Users/x/repo/altro.ts"])
  })

  test("decodes percent-escapes in a uri", () => {
    const data = fakeTransfer({ "text/uri-list": "file:///C:/repo/con%20spazio.ts" })
    expect(readDraggedPaths(data)).toEqual(["C:/repo/con spazio.ts"])
  })

  test("ignores the comment lines a uri-list may carry", () => {
    const data = fakeTransfer({ "text/uri-list": "# commento\r\nfile:///C:/repo/a.ts" })
    expect(readDraggedPaths(data)).toEqual(["C:/repo/a.ts"])
  })

  /*
   * The false positive that would matter: dragging a selected sentence onto
   * a pane must not insert it as though it were a filename.
   */
  test("plain text that is not a path is refused", () => {
    expect(readDraggedPaths(fakeTransfer({ "text/plain": "ciao come stai" }))).toEqual([])
    expect(readDraggedPaths(fakeTransfer({ "text/plain": "riga uno\nriga due" }))).toEqual([])
    expect(readDraggedPaths(fakeTransfer({ "text/plain": "" }))).toEqual([])
  })

  test("plain text that is a path is accepted", () => {
    expect(readDraggedPaths(fakeTransfer({ "text/plain": "src/a.ts" }))).toEqual(["src/a.ts"])
  })

  test("the same path twice is one path", () => {
    const data = fakeTransfer({ [ADE_FILE_MIME]: "C:/repo/a.ts\nC:/repo/a.ts" })
    expect(readDraggedPaths(data)).toEqual(["C:/repo/a.ts"])
  })

  test("an empty drag reads as no paths", () => {
    expect(readDraggedPaths(fakeTransfer())).toEqual([])
  })

  test("a getData that throws is not a crash", () => {
    const hostile: DragData = {
      getData: () => {
        throw new Error("no")
      },
    }
    expect(readDraggedPaths(hostile)).toEqual([])
  })

  test("reads files from OS file drop when present", () => {
    const data: DragData & { files: Array<{ path: string }> } = {
      getData: () => "",
      files: [{ path: "C:/Users/test/doc.txt" }],
    }
    expect(readDraggedPaths(data)).toEqual(["C:/Users/test/doc.txt"])
  })
})

describe("dragCarriesPaths", () => {
  test("recognises the three types plus Files", () => {
    expect(dragCarriesPaths(fakeTransfer({ [ADE_FILE_MIME]: "x" }))).toBe(true)
    expect(dragCarriesPaths(fakeTransfer({ "text/uri-list": "x" }))).toBe(true)
    expect(dragCarriesPaths(fakeTransfer({ "text/plain": "x" }))).toBe(true)
    expect(dragCarriesPaths(fakeTransfer({ Files: "x" }))).toBe(true)
  })

  test("a drag of something else is not offered a drop", () => {
    expect(dragCarriesPaths(fakeTransfer({ "image/png": "x" }))).toBe(false)
  })
})

describe("formatDroppedPaths", () => {
  /*
   * Relative to the project, because that is how a person refers to a file in
   * their own repository and how every agent reports one back. An absolute
   * `C:/Users/39349/Favorites/nikcli/...` in every prompt is noise that also
   * leaks the user's home directory into the conversation.
   */
  test("a file inside the project reads as a project path", () => {
    expect(formatDroppedPaths(["C:/repo/src/a.ts"], "C:/repo")).toBe("src/a.ts")
  })

  test("a file outside the project keeps the only name that identifies it", () => {
    expect(formatDroppedPaths(["D:/altrove/b.ts"], "C:/repo")).toBe("D:/altrove/b.ts")
  })

  test("with no project open, paths are left as they came", () => {
    expect(formatDroppedPaths(["C:/repo/src/a.ts"])).toBe("C:/repo/src/a.ts")
  })

  test("a trailing separator on the root does not eat the first character", () => {
    expect(formatDroppedPaths(["C:/repo/src/a.ts"], "C:/repo/")).toBe("src/a.ts")
  })

  test("the drive letter's case is not a difference the user made", () => {
    expect(formatDroppedPaths(["c:/repo/src/a.ts"], "C:/repo")).toBe("src/a.ts")
  })

  /*
   * The text goes to a terminal, where an unquoted space is an argument
   * boundary: `src/my file.ts` would reach the agent as two filenames.
   */
  test("a path containing a space is quoted", () => {
    expect(formatDroppedPaths(["C:/repo/my file.ts"], "C:/repo")).toBe('"my file.ts"')
  })

  test("several files are separated by spaces", () => {
    expect(formatDroppedPaths(["C:/repo/a.ts", "C:/repo/b.ts"], "C:/repo")).toBe("a.ts b.ts")
  })

  test("a drop of hundreds of files is capped rather than pasted whole", () => {
    const many = Array.from({ length: 500 }, (_, i) => `C:/repo/f${i}.ts`)
    expect(formatDroppedPaths(many, "C:/repo").split(" ")).toHaveLength(50)
  })

  test("nothing dropped is an empty string, not a stray space", () => {
    expect(formatDroppedPaths([], "C:/repo")).toBe("")
  })
})
