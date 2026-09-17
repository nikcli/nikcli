/**
 * Which agent a `spawn` actually starts: the hook for routing by quota (S9).
 *
 * `ade-msg spawn claude …` names an agent, but when that provider's quota is
 * spent the work is better done by another one than not at all. The mailbox
 * asks a picker before starting the session; the quota module registers the
 * real one with `setProviderPicker`, so it never has to touch the mailbox.
 * Until it does, the picker returns the agent asked for.
 *
 * Not asked for a `--fork` (the conversation belongs to that CLI) or when the
 * caller named a `--model` (a model is a choice of provider already). A picker
 * that throws, or answers an agent ADE cannot start, changes nothing.
 */

export interface PickInput {
  /** The agent id the caller asked for, as `resolveAgent` found it (`claude-code`, `codex`…). */
  readonly agent: string
  /** The session asking; empty when anonymous. */
  readonly from: string
}

export interface PickResult {
  readonly agent: string
  /** Why another agent was chosen, told to the caller in the receipt. */
  readonly reason?: string
}

export type ProviderPicker = (input: PickInput) => PickResult | Promise<PickResult>

const asked: ProviderPicker = ({ agent }) => ({ agent })
let picker: ProviderPicker = asked

/** Registers the picker; nothing, or `undefined`, puts back the one that changes nothing. */
export function setProviderPicker(next?: ProviderPicker): void {
  picker = next ?? asked
}

export async function pickProvider(input: PickInput): Promise<PickResult> {
  try {
    const result = await picker(input)
    return result && typeof result.agent === "string" && result.agent ? result : { agent: input.agent }
  } catch {
    return { agent: input.agent }
  }
}

/**
 * Whether a spawn may be routed by quota at all.
 *
 * Not when the caller chose something that belongs to one agent: a `--model`
 * is a choice of provider already, a `--fork` is that CLI's conversation, and
 * a `--profile` or `--effort` is checked against the agent it names — rerouted
 * first, a valid `ade-msg spawn claude --effort max` was refused as an effort
 * Codex does not take, with nothing in the error saying the agent had changed.
 */
export function mayReroute(options: { fork?: boolean; model?: string; profile?: string; effort?: string }): boolean {
  return !options.fork && !options.model && !options.profile && !options.effort
}
