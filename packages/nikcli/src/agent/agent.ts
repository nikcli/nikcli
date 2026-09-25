import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@nikcli-ai/util/global"
import path from "path"
import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_DELEGATION from "./prompt/delegation.txt"
import PROMPT_DELEGATOR from "./prompt/delegator.txt"
import PROMPT_ULTRAREVIEW_REVIEWER from "./prompt/ultrareview-reviewer.txt"
import PROMPT_AUTO_MODE from "./prompt/auto-mode.txt"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState, locallyInstance, runPromiseWithLayer, type InstanceContext } from "@/effect"
import { type DeepMutable, zodObject } from "@nikcli-ai/util/effect-zod"
import { Flag } from "@nikcli-ai/util/flag"

function runAuth<A, E>(effect: Effect.Effect<A, E, Auth.Service>) {
  return runPromiseWithLayer(Auth.defaultLayer, effect)
}

function runProvider<A, E>(effect: Effect.Effect<A, E, Provider.Service>, ctx: InstanceContext) {
  return runPromiseWithLayer(Provider.defaultLayer, locallyInstance(ctx, effect))
}

const PRIMARY_AGENT_DELEGATION_AWARENESS = `

${PROMPT_DELEGATION}
`

const MONITOR_TOOL_AWARENESS = `

For typecheck, builds, test suites, dev servers, and any long-running or potentially long-running command, use the monitor tool instead of bash. The bash tool blocks the turn and will hang on commands that take a while or never exit; the monitor tool runs the command in the background, persists its output, and wakes the session when it finishes so you can keep working. Reserve bash for short, fast, clearly-bounded commands (a few seconds at most).

The monitor tool only streams a short preview of the output. The full results are written to a log file on disk (the "Log file:" path returned when the job starts). To read the complete output of a background job — for example to inspect typecheck or build errors — read that log file from the filesystem with the read tool once the job has produced output or finished, rather than relying on the streamed preview alone.
`

const PRIMARY_AGENT_RESEARCH_AWARENESS = `

When you identify a knowledge gap, outdated external dependency question, missing docs context, or a decision that needs evidence, proactively launch a background research run with the task tool using subagent_type: "researcher".

- Launch research only when it materially improves the result; skip it for purely local or mechanical tasks.
- Keep only one active research run per parent session unless the existing one is clearly irrelevant.
- While research runs, continue any independent work instead of blocking.
- When the research becomes relevant, use delegator or delegation to read and incorporate the result.
`

export namespace Agent {
  /**
   * Thrown by helpers like `agentRequired` when the named agent does not exist
   * in the resolved agent list. Tagged so the call site can use
   * `Effect.catchTag("AgentNotFound", ...)` and the existing `instanceof
   * Agent.NotFoundError` continues to work.
   */
  export class NotFoundError extends Schema.TaggedError<NotFoundError>()("AgentNotFound", {
    name: Schema.String,
  }) {}

  const ModelRefSchema = Schema.Struct({
    modelID: Schema.String,
    providerID: Schema.String,
  })

  const InfoSchema = Schema.Struct({
    // Opencode #24691: optional `order` field for deterministic agent cycling.
    // Lower numbers sort first; unset → Infinity (sort after ordered ones).
    order: Schema.optional(Schema.Number),
    name: Schema.String,
    description: Schema.optional(Schema.String),
    mode: Schema.Literals(["subagent", "primary", "all"]),
    native: Schema.optional(Schema.Boolean),
    hidden: Schema.optional(Schema.Boolean),
    topP: Schema.optional(Schema.Number),
    temperature: Schema.optional(Schema.Number),
    color: Schema.optional(Schema.String),
    permission: Schema.mutable(Schema.Array(PermissionNext.RuleSchema)),
    // `auto` hands `ask` decisions to the auto mode classifier; absent means `default`.
    permissionMode: Schema.optional(Schema.Literals(["default", "auto"])),
    model: Schema.optional(ModelRefSchema),
    advisor: Schema.optional(
      Schema.Struct({
        model: ModelRefSchema,
        maxUses: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
      }),
    ),
    variant: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    options: Schema.Record(Schema.String, Schema.Unknown),
    steps: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  }).annotate({ identifier: "Agent" })
  export const Info = zodObject(InfoSchema)
  export type Info = DeepMutable<Schema.Schema.Type<typeof InfoSchema>>

