/**
 * The scene behind the 3D panel.
 *
 * Imported only by `model-pane.tsx`, and only with `import()` once a panel
 * actually opens: three.js and its loaders are several hundred kilobytes that
 * a workbench with no model on screen has no reason to parse.
 *
 * Drawn on demand, never in a loop. A frame is rendered when something asks
 * for one — the camera moved, the pane was resized, the model or the theme
 * changed — and not at all while the pane is scrolled out, covered by another
 * view, or the window is hidden. A static model costs nothing at rest, which
 * is the rule every animation in ADE follows.
 */

import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { FBXLoader } from "three/addons/loaders/FBXLoader.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MTLLoader } from "three/addons/loaders/MTLLoader.js"
import { OBJLoader } from "three/addons/loaders/OBJLoader.js"
import { STLLoader } from "three/addons/loaders/STLLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import {
  frameDistance,
  gltfResources,
  modelFormat,
  mtlTextures,
  objMaterialLibraries,
  resolveResource,
  SUPERSEDED,
  viewDirection,
  type ModelStats,
  type ViewPreset,
} from "./model"

export type ReadBytes = (path: string) => Promise<Uint8Array>

export interface LoadResult {
  readonly stats: ModelStats
  /** Every file the model was read from, the model first: what the panel watches. */
  readonly files: readonly string[]
  /** Resources the model names that could not be read, for the note under the stage. */
  readonly missing: readonly string[]
}

export interface ModelViewer {
  /** `reframe` false keeps the camera where the user put it: a reload of the same file. */
  /**
   * `isCurrent` is asked right before the scene is replaced: a load that was
   * overtaken by a later one is parsed, disposed and never shown.
   */
  load(path: string, read: ReadBytes, reframe: boolean, isCurrent?: () => boolean): Promise<LoadResult>
  view(preset: ViewPreset): void
  /** Re-reads the colours from the stage element, after a theme change. */
  syncTheme(): void
  capture(): Promise<Uint8Array>
  dispose(): void
}

const FOV = 45

