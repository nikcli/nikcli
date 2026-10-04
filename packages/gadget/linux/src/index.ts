/**
 * `@nikcli-ai/gadget` — build a device that works for a nikcli agent.
 *
 * ```ts
 * import { Gadget, display, button } from "@nikcli-ai/gadget"
 *
 * export default new Gadget({
 *   name: "pi-office",
 *   commands: {
 *     "ha.toggle": {
 *       description: "Toggle a Home Assistant entity",
 *       args: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
 *       async run({ entity }, ctx) { … },
 *     },
 *   },
 *   display: display.terminal(),
 *   buttons: button.keyboard({ keys: { ok: "enter" } }),
 * })
 * ```
 *
 * `nikcli-gadget pair --server http://host:4097 --code 123456` once, then
 * `nikcli-gadget run gadget.ts` for as long as the device should serve.
 */
export {
  Gadget,
  type CommandContext,
  type CommandDefinition,
  type CommandHandler,
  type CommandResult,
  type GadgetOptions,
} from "./gadget.ts"
export * as display from "./display/index.ts"
export * as button from "./button/index.ts"
export { collect as health } from "./commands/health.ts"
export { readPairing, writePairing, clearPairing, stateDirectory, fingerprint, type PairingState } from "./state.ts"
export { Transport, readFrames, backoff, trimTrailingSlashes } from "./transport.ts"
export * from "./protocol.ts"