  export const SUBAGENT_TOOLSETS: Record<string, string[]> = {
    "fast-explore": ["read", "grep", "glob", "list", "tree"],
    planner: ["read", "grep", "glob", "list", "tree", "websearch", "codesearch", "webfetch"],
    scout: [
      "read",
      "grep",
      "glob",
      "list",
      "tree",
      "websearch",
      "codesearch",
      "webfetch",
      "repo_clone",
      "repo_overview",
    ],
    general: [],
    explore: ["read", "grep", "glob", "list", "bash", "webfetch", "websearch", "codesearch"],
    researcher: [
      "read",
      "grep",
      "glob",
      "list",
      "tree",
      "websearch",
      "webfetch",
      "memory_search",
      "context_collect",
      "context_related",
      "task",
      "delegation",
      "delegator",
    ],
    "code-reviewer": ["read", "grep", "glob", "list", "bash"],
    debugger: ["read", "grep", "glob", "list", "bash", "edit"],
    "test-runner": ["read", "grep", "list", "bash", "edit", "write"],
    refactor: ["read", "grep", "glob", "list", "bash", "edit", "write", "apply_patch"],
  }

  export interface Interface {
    get(agent: string): Effect.Effect<Info | undefined>
    list(): Effect.Effect<Info[], never>
    defaultAgent(): Effect.Effect<string, NotFoundError>
    generate(input: { description: string; model?: { providerID: string; modelID: string } }): Effect.Effect<
      {
        identifier: string
        whenToUse: string
        systemPrompt: string
      },
      unknown
    >
  }

  export class Service extends Context.Service<Service, Interface>()("Agent.Service") {}

