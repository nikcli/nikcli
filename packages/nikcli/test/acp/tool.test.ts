import { describe, expect, test } from "bun:test"
import {
  ACPTool,
  buildCompletedToolUpdate,
  buildErrorToolUpdate,
  buildPendingToolCall,
  buildRunningToolUpdate,
  completedToolContent,
  completedToolRawOutput,
  imageContents,
  shellOutputSnapshot,
  toLocations,
  toToolKind,
} from "@/acp/tool"

describe("acp/tool", () => {
  test("toToolKind maps known tool names to ACP kinds", () => {
    expect(toToolKind("bash")).toBe("execute")
    expect(toToolKind("edit")).toBe("edit")
    expect(toToolKind("write")).toBe("edit")
    expect(toToolKind("plugin")).toBe("edit")
    expect(toToolKind("read")).toBe("read")
    expect(toToolKind("grep")).toBe("search")
    expect(toToolKind("webfetch")).toBe("fetch")
    expect(toToolKind("task")).toBe("think")
    expect(toToolKind("unknown-tool")).toBe("other")
  })

  test("toToolKind uses the ids the registry actually emits", () => {
    // The registry id is `list`; the mapping used to only carry `ls`, so every
    // real call degraded to "other".
    expect(toToolKind("list")).toBe("search")
    expect(toToolKind("ls")).toBe("search")
    expect(toToolKind("memory_search")).toBe("search")
    // `plan` and `goal` are split into one id per operation.
    expect(toToolKind("plan_enter")).toBe("think")
    expect(toToolKind("plan_exit")).toBe("think")
    expect(toToolKind("create_goal")).toBe("think")
    expect(toToolKind("get_goal")).toBe("think")
    expect(toToolKind("update_goal")).toBe("think")
    expect(toToolKind("todoread")).toBe("other")
  })

  test("toLocations follows the list tool", () => {
    expect(toLocations("list", { path: "/repo" })).toEqual([{ path: "/repo" }])
  })

  test("toLocations extracts file paths from common inputs", () => {
    expect(toLocations("read", { filePath: "/a/b.txt" })).toEqual([{ path: "/a/b.txt" }])
    expect(toLocations("grep", { path: "/repo" })).toEqual([{ path: "/repo" }])
    expect(toLocations("bash", {}, "/workdir")).toEqual([{ path: "/workdir" }])
    expect(toLocations("unknown", {})).toEqual([])
  })

  test("shellOutputSnapshot extracts a stable string from metadata", () => {
    expect(shellOutputSnapshot({})).toBeUndefined()
    expect(shellOutputSnapshot({ metadata: { output: "hello" } })).toBe("hello")
    expect(shellOutputSnapshot({ metadata: { output: 42 } })).toBeUndefined()
  })

  test("imageContents pulls image attachments out of tool attachments", () => {
    const out = imageContents([
      { url: "data:image/png;base64,AAAA" },
      { mime: "image/jpeg", url: "data:image/jpeg;base64,BBBB" },
      { url: "data:text/plain;base64,CCCC" },
      {},
    ])
    expect(out).toHaveLength(2)
    expect(out[0]?.type).toBe("content")
    if (out[0]?.type === "content") {
      expect(out[0].content.type).toBe("image")
    }
  })

  test("completedToolContent emits text plus diff for edit tools", () => {
    const content = completedToolContent("edit", {
      status: "completed",
      input: { filePath: "/f", oldString: "a", newString: "b" },
      output: "ok",
    })
    expect(content).toHaveLength(2)
    expect(content[0]?.type).toBe("content")
    expect(content[1]?.type).toBe("diff")
  })

  test("completedToolRawOutput omits metadata when undefined", () => {
    expect(completedToolRawOutput({ status: "completed", input: {}, output: "x" })).toEqual({ output: "x" })
  })

  test("buildPendingToolCall + buildRunningToolUpdate + buildCompletedToolUpdate + buildErrorToolUpdate all return valid shapes", () => {
    const pending = buildPendingToolCall({
      toolCallId: "call-1",
      toolName: "edit",
      state: { input: { filePath: "/a" }, title: "Edit /a" },
      cwd: "/work",
    })
    expect(pending.status).toBe("pending")
    expect(pending.title).toBe("Edit /a")

    const running = buildRunningToolUpdate({
      toolCallId: "call-1",
      toolName: "edit",
      state: { status: "running", input: { filePath: "/a" }, title: "Edit /a" },
      output: "writing…",
      cwd: "/work",
    })
    expect(running.status).toBe("in_progress")
    expect(running.content?.[0]?.type).toBe("content")

    const completed = buildCompletedToolUpdate({
      toolCallId: "call-1",
      toolName: "edit",
      state: {
        status: "completed",
        input: { filePath: "/a", oldString: "a", newString: "b" },
        output: "done",
        title: "Edit /a",
      },
      cwd: "/work",
    })
    expect(completed.status).toBe("completed")
    expect(completed.content?.[1]?.type).toBe("diff")

    const errored = buildErrorToolUpdate({
      toolCallId: "call-1",
      toolName: "edit",
      state: { status: "error", input: {}, error: "boom" },
      cwd: "/work",
    })
    expect(errored.status).toBe("failed")
  })

  test("namespace exports point at the named helpers", () => {
    expect(ACPTool.mapToolKind).toBe(toToolKind)
    expect(ACPTool.buildPendingToolCall).toBe(buildPendingToolCall)
    expect(ACPTool.extractShellOutputSnapshot).toBe(shellOutputSnapshot)
  })
})
