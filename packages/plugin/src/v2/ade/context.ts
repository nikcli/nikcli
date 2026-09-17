/**
 * What a v2 plugin is handed when it runs inside ADE.
 *
 * Why this is a second context and not `v2/tui/context.ts`
 * -------------------------------------------------------
 * The two halves of the v2 contract that are genuinely portable — `define`,
 * the `Cleanup` protocol, the shape of `Storage` — are mirrored here on
 * purpose. Everything else in the TUI context is terminal-shaped in ways that
 * do not survive the move:
 *
 *  - Its `JSX` comes from `@opentui/solid`. That is the *terminal* renderer's
 *    element type: a `<box>` is not a `<div>`, and the two namespaces are not
 *    assignable. A plugin written against the TUI context and mounted in ADE
 *    would typecheck and then render nothing. Getting this wrong is silent, so
 *    the type has to say which surface it is for.
 *  - Its `Data` is the nikcli HTTP client's world — messages, parts, permission
 *    requests, MCP servers, providers. ADE has no SDK client wired up at all;
 *    it drives agent CLIs through a pty and knows about a project and a list of
 *    panes. Handing a plugin a `Data` whose every method returns `undefined`
 *    here would be worse than not offering it.
 *  - Its `UI` is a router plus named string slots. ADE has no router: a pane is
 *    a tile in a grid, several of the same kind can be open at once, and each
 *    one is closed individually. `navigate` has no meaning when the answer to
 *    "where am I" is "in six places".
 *
 * The mapping the ADE adapter implements, stated once so nobody has to infer
 * it from the code: a TUI **page** is an ADE **pane**, a TUI **slot** is an ADE
 * **sidebar section**. Commands are new — the TUI reserves them for v1
 * plugins, but the palette is how ADE is driven, so a v2 plugin that cannot put
 * anything in it is a plugin nobody can reach.
 */
import type { JSX } from "solid-js"
import type { Store } from "solid-js/store"

export type SessionStatus = "idle" | "provisioning" | "working" | "waiting" | "done" | "error"

export interface ProjectInfo {
  readonly name: string
  readonly root: string
  readonly branch?: string
}

export interface SessionInfo {
  readonly id: string
  readonly title: string
  readonly status: SessionStatus
  /** The agent CLI behind this session, when it was started from the catalogue. */
  readonly agent?: string
  readonly model: string
  readonly cwd?: string
  /** The project this session is filed under, by name. */
  readonly projectName: string
}

/**
 * ADE's live state, read-only.
 *
 * Every accessor is a function rather than a value because these are read from
 * Solid signals: called inside a reactive scope they subscribe, called outside
 * they are a snapshot. Returning the value would freeze a plugin's view of the
 * workbench at setup time.
 */
export interface Data {
  /** The project currently open, or `undefined` in the browser harness. */
  project(): ProjectInfo | undefined
  readonly session: {
    /** Every session ADE knows about, across projects. */
    list(): SessionInfo[]
    get(id: string): SessionInfo | undefined
    /** The pane the user is in, when it holds a session. */
    focused(): SessionInfo | undefined
  }
}

export interface CommandDefinition {
  /**
   * Unique within the plugin. The host namespaces it before it reaches the
   * palette, so a plugin cannot claim `pane.close` — see the adapter.
   */
  readonly id: string
  /** Shown in the palette. Italian, like the rest of ADE's chrome. */
  readonly title: string
  /** The palette section to file it under. Defaults to the plugin's own id. */
  readonly group?: string
  /** Searchable synonyms that are not in the title. */
  readonly keywords?: readonly string[]
  readonly run: () => Promise<void> | void
}

/** A pane a plugin can open in the grid. The ADE analogue of a TUI page. */
export interface PaneDefinition {
  /** Unique within the plugin; identifies the kind, not one open instance. */
  readonly name: string
  /** The pane's header. Defaults to `name`. */
  readonly title?: string
  readonly render: (input: { readonly data?: Record<string, unknown> }) => JSX.Element
}

/** A sidebar section. The ADE analogue of a TUI slot. */
export type SectionRender = (props: Record<string, unknown>) => JSX.Element

export interface SectionDefinition {
  /** Unique within the plugin. Reaches the DOM, so the host validates it. */
  readonly name: string
  /** The section header. Defaults to `name`. */
  readonly title?: string
  readonly render: SectionRender
}

/** An open instance of a plugin pane, as the plugin sees it. */
export interface OpenPane {
  /** The workbench pane id. What `close` takes. */
  readonly id: string
  readonly name: string
  readonly data?: Record<string, unknown>
}

export interface UI {
  readonly command: {
    register(command: CommandDefinition): () => void
    /** Runs one of this plugin's own commands by its unqualified id. */
    run(id: string): void
    /** Opens the palette, as Ctrl+Shift+P does. */
    palette(): void
  }
  readonly pane: {
    register(pane: PaneDefinition): () => void
    /**
     * Opens a tile for a registered pane and returns its workbench id.
     *
     * Returns `undefined` when the name is not registered, rather than
     * throwing: opening is usually a reaction to a click, and a plugin
     * mid-teardown should not take the surface down with it.
     */
    open(input: { readonly name: string; readonly data?: Record<string, unknown> }): string | undefined
    close(paneId: string): void
    /** This plugin's open tiles. Reactive, like everything on `data`. */
    list(): OpenPane[]
  }
  readonly section: {
    register(section: SectionDefinition): () => void
  }
}

/**
 * Durable and ephemeral plugin state.
 *
 * Structurally the same as the TUI's `Storage` and deliberately so — a plugin
 * that only keeps state should port between the two surfaces unchanged. It is
 * restated rather than imported because importing the TUI context would drag
 * `@opentui/*` into a webview build that has no terminal in it.
 *
 * The backing differs: ADE persists to `localStorage`, which is per-window and
 * per-origin. So "survives a restart" holds, "stays in sync across running
 * instances" does not — there is one ADE window.
 */
export interface Storage {
  store<Value extends object>(
    key: string,
    options: {
      readonly initial: Value
    },
  ): readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]
  /** In-memory only. Survives a plugin reload, gone when the window closes. */
  memory<Value extends object>(
    key: string,
    options: {
      readonly initial: Value
    },
  ): readonly [Store<Value>, (mutation: (draft: Value) => void) => void]
}

export interface Context {
  readonly options: Readonly<Record<string, unknown>>
  readonly data: Data
  readonly storage: Storage
  readonly ui: UI
}