  async function buildState(worktree: string, cfg: Config.Info) {
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      browser_control: "ask",
      computer: "ask",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        [Truncate.DIR]: "allow",
        [Truncate.GLOB]: "allow",
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      ralph: {
        name: "ralph",
        description:
          "Autonomous loop agent that iterates on a task until complete. Best for large refactors, migrations, and multi-step tasks with clear done criteria.",
        prompt: `You are an autonomous agent that iterates on a task until complete.

You are aware of the project context (directory, worktree) and can use all available tools.
You have access to subagents that can be launched as background tasks.${PRIMARY_AGENT_DELEGATION_AWARENESS}${PRIMARY_AGENT_RESEARCH_AWARENESS}`,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      build: {
        name: "build",
        prompt: `You are a build agent focused on creating and implementing features.

You are aware of the project context (directory, worktree) and can use all available tools.
You have access to subagents that can be launched as background tasks.${MONITOR_TOOL_AWARENESS}${PRIMARY_AGENT_DELEGATION_AWARENESS}${PRIMARY_AGENT_RESEARCH_AWARENESS}`,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        prompt: `You are a planning agent for multi-step implementation strategies.

You are aware of the project context (directory, worktree) and can use all available tools.
You have access to subagents that can be launched as background tasks.${PRIMARY_AGENT_DELEGATION_AWARENESS}${PRIMARY_AGENT_RESEARCH_AWARENESS}`,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".nikcli", "plans", "*.md")]: "allow",
              [path.relative(worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "all",
        native: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "all",
        native: true,
      },
      "fast-explore": {
        name: "fast-explore",
        description: "Fast read-only explorer for quick codebase inspection.",
        prompt: `You are a fast exploration agent.

Use tools: read, grep, glob, list, tree.
Do not modify files.
Report findings with exact file paths and concise notes.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            tree: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "all",
        native: true,
      },
      planner: {
        name: "planner",
        description: "Planning agent for multi-step implementation strategies.",
        prompt: `You are a planning agent.

Use tools: read, grep, glob, list, tree, websearch, codesearch, webfetch.
Do not modify files.
Produce a clear, step-by-step plan with file paths.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            tree: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "all",
        native: true,
      },
      ...(Flag.NIKCLI_EXPERIMENTAL_SCOUT
        ? {
            scout: {
              name: "scout",
              description:
                "Read-only research agent for external libraries, dependency source, documentation, and public repositories.",
              prompt: PROMPT_SCOUT,
              permission: PermissionNext.merge(
                defaults,
                PermissionNext.fromConfig({
                  "*": "deny",
                  read: "allow",
                  grep: "allow",
                  glob: "allow",
                  list: "allow",
                  tree: "allow",
                  webfetch: "allow",
                  websearch: "allow",
                  codesearch: "allow",
                  repo_clone: "allow",
                  repo_overview: "allow",
                  external_directory: {
                    [path.join(Global.Path.repos, "*")]: "allow",
                    [Truncate.DIR]: "allow",
                    [Truncate.GLOB]: "allow",
                  },
                }),
                user,
              ),
              options: {},
              mode: "subagent" as const,
              native: true,
            },
          }
        : undefined),
      researcher: {
        name: "researcher",
        description:
          "Read-only research agent for collecting evidence in the background and returning source-backed findings.",
        prompt: `You are a research agent.

Your job is to investigate a question, collect evidence, and return a concise, source-backed report.

Rules:
- Stay read-only. Do not modify files, run shell commands, or mutate external systems.
- Prefer local context first: loaded docs, project context, memory, and repository files before generic web search.
- Use web search and web fetch when freshness or external evidence is required.
- Deduplicate claims and URLs.
- If evidence conflicts, say so explicitly.
- If confidence is low, say so explicitly.
- If helpful, delegate parallel read-only subtasks only to @fast-explore or @planner. Never delegate to @researcher.
- Stop when you have enough evidence; do not loop forever.

Return a final report in this structure:

Question: <one line>
Confidence: <high|medium|low>

Findings:
- <finding with source>
- <finding with source>

Open Questions:
- <question or "None">

Sources:
- <url or file path>
- <url or file path>`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            tree: "allow",
            websearch: "allow",
            webfetch: "allow",
            memory_search: "allow",
            context_collect: "allow",
            context_related: "allow",
            delegation: "allow",
            delegator: "allow",
            task: {
              "fast-explore": "allow",
              planner: "allow",
              researcher: "deny",
              "*": "deny",
            },
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
        hidden: true,
      },
      "code-reviewer": {
        name: "code-reviewer",
        description: "Code review agent focused on quality and safety.",
        prompt: `You are a code reviewer.

Use tools: read, grep, glob, list, bash.
Review changes and report issues with file paths and fixes.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "all",
        native: true,
      },
      "ultrareview-reviewer": {
        name: "ultrareview-reviewer",
        description: "Specialized reviewer agent for a single domain within an ultrareview parallel fleet.",
        prompt: PROMPT_ULTRAREVIEW_REVIEWER,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            // Only the truncation directory and glob are allowed; the
            // previous `*: allow` wildcard over-permitted writes to
            // any host path matching the external_directory permission.
            // Keep the explicit allow-list so the policy is auditable.
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
        hidden: true,
      },
      debugger: {
        name: "debugger",
        description: "Debugging agent for failures and runtime issues.",
        prompt: `You are a debugging agent.

Use tools: read, grep, glob, list, bash, edit.
Identify root cause and apply minimal fixes.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            edit: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "all",
        native: true,
      },
      "test-runner": {
        name: "test-runner",
        description: "Test runner for executing and analyzing tests.",
        prompt: `You are a test runner agent.

Use tools: read, grep, list, bash, edit.
Run tests, analyze failures, and propose fixes.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            list: "allow",
            bash: "allow",
            edit: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "all",
        native: true,
      },
      refactor: {
        name: "refactor",
        description: "Refactor agent for cleanups without behavior changes.",
        prompt: `You are a refactor agent.

Use tools: read, grep, glob, list, bash, edit.
Apply small, safe refactors and verify results.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            edit: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
        mode: "all",
        native: true,
      },
      delegator: {
        name: "delegator",
        description: "Coordination agent that synthesizes background subagent results.",
        mode: "subagent",
        native: true,
        hidden: true,
        prompt: PROMPT_DELEGATOR,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            task: "allow", // required: DelegationTool.execute calls ctx.ask({ permission: "task" })
            read: "allow",
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
        options: {},
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      // The auto mode classifier. It never runs tools: it reads a transcript
      // and a pending action and answers allow or block (`session/auto-mode.ts`).
      "auto-mode": {
        name: "auto-mode",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_AUTO_MODE,
      },
      support: {
        name: "support",
        description:
          "Documentation & how-to assistant for nikcli. Read-only. Use when you need to understand nikcli features, commands, configuration, or troubleshooting.",
        mode: "all",
        native: true,
        // Hidden from the /agents picker: this agent is only invoked from the
        // support dialog (`/support`, `<leader>z`). Exposing it as a primary
        // agent would let users spawn a session that cannot edit files, which
        // would be confusing.
        hidden: true,
        color: "#7C3AED",
        prompt: `You are the nikcli support assistant — a friendly, knowledgeable helper for users learning and using nikcli.

## Your role

Help users understand and use nikcli effectively. Answer questions about:
  - Features, commands, flags, configuration keys
  - Slash commands and keybinds
  - Agents, models, providers, MCP servers, skills, themes
  - Workflows, troubleshooting, error messages
  - SDK endpoints, plugin system, custom agents
  - Installation, updates, doctor diagnostics

## What you can read

- The local nikcli documentation index (provided in a separate section below as \`<docs_index>\`).
- Any markdown file in the working directory (AGENTS.md, README.md, specs/**, docs/**, packages/*/README.md, packages/*/AGENTS.md).
- The web via \`webfetch\` and \`websearch\` (for release notes, latest docs, GitHub issues).
- Diagnostic info: \`nikcli --version\`, \`nikcli doctor\`, \`nikcli agent list\`, \`nikcli models\`, \`cat\`, \`head\`, \`tail\`, \`ls\`, \`find\`.

## What you cannot do

- Do not modify files. You have no edit/write/patch permission.
- Do not run destructive or state-mutating bash commands. The bash allowlist is read-only.
- Do not start long-running commands (no \`bun run dev\`, no \`bun test\`, no watchers).
- Do not delegate to other agents. You answer directly.

## Style

- Match the user's language. If they write in Italian, respond in Italian. Otherwise respond in English.
- Be concise. Aim for 5-15 lines per answer unless the user asks for detail.
- When mentioning a command, flag, keybind, or config key, format it as \`code\`.
- For multi-step answers, use a short bulleted list.
- Always cite the source: either a file path you read, or \`https://nikcli-ai.dev/docs/...\`.
- If you're not sure, say so and suggest where to look. Never invent API endpoints, flags, or config keys.
- If the user asks something outside nikcli's scope, say so politely and offer to help with a related nikcli question.

## Docs index

The system prompt will include a \`<docs_index>\` block listing all available documentation files with their sizes. Use \`read\` to open the ones you need.`,
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            list: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            bash: {
              // Read-only bash allowlist. Anything else is denied.
              "nikcli --version": "allow",
              "nikcli --help": "allow",
              "nikcli doctor": "allow",
              "nikcli doctor *": "allow",
              "nikcli agent list": "allow",
              "nikcli agent list *": "allow",
              "nikcli models": "allow",
              "nikcli models *": "allow",
              "nikcli auth list": "allow",
              "nikcli config *": "allow",
              "cat *": "allow",
              "head *": "allow",
              "tail *": "allow",
              ls: "allow",
              "ls *": "allow",
              "find *": "allow",
              "wc *": "allow",
              "file *": "allow",
              "stat *": "allow",
              "echo *": "allow",
              pwd: "allow",
              "which *": "allow",
              "*": "deny",
            },
            external_directory: {
              [Truncate.DIR]: "allow",
              [Truncate.GLOB]: "allow",
            },
          }),
          user,
        ),
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }

