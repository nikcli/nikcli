import { describe, expect, test } from "bun:test"
import { runModelCommand, type ModelController } from "./commands"
import {
  changeStamp,
  decideReload,
  describeModelState,
  frameDistance,
  gltfResources,
  isModel,
  modelFormat,
  mtlTextures,
  objMaterialLibraries,
  parseView,
  resolveResource,
  viewDirection,
  viewFileName,
  type ModelState,
} from "./model"
import { parseRequest } from "../panels/protocol"

describe("modelFormat", () => {
  test("knows the formats the panel opens, in any case", () => {
    expect(modelFormat("C:\\art\\Robot.GLB")).toBe("glb")
    expect(modelFormat("scene.gltf")).toBe("gltf")
    expect(modelFormat("part.stl")).toBe("stl")
    expect(isModel("a.fbx")).toBe(true)
  })

  test("refuses what is not a model", () => {
    expect(isModel("texture.png")).toBe(false)
    expect(isModel("glb")).toBe(false)
    expect(isModel("")).toBe(false)
  })
})

describe("resolveResource", () => {
  test("resolves next to the model with Windows separators", () => {
    expect(resolveResource("C:\\proj\\assets\\ship.gltf", "ship.bin")).toBe("C:\\proj\\assets\\ship.bin")
  })

  test("follows relative segments without leaving the drive", () => {
    expect(resolveResource("C:\\proj\\assets\\ship.gltf", "../textures/hull.png")).toBe("C:\\proj\\textures\\hull.png")
    expect(resolveResource("C:\\ship.gltf", "../../x.png")).toBe("C:\\x.png")
  })

  test("decodes percent-encoded names, which is how glTF writes spaces", () => {
    expect(resolveResource("/home/a/m.gltf", "base%20color.png")).toBe("/home/a/base color.png")
  })

  test("keeps a stray percent sign as written", () => {
    expect(resolveResource("/home/a/m.gltf", "100%.png")).toBe("/home/a/100%.png")
  })

  test("never reads what a model names absolutely or by scheme", () => {
    expect(resolveResource("/a/m.gltf", "data:application/octet-stream;base64,AAAA")).toBeUndefined()
    expect(resolveResource("/a/m.gltf", "https://example.com/t.png")).toBeUndefined()
    expect(resolveResource("/a/m.gltf", "C:\\Users\\x\\t.png")).toBeUndefined()
    expect(resolveResource("/a/m.gltf", "/etc/passwd")).toBeUndefined()
    expect(resolveResource("/a/m.gltf", "  ")).toBeUndefined()
  })
})

describe("resources named by model files", () => {
  test("a glTF's buffers and images, without inline data or repeats", () => {
    const json = JSON.stringify({
      buffers: [{ uri: "scene.bin" }, { uri: "data:application/octet-stream;base64,AA==" }],
      images: [{ uri: "tex/a.png" }, { uri: "tex/a.png" }, { bufferView: 3 }],
    })
    expect(gltfResources(json)).toEqual(["scene.bin", "tex/a.png"])
  })

  test("a glTF that is not JSON names nothing", () => {
    expect(gltfResources("glTF\u0002binary")).toEqual([])
    expect(gltfResources("null")).toEqual([])
  })

  test("an OBJ's material libraries", () => {
    expect(objMaterialLibraries("# x\nmtllib crate.mtl\r\nv 0 0 0\n  mtllib crate.mtl\n")).toEqual(["crate.mtl"])
  })

  test("an MTL's textures, with options before the name", () => {
    const mtl = "newmtl wood\nmap_Kd -s 1 1 1 wood.png\nbump wood_n.png\nmap_Ks spec.png\nKd 1 1 1\n"
    expect(mtlTextures(mtl)).toEqual(["wood.png", "wood_n.png", "spec.png"])
  })
})

describe("watching for changes", () => {
  const entries = [
    { path: "C:\\p\\m.gltf", size: 120, modified_ms: 1000.4 },
    { path: "C:\\p\\m.bin", size: 900, modified_ms: 1000 },
  ]

  test("the stamp follows the watched files, whatever the slashes and case", () => {
    expect(changeStamp(entries, ["c:/p/M.gltf", "C:\\p\\m.bin"])).toBe("120:1000|900:1000")
  })

  test("a missing file has a mark of its own", () => {
    expect(changeStamp(entries, ["C:\\p\\m.gltf", "C:\\p\\gone.png"])).toBe("120:1000|-")
  })

  test("reloads only once a change has held for a whole poll", () => {
    const first = decideReload("a", undefined, "b")
    expect(first).toEqual({ pending: "b", reload: false })
    expect(decideReload("a", first.pending, "b")).toEqual({ pending: undefined, reload: true })
  })

  test("a change still being written restarts the wait", () => {
    expect(decideReload("a", "b", "c")).toEqual({ pending: "c", reload: false })
  })

  test("nothing changed, or the model is missing mid-save: no reload", () => {
    expect(decideReload("a", undefined, "a").reload).toBe(false)
    expect(decideReload("1:1", "-", "-").reload).toBe(false)
  })
})

