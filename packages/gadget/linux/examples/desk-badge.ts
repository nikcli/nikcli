/**
 * Desk badge — a small e-paper or framebuffer panel that shows what the
 * agent is working on, so the people around you know before they interrupt.
 *
 * The agent calls the `gadget` tool's `show` action with a tree; this gadget
 * only draws. With a Waveshare e-paper, replace `display.framebuffer` with
 * `display.bitmap({ width, height, push })`: the bridge lays the tree out and
 * sends finished 1-bit pixels, and `push` hands them to the vendor's library.
 */
import { Gadget, display, button } from "@nikcli-ai/gadget"

export default new Gadget({
  name: "desk-badge",
  builtins: false,
  display: display.framebuffer({ device: "/dev/fb0", width: 480, height: 320, bytesPerPixel: 2, scale: 3 }),
  buttons: button.gpio({ pins: { next: 5, ok: 6 } }),
  onMessage(text) {
    console.error(`[badge] ${text}`)
  },
})