    if (Flag.NIKCLI_EXPERIMENTAL_SCOUT) {
      for (const [name, reference] of Object.entries(cfg.reference ?? {})) {
        const agentName = `reference-${name.replace(/[^A-Za-z0-9_-]+/g, "-")}`
        if (result[agentName]) continue

        const localPath = reference.type === "local" ? path.resolve(worktree, reference.path) : undefined
        const referencePrompt =
          reference.type === "git"
            ? `${PROMPT_SCOUT}

You are focused on the configured reference "${name}".

Reference:
- type: git
- repository: ${reference.repository}
${reference.branch ? `- branch: ${reference.branch}` : ""}
${reference.description ? `- description: ${reference.description}` : ""}

Start by calling repo_clone with this repository${reference.branch ? " and branch" : ""}, then inspect the returned absolute directory.`
            : `${PROMPT_SCOUT}

You are focused on the configured reference "${name}".

Reference:
- type: local
- path: ${localPath}
${reference.description ? `- description: ${reference.description}` : ""}

Inspect this local reference path directly. Stay read-only and cite absolute paths.`

        result[agentName] = {
          name: agentName,
          description:
            reference.description ??
            (reference.type === "git"
              ? `Read-only reference agent for ${reference.repository}.`
              : `Read-only reference agent for ${localPath}.`),
          prompt: referencePrompt,
          permission: PermissionNext.merge(
            defaults,
            PermissionNext.fromConfig({
              "*": "deny",
              read: "allow",
              grep: "allow",
              glob: "allow",
              list: "allow",
              tree: "allow",
              webfetch: "allow",
              websearch: "allow",
              codesearch: "allow",
              repo_clone: reference.type === "git" ? "allow" : "deny",
              repo_overview: "allow",
              external_directory: {
                [path.join(Global.Path.repos, "*")]: "allow",
                ...(localPath
                  ? {
                      [localPath]: "allow",
                      [path.join(localPath, "*")]: "allow",
                    }
                  : undefined),
                [Truncate.DIR]: "allow",
                [Truncate.GLOB]: "allow",
              },
            }),
            user,
          ),
          options: {},
          mode: "subagent",
          native: true,
        }
      }
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      if (value.advisor) {
        item.advisor = {
          model: Provider.parseModel(value.advisor),
          maxUses: value.advisor_max_uses,
        }
      } else {
        item.advisor = undefined
      }
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      // Opencode #24691: forward the `order` field from config to agent Info.
      if (value.order !== undefined) item.order = value.order
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
    }

