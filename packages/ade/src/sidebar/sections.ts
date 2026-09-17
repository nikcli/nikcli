/**
 * Which sidebar sections are open, and which one gives way when they do not fit.
 *
 * The second question is the whole point of this file. The sidebar used to
 * give "Progetti" a height in pixels, stored and dragged: with one project in
 * the list that produced roughly four hundred pixels of nothing between the
 * project list and the file tree, and no amount of styling fixes a box that
 * has been told to be that tall. Sections are sized to their content.
 *
 * What is left over stays at the foot of the column, under the last section.
 * Handing it to a section instead was the same bug wearing different clothes:
 * with the file tree shut, the leftover went to "Agenti attivi", which then
 * stretched and pushed the shut "File" header all the way to the bottom with
 * a field of nothing above it. Nothing stretches; the one section named below
 * is simply the one allowed to shrink and scroll when the content is taller
 * than the column.
 *
 * Pure, and separate from the component, because a `.tsx` has no automatic JSX
 * runtime under `bun test` in this repo — the rules below would otherwise be
 * untestable by construction.
 */

import type { Workspace } from "./workspace-tree"

/** The sections the sidebar owns. Plugins and the shot tray own their own. */
export type SectionId = "progetti" | "agenti" | "file"

export const SECTION_IDS: readonly SectionId[] = ["progetti", "agenti", "file"]

/**
 * The section that absorbs the squeeze: the one that shrinks and scrolls
 * inside itself when the sections together are taller than the column.
 *
 * `file` wins when it is open: a file tree is unbounded and is the thing
 * people scroll, while a project list is a handful of rows that knows its own
 * size. When `file` is shut the active agents or projects take the squeeze
 * instead, and when all are shut nothing does — there is nothing to scroll.
 *
 * It does not make that section taller. Below its content it stops, and the
 * unused height stays where it belongs, at the foot of the column.
 */
export function scrollingSection(open: ReadonlySet<SectionId>): SectionId | undefined {
  if (open.has("file")) return "file"
  if (open.has("agenti")) return "agenti"
  if (open.has("progetti")) return "progetti"
  return undefined
}

/** Open by default: all sections start open. */
export function defaultOpenSections(): Set<SectionId> {
  return new Set<SectionId>(SECTION_IDS)
}

export function toggleSection(open: ReadonlySet<SectionId>, id: SectionId): Set<SectionId> {
  const next = new Set(open)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function serializeSections(open: ReadonlySet<SectionId>): string {
  return SECTION_IDS.filter((id) => open.has(id)).join(",")
}

/**
 * Reads the stored set, tolerating anything.
 *
 * A missing value means a first run and opens both. An empty *string*, though,
 * is a real answer — the user closed both — and must not be mistaken for
 * "nothing stored", or the sidebar reopens itself on every reload.
 */
export function deserializeSections(raw: string | null | undefined): Set<SectionId> {
  if (raw === null || raw === undefined) return defaultOpenSections()
  const parts = raw.split(",").map((part) => part.trim())
  const wanted = parts.map((p) => (p === "spaces" ? "progetti" : p))
  return new Set(SECTION_IDS.filter((id) => wanted.includes(id)))
}

// ---------------------------------------------------------------------------
// What the header says
// ---------------------------------------------------------------------------

export interface SessionCounts {
  working: number
  waiting: number
  error: number
}

export function countSessions(workspaces: readonly Workspace[]): SessionCounts {
  const counts: SessionCounts = { working: 0, waiting: 0, error: 0 }
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      if (session.status === "working" || session.status === "provisioning") counts.working++
      else if (session.status === "waiting") counts.waiting++
      else if (session.status === "error") counts.error++
    }
  }
  return counts
}

export interface StatPill {
  tone: "working" | "waiting" | "error"
  count: number
  label: string
}

/**
 * The counts worth showing, which is never the zeroes.
 *
 * The old header spent a full row on "Lavorando: 0 · Attesa: 0 · Errori: 0",
 * permanently, in the one state where it has nothing to report. A count of
 * zero is the absence of news; printing it costs a line of a 260px column and
 * trains the eye to skip the place where the news would appear.
 */
export function statPills(counts: SessionCounts): StatPill[] {
  const pills: StatPill[] = []
  if (counts.working > 0) pills.push({ tone: "working", count: counts.working, label: "lavora" })
  if (counts.waiting > 0) pills.push({ tone: "waiting", count: counts.waiting, label: "attende" })
  if (counts.error > 0) pills.push({ tone: "error", count: counts.error, label: "in errore" })
  return pills
}