describe("the camera", () => {
  test("stands further back in a portrait pane than in a landscape one", () => {
    expect(frameDistance(1, 45, 0.5)).toBeGreaterThan(frameDistance(1, 45, 2))
  })

  test("sees a unit sphere whole in a square pane", () => {
    const distance = frameDistance(1, 90, 1, 1)
    expect(distance).toBeCloseTo(Math.SQRT2, 5)
  })

  test("has a sane answer for an empty model", () => {
    expect(frameDistance(0, 45, 1)).toBe(5)
  })

  test("view names in English or Italian", () => {
    expect(parseView("Sopra")).toBe("top")
    expect(parseView("front")).toBe("front")
    expect(parseView("diagonale")).toBeUndefined()
    const [x, y, z] = viewDirection("iso")
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6)
  })
})

describe("wording", () => {
  test("describes a loaded model with its size", () => {
    const state: ModelState = {
      source: "ship.glb",
      loading: false,
      stats: { meshes: 3, triangles: 12500, size: [2, 0.5, 12.25], animations: 1 },
    }
    expect(describeModelState(state)).toBe(
      "ship.glb — 3 mesh, 12.500 triangoli, ingombro 2,00 × 0,500 × 12,3, 1 animazioni",
    )
  })

  test("says when there is nothing, or it is loading, or it failed", () => {
    expect(describeModelState({ loading: false })).toBe("nessun modello aperto")
    expect(describeModelState({ source: "a.stl", loading: true })).toBe("a.stl — in caricamento")
    expect(describeModelState({ source: "a.stl", loading: false, error: "rotto" })).toBe("a.stl — errore: rotto")
  })

  test("capture names are sortable and Windows-safe", () => {
    expect(viewFileName("C:\\p\\my ship:v2.glb", new Date(2026, 8, 15, 9, 5, 7))).toBe("my-ship-v2-20260915-090507.png")
  })
})

describe("runModelCommand", () => {
  function fake(initial: ModelState = { loading: false }) {
    let state = initial
    const calls: string[] = []
    const controller: ModelController = {
      state: () => state,
      async open(path) {
        calls.push(`open ${path}`)
        state = path.includes("broken")
          ? { source: path, loading: false, error: "file non valido" }
          : { source: path, loading: false, stats: { meshes: 1, triangles: 12, size: [1, 1, 1], animations: 0 } }
      },
      async reload() {
        calls.push("reload")
      },
      view(preset) {
        calls.push(`view ${preset}`)
      },
      async capture() {
        return "C:\\p\\.ade\\frames\\x.png"
      },
    }
    return { controller, calls }
  }

  const request = (line: string) => parseRequest(line)!

  test("open answers with what was loaded", async () => {
    const { controller } = fake()
    const outcome = await runModelCommand(controller, request("@ade model open cube.glb"))
    expect(outcome).toEqual({ ok: true, detail: "cube.glb — 1 mesh, 12 triangoli, ingombro 1,00 × 1,00 × 1,00" })
  })

  test("open reports a load that ended in an error as a failure", async () => {
    const { controller } = fake()
    expect(await runModelCommand(controller, request("@ade model open broken.stl"))).toEqual({
      ok: false,
      reason: "file non valido",
    })
  })

  test("open refuses a format before touching the panel", async () => {
    const { controller, calls } = fake()
    const outcome = await runModelCommand(controller, request("@ade model open photo.png"))
    expect(outcome.ok).toBe(false)
    expect(calls).toEqual([])
  })

  test("view needs a model and a known preset", async () => {
    const empty = fake()
    expect((await runModelCommand(empty.controller, request("@ade model view top"))).ok).toBe(false)

    const loaded = fake({
      source: "a.glb",
      loading: false,
      stats: { meshes: 1, triangles: 1, size: [1, 1, 1], animations: 0 },
    })
    expect(await runModelCommand(loaded.controller, request("@ade model view sopra"))).toEqual({
      ok: true,
      detail: "vista top",
    })
    expect((await runModelCommand(loaded.controller, request("@ade model view diagonale"))).ok).toBe(false)
  })

  test("an unknown verb lists the ones that exist", async () => {
    const { controller } = fake()
    const outcome = await runModelCommand(controller, request("@ade model spin"))
    expect(outcome).toEqual({
      ok: false,
      reason: "comando sconosciuto; disponibili: open, view, reload, capture, state",
    })
  })
})