    // Permission mode: the agent's own setting wins over the top-level one.
    // Assigned only when set, so the agent list never carries a present
    // `undefined` into the HTTP encoder.
    for (const name in result) {
      const mode = cfg.agent?.[name]?.permission_mode ?? cfg.permission_mode
      if (mode) result[name].permissionMode = mode
    }

    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r: PermissionNext.Rule) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.DIR || r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({
          external_directory: {
            [Truncate.DIR]: "allow",
            [Truncate.GLOB]: "allow",
          },
        }),
      )
    }

    return result
  }

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      function configGet(ctx: InstanceContext) {
        return runPromiseWithLayer(
          Config.defaultLayer,
          locallyInstance(
            ctx,
            Effect.gen(function* () {
              const config = yield* Config.Service
              return yield* config.get()
            }),
          ),
        )
      }

      const state = yield* InstanceState.make<Record<string, Info>>(
        (ctx) =>
          Effect.gen(function* () {
            const cfg = yield* Effect.promise(() => configGet(ctx))
            return yield* Effect.tryPromise(() => buildState(ctx.worktree, cfg)).pipe(Effect.orDie)
          }),
        // Pure derivation of config plus the agent files on disk, so it joins
        // instance hot reload: an edited agent has to be visible on the next
        // access instead of after a restart.
        { reloadable: true },
      )
      const getState = () => InstanceState.get(state)

      function list() {
        return Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const cfg = yield* Effect.promise(() => configGet(ctx))
          return pipe(
            yield* getState(),
            values(),
            // Opencode #24691: sort by 1) `order` ascending (Infinity for unset),
            // 2) name alphabetical (existing fallback).
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.order ?? Infinity, "asc"],
              [(x) => x.name, "asc"],
            ),
          )
        })
      }

      return Service.of({
        get: (agent) => getState().pipe(Effect.map((state) => state[agent])),
        list,
        defaultAgent: () =>
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const cfg = yield* Effect.promise(() => configGet(ctx))
            const agents = yield* getState()

            if (cfg.default_agent) {
              const agent = agents[cfg.default_agent]
              if (!agent) return yield* Effect.fail(new NotFoundError({ name: cfg.default_agent }))
              if (agent.mode === "subagent") return yield* Effect.fail(new NotFoundError({ name: cfg.default_agent }))
              if (agent.hidden === true) return yield* Effect.fail(new NotFoundError({ name: cfg.default_agent }))
              return agent.name
            }

            const primaryVisible = (yield* list()).find((a: Info) => a.mode !== "subagent" && a.hidden !== true)
            if (!primaryVisible) return yield* Effect.fail(new NotFoundError({ name: "" }))
            return primaryVisible.name
          }),
        generate: (input) =>
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const cfg = yield* Effect.promise(() => configGet(ctx))
            const { defaultModel, model, language } = yield* Effect.promise(() =>
              runProvider(
                Effect.gen(function* () {
                  const provider = yield* Provider.Service
                  const defaultModel = input.model ?? (yield* provider.defaultModel())
                  const model = yield* provider.getModel(defaultModel.providerID, defaultModel.modelID)
                  const language = yield* provider.getLanguage(model)
                  return { defaultModel, model, language }
                }),
                ctx,
              ),
            )

            const system = SystemPrompt.header(defaultModel.providerID)
            system.push(PROMPT_GENERATE)
            const existing = yield* list()

            const params = {
              experimental_telemetry: {
                isEnabled: cfg.experimental?.openTelemetry ?? true,
                metadata: {
                  userId: cfg.username ?? "unknown",
                },
              },
              temperature: 0.3,
              messages: [
                ...system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                ),
                {
                  role: "user",
                  content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i: Info) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
                },
              ],
              model: language,
              schema: z.object({
                identifier: z.string(),
                whenToUse: z.string(),
                systemPrompt: z.string(),
              }),
            } satisfies Parameters<typeof generateObject>[0]

            const auth = yield* Effect.promise(() =>
              runAuth(
                Effect.gen(function* () {
                  const auth = yield* Auth.Service
                  return yield* auth.get(defaultModel.providerID)
                }),
              ),
            )
            if (defaultModel.providerID === "openai" && auth?.type === "oauth") {
              return yield* Effect.promise(async () => {
                const result = streamObject({
                  ...params,
                  providerOptions: ProviderTransform.providerOptions(model, {
                    instructions: SystemPrompt.instructions(),
                    store: false,
                  }),
                  onError: () => {},
                })
                for await (const part of result.fullStream) {
                  if (part.type === "error") throw part.error
                }
                return result.object
              })
            }

            const result = yield* Effect.promise(() => generateObject(params))
            return result.object
          }),
      })
    }),
  )

  export const defaultLayer = layer
}
