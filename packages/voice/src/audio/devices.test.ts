import { describe, expect, test } from "bun:test"
import { describeChoice, listAudioDevices, shapeDevices, SYSTEM_DEFAULT } from "./devices"

const device = (over: Partial<MediaDeviceInfo>): MediaDeviceInfo =>
  ({
    deviceId: "id",
    kind: "audioinput",
    label: "",
    groupId: "g",
    toJSON: () => ({}),
    ...over,
  }) as MediaDeviceInfo

describe("shapeDevices", () => {
  test("always offers the system default, first, in both lists", () => {
    const shaped = shapeDevices([])
    expect(shaped.inputs[0]).toEqual(SYSTEM_DEFAULT)
    expect(shaped.outputs[0]).toEqual(SYSTEM_DEFAULT)
  })

  test("splits inputs from outputs", () => {
    const shaped = shapeDevices([
      device({ deviceId: "a", kind: "audioinput", label: "Yeti" }),
      device({ deviceId: "b", kind: "audiooutput", label: "Casse" }),
    ])
    expect(shaped.inputs.map((d) => d.label)).toEqual([SYSTEM_DEFAULT.label, "Yeti"])
    expect(shaped.outputs.map((d) => d.label)).toEqual([SYSTEM_DEFAULT.label, "Casse"])
  })

  /*
   * Chromium reports two synthetic entries that are aliases for the OS
   * selection rather than hardware. Kept, the list shows the same microphone
   * three times and picking the alias pins an id that follows the system
   * anyway — which is what the default row already says, honestly.
   */
  test("drops Chromium's synthetic default and communications entries", () => {
    const shaped = shapeDevices([
      device({ deviceId: "default", label: "Default - Yeti" }),
      device({ deviceId: "communications", label: "Communications - Yeti" }),
      device({ deviceId: "real", label: "Yeti" }),
    ])
    expect(shaped.inputs.map((d) => d.id)).toEqual(["", "real"])
  })

  /*
   * Before microphone permission has ever been granted the browser returns the
   * devices with every label blank. The list is real and unreadable, and the
   * panel has to be able to tell that from "no devices".
   */
  test("reports that nothing is named when the browser withholds labels", () => {
    const shaped = shapeDevices([device({ deviceId: "a", label: "" }), device({ deviceId: "b", label: "" })])
    expect(shaped.labelled).toBe(false)
    expect(shaped.inputs.map((d) => d.label)).toEqual([SYSTEM_DEFAULT.label, "Microfono 1", "Microfono 2"])
    expect(shaped.inputs.slice(1).every((d) => d.named)).toBe(false)
  })

  test("one real label is enough to call the list named", () => {
    const shaped = shapeDevices([device({ deviceId: "a", label: "" }), device({ deviceId: "b", label: "Yeti" })])
    expect(shaped.labelled).toBe(true)
  })
})

describe("describeChoice", () => {
  test("no choice is the system default", () => {
    expect(describeChoice(undefined, [])).toBe(SYSTEM_DEFAULT.label)
    expect(describeChoice("", [])).toBe(SYSTEM_DEFAULT.label)
  })

  /*
   * The stored choice outlives the cable. Showing the default here would read
   * as ADE having forgotten it, when in fact it is still stored and will apply
   * again the moment the device is plugged back in.
   */
  test("a chosen device that is not plugged in says so", () => {
    expect(describeChoice("gone", [SYSTEM_DEFAULT])).toBe("Dispositivo non collegato")
  })
})

describe("listAudioDevices", () => {
  test("a browser that refuses to enumerate still yields a usable list", async () => {
    const listed = await listAudioDevices({
      enumerate: () => Promise.reject(new Error("no")),
    })
    expect(listed.inputs).toEqual([SYSTEM_DEFAULT])
    expect(listed.labelled).toBe(false)
  })
})

describe("device names follow the language", () => {
  test("the system device and unnamed devices are named in English under English", async () => {
    const { resetLocaleForTests } = await import("@nikcli-ai/ade/i18n")
    resetLocaleForTests("en")
    try {
      expect(SYSTEM_DEFAULT.label).toBe("System device")
      const shaped = shapeDevices([device({ deviceId: "a" }), device({ deviceId: "b", kind: "audiooutput" })])
      expect(shaped.inputs[1]?.label).toBe("Microphone 1")
      expect(shaped.outputs[1]?.label).toBe("Audio output 1")
    } finally {
      resetLocaleForTests("it")
    }
  })
})
