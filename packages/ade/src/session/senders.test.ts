import { expect, test } from "bun:test"
import { verifySender } from "./mailbox"
import { registerSender, senderToken, unregisterSender } from "./senders"

test("a registered background sender is recognised by its token, and forgotten after", () => {
  registerSender("voce-1", "segreto")
  const message = { kind: "send" as const, from: "voce-1", token: "segreto", to: "1", text: "ciao" }
  expect(verifySender(message, senderToken).from).toBe("voce-1")
  expect(verifySender({ ...message, token: "altro" }, senderToken).from).toBe("")
  unregisterSender("voce-1", "segreto")
  expect(verifySender(message, senderToken).from).toBe("")
})

test("an id ade-msg could not carry is refused", () => {
  expect(() => registerSender("voce 1", "x")).toThrow()
})

test("an old turn that ends does not take the new turn's identity away", () => {
  registerSender("voce-2", "vecchio")
  registerSender("voce-2", "nuovo")
  unregisterSender("voce-2", "vecchio")
  expect(senderToken("voce-2")).toBe("nuovo")
  unregisterSender("voce-2", "nuovo")
  expect(senderToken("voce-2")).toBeUndefined()
})