export function createModelViewer(stage: HTMLElement, onLost: (reason: string) => void): ModelViewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.domElement.dataset.slot = "model-canvas"
  stage.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1000)
  camera.position.set(3, 2.4, 3)

  /*
   * Light that works for every format. The room environment is what PBR
   * materials from glTF are lit by; Phong and Lambert materials from OBJ, STL
   * and FBX ignore it, so a hemisphere fill and a light riding on the camera
   * keep them readable from whichever side the user orbits to.
   */
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = environment
  scene.environmentIntensity = 0.9
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.8))
  const headlight = new THREE.DirectionalLight(0xffffff, 1.3)
  headlight.position.set(0.5, 1, 1)
  camera.add(headlight)
  scene.add(camera)

  const controls = new OrbitControls(camera, renderer.domElement)
  // No damping: damping needs a frame every tick until the motion settles,
  // which is a loop by another name.
  controls.enableDamping = false
  controls.screenSpacePanning = true

  let grid: THREE.GridHelper | undefined
  let model: THREE.Object3D | undefined
  let bounds = new THREE.Sphere(new THREE.Vector3(), 1)
  let gridColor = new THREE.Color(0x444444)
  let disposed = false

  /* ── Drawing on demand ────────────────────────────────────────────── */

  let frame = 0
  let dirty = true
  let onScreen = true

  const visible = () => onScreen && document.visibilityState !== "hidden"

  const render = () => {
    frame = 0
    if (disposed) return
    if (!visible()) {
      dirty = true
      return
    }
    dirty = false
    renderer.render(scene, camera)
  }

  const invalidate = () => {
    if (disposed) return
    if (!visible()) {
      dirty = true
      return
    }
    if (!frame) frame = requestAnimationFrame(render)
  }

  controls.addEventListener("change", invalidate)

  const resize = () => {
    const width = Math.max(1, stage.clientWidth)
    const height = Math.max(1, stage.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    invalidate()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(stage)

  const intersection = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting)
    if (onScreen && dirty) invalidate()
  })
  intersection.observe(stage)

  const onVisibility = () => {
    if (visible() && dirty) invalidate()
  }
  document.addEventListener("visibilitychange", onVisibility)

  const onContextLost = (event: Event) => {
    event.preventDefault()
    onLost("il contesto grafico è stato perso; riapri il pannello")
  }
  renderer.domElement.addEventListener("webglcontextlost", onContextLost)

  /* ── Theme ─────────────────────────────────────────────────────────── */

  const syncTheme = () => {
    const style = getComputedStyle(stage)
    scene.background = new THREE.Color().setStyle(style.backgroundColor || "#1a1818", THREE.SRGBColorSpace)
    gridColor = new THREE.Color().setStyle(style.color || "#444444", THREE.SRGBColorSpace)
    if (grid) rebuildGrid()
    invalidate()
  }

  const rebuildGrid = () => {
    if (grid) {
      scene.remove(grid)
      grid.geometry.dispose()
      disposeMaterial(grid.material)
    }
    if (!model) return
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const extent = niceCeil(Math.max(size.x, size.z, 1e-3) * 2)
    grid = new THREE.GridHelper(extent, 10, gridColor, gridColor)
    grid.position.set(bounds.center.x, box.min.y, bounds.center.z)
    const material = grid.material as THREE.Material
    material.transparent = true
    material.opacity = 0.55
    scene.add(grid)
  }

  /* ── Camera ───────────────────────────────────────────────────────── */

  const view = (preset: ViewPreset) => {
    const [x, y, z] = viewDirection(preset)
    const distance = frameDistance(bounds.radius, FOV, camera.aspect)
    controls.target.copy(bounds.center)
    camera.position.set(bounds.center.x + x * distance, bounds.center.y + y * distance, bounds.center.z + z * distance)
    camera.near = Math.max(distance / 1000, bounds.radius / 1000, 1e-4)
    camera.far = distance * 20 + bounds.radius * 4
    camera.updateProjectionMatrix()
    controls.update()
    invalidate()
  }

  /* ── Loading ──────────────────────────────────────────────────────── */

  const load = async (
    path: string,
    read: ReadBytes,
    reframe: boolean,
    isCurrent?: () => boolean,
  ): Promise<LoadResult> => {
    const format = modelFormat(path)
    if (!format) throw new Error("formato non supportato")

    const bytes = await read(path)
    const files = [path]
    const missing: string[] = []
    const blobUrls: string[] = []
    const resources = new Map<string, string>()

    /*
     * Every file a model refers to is read through the host, not fetched.
     *
     * The webview has no access to the disk, and the host reads only inside
     * the projects this window opened. So the resources a format names are
     * read first, turned into blob URLs, and handed to the loader under the
     * exact URI it will ask for.
     */
    const manager = new THREE.LoadingManager()
    manager.setURLModifier((url) => resources.get(url) ?? url)
    /*
     * OBJ materials and FBX textures load after `parse` has returned. The
     * blob URLs have to outlive those loads, so the model is shown — and the
     * URLs revoked — only once the manager says everything it started is done.
     */
    let busy = false
    let settled: () => void = () => {}
    manager.onStart = () => {
      busy = true
    }
    manager.onLoad = () => {
      busy = false
      settled()
    }
    const loadsSettled = () => (busy ? new Promise<void>((resolve) => (settled = resolve)) : Promise.resolve())
    const provide = async (uri: string, type?: string) => {
      if (resources.has(uri)) return
      const resolved = resolveResource(path, uri)
      if (!resolved) return
      try {
        const data = await read(resolved)
        const url = URL.createObjectURL(new Blob([toArrayBuffer(data)], type ? { type } : undefined))
        blobUrls.push(url)
        resources.set(uri, url)
        files.push(resolved)
      } catch {
        missing.push(uri)
        files.push(resolved)
      }
    }

    try {
      let object: THREE.Object3D
      let animations = 0

      if (format === "glb" || format === "gltf") {
        const loader = new GLTFLoader(manager)
        loader.setMeshoptDecoder(MeshoptDecoder)
        let data: ArrayBuffer | string = toArrayBuffer(bytes)
        if (format === "gltf") {
          data = new TextDecoder().decode(bytes)
          for (const uri of gltfResources(data)) await provide(uri)
        }
        const gltf = await loader.parseAsync(data, "")
        object = gltf.scene
        animations = gltf.animations.length
      } else if (format === "obj") {
        const text = new TextDecoder().decode(bytes)
        const loader = new OBJLoader(manager)
        for (const library of objMaterialLibraries(text)) {
          const resolved = resolveResource(path, library)
          if (!resolved) continue
          try {
            const mtl = new TextDecoder().decode(await read(resolved))
            files.push(resolved)
            for (const texture of mtlTextures(mtl)) await provide(texture)
            const materials = new MTLLoader(manager).parse(mtl, "")
            materials.preload()
            loader.setMaterials(materials)
          } catch {
            missing.push(library)
          }
        }
        object = loader.parse(text)
      } else if (format === "stl") {
        const geometry = new STLLoader().parse(toArrayBuffer(bytes))
        geometry.computeVertexNormals()
        const colored = Boolean((geometry as THREE.BufferGeometry & { hasColors?: boolean }).hasColors)
        const material = new THREE.MeshStandardMaterial({
          color: colored ? 0xffffff : 0x7f98ab,
          vertexColors: colored,
          metalness: 0.1,
          roughness: 0.6,
        })
        object = new THREE.Mesh(geometry, material)
      } else {
        const group = new FBXLoader(manager).parse(toArrayBuffer(bytes), "")
        object = group
        animations = group.animations.length
      }

      await loadsSettled()
      if (isCurrent && !isCurrent()) {
        disposeObject(object)
        throw new Error(SUPERSEDED)
      }
      replaceModel(object, reframe)
      return { stats: statsOf(object, animations), files, missing }
    } finally {
      // The textures have been decoded into images by now; the URLs are not
      // needed again, and each one pins its bytes in memory until revoked.
      for (const url of blobUrls) URL.revokeObjectURL(url)
    }
  }

  const replaceModel = (object: THREE.Object3D, reframe: boolean) => {
    const first = !model || reframe
    if (model) {
      scene.remove(model)
      disposeObject(model)
    }
    model = object
    scene.add(object)
    const box = new THREE.Box3().setFromObject(object)
    bounds = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere())
    rebuildGrid()
    /*
     * A reload of the same file keeps the camera where the user put it: the
     * model is being watched while it is edited, and jumping back to the
     * default view on every save would undo the angle they were checking.
     * A different file is framed afresh, or it may not be in view at all.
     */
    if (first) view("iso")
    else invalidate()
  }

  const capture = async (): Promise<Uint8Array> => {
    // Rendered and read in the same task: without `preserveDrawingBuffer`
    // the buffer is only guaranteed until the frame is composited.
    renderer.render(scene, camera)
    const blob = await new Promise<Blob | null>((resolve) => renderer.domElement.toBlob(resolve, "image/png"))
    if (!blob) throw new Error("codifica dell'immagine fallita")
    return new Uint8Array(await blob.arrayBuffer())
  }

  const dispose = () => {
    disposed = true
    if (frame) cancelAnimationFrame(frame)
    resizeObserver.disconnect()
    intersection.disconnect()
    document.removeEventListener("visibilitychange", onVisibility)
    renderer.domElement.removeEventListener("webglcontextlost", onContextLost)
    controls.dispose()
    if (model) disposeObject(model)
    if (grid) {
      grid.geometry.dispose()
      disposeMaterial(grid.material)
    }
    environment.dispose()
    pmrem.dispose()
    renderer.dispose()
    // Released now rather than when the collector gets to it: a webview caps
    // live WebGL contexts, and opening and closing a few panels would hit it.
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }

  syncTheme()
  resize()

  return { load, view, syncTheme, capture, dispose }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function niceCeil(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude
  }
  return 10 * magnitude
}

function statsOf(object: THREE.Object3D, animations: number): ModelStats {
  let meshes = 0
  let triangles = 0
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    meshes++
    const geometry = mesh.geometry
    const count = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0)
    triangles += Math.floor(count / 3)
  })
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3())
  return { meshes, triangles, size: [size.x, size.y, size.z], animations }
}

/*
 * Every drawable, not only meshes: `OBJLoader` makes `LineSegments` for `l`
 * records and `Points` for `p`, and FBX can carry lines. Skipping them left
 * their buffers on the GPU after every reload.
 */
function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const drawable = child as THREE.Mesh | THREE.Line | THREE.Points
    if (!isDrawable(drawable)) return
    drawable.geometry.dispose()
    disposeMaterial(drawable.material)
  })
}

function isDrawable(object: THREE.Object3D): object is THREE.Mesh | THREE.Line | THREE.Points {
  const flags = object as Partial<Record<"isMesh" | "isLine" | "isPoints", boolean>>
  return Boolean(flags.isMesh || flags.isLine || flags.isPoints)
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  for (const item of Array.isArray(material) ? material : [material]) {
    for (const value of Object.values(item)) {
      if (value instanceof THREE.Texture) value.dispose()
    }
    item.dispose()
  }
}
