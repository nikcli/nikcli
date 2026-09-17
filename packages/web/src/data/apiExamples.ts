/**
 * Real response bodies, captured from a running nikcli server.
 *
 * The point is that the reference shows a concrete answer without the reader
 * having to start anything. Where there is no capture, the operation card falls
 * back to a shape generated from the response schema and says so — a generated
 * shape is honest about being one, and a captured body is worth more than any
 * number of invented field values.
 *
 * Captured 2026-09-17 against a server started with `NIKCLI_TEST_HOME` pointed
 * at a throwaway directory, in a two-file git project. The only edit is
 * cosmetic: the temporary paths were rewritten to `/Users/me/demo`.
 *
 * Keys are `METHOD /path` exactly as the OpenAPI document spells them,
 * placeholders included.
 */
export const apiExamples: Record<string, unknown> = {
  "GET /global/health": { healthy: true, version: "local", revision: "local" },

  "GET /path": {
    home: "/Users/me/demo/.nikcli-home",
    state: "/Users/me/demo/.nikcli-home/state",
    config: "/Users/me/demo/.nikcli-home/config",
    worktree: "/Users/me/demo",
    directory: "/Users/me/demo",
  },

  "GET /project/current": {
    id: "c6d9c4f98cc34c8bfb0a40b3a60eca6f624750e6",
    worktree: "/Users/me/demo",
    canonical: "/Users/me/demo",
    vcs: "git",
    time: { created: 1789656731762, updated: 1789656731762 },
    sandboxes: [],
  },

  "GET /vcs": { branch: "main" },

  "GET /session": [],

  "POST /session": {
    id: "ses_f50250f8fffexTvasNDaQeiLXP",
    slug: "swift-eagle",
    projectID: "c6d9c4f98cc34c8bfb0a40b3a60eca6f624750e6",
    directory: "/Users/me/demo",
    title: "api tour",
    version: "local",
    time: { created: 1789656756337, updated: 1789656756337 },
    skills: [],
  },

  "GET /session/{sessionID}": {
    id: "ses_f50250f8fffexTvasNDaQeiLXP",
    slug: "swift-eagle",
    projectID: "c6d9c4f98cc34c8bfb0a40b3a60eca6f624750e6",
    directory: "/Users/me/demo",
    title: "api tour",
    version: "local",
    time: { created: 1789656756337, updated: 1789656756337 },
    skills: [],
  },

  "GET /session/{sessionID}/message": [],
  "GET /session/{sessionID}/todo": [],
  "GET /session/{sessionID}/diff": [],

  "GET /file": [
    { name: "greet.ts", path: "greet.ts", absolute: "/Users/me/demo/greet.ts", type: "file", ignored: false },
    { name: "README.md", path: "README.md", absolute: "/Users/me/demo/README.md", type: "file", ignored: false },
  ],

  "GET /file/content": {
    type: "text",
    content: "export function greet(name: string) {\n  // TODO: localise this\n  return `Hello, ${name}!`\n}",
  },

  "GET /file/status": [],

  "GET /find": [
    {
      path: { text: "greet.ts" },
      lines: { text: "  // TODO: localise this" },
      line_number: 2,
      absolute_offset: 38,
      submatches: [{ match: { text: "TODO" }, start: 5, end: 9 }],
    },
  ],

  "GET /find/file": ["greet.ts", "README.md"],

  "GET /experimental/tool/ids": [
    "invalid",
    "question",
    "bash",
    "monitor",
    "read",
    "tree",
    "glob",
    "grep",
    "edit",
    "write",
    "multiedit",
    "task",
    "delegation",
    "context_collect",
    "context_related",
    "context_diagnostics",
    "memory_search",
    "generate_image",
    "artifact",
    "webfetch",
    "todowrite",
    "todoread",
    "create_goal",
    "get_goal",
    "update_goal",
    "websearch",
    "codesearch",
    "repo_clone",
    "repo_overview",
    "skill",
    "apply_patch",
    "lsp",
    "plan_exit",
    "plan_enter",
    "speak",
    "voice",
    "opentui",
    "advisor",
    "delegator",
    "search_tools",
    "code_mode",
    "browser_control",
    "computer",
    "herdr",
  ],

  "GET /lsp": [],
  "GET /permission": [],
  "GET /question": [],
  "GET /pty": [],
  "GET /experimental/workspace": [],

  "GET /loop": { loops: [], runtimes: [] },
  "GET /mission": { missions: [], runtimes: [] },
}

/** Operations whose captured body was shortened to keep the card readable. */
export const apiExampleTrimmed = new Set<string>([])
