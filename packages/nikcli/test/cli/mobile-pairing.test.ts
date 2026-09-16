import { describe, expect, test } from "bun:test"
import { generateQR, generateQRMatrix, shouldRenderCompactTerminalQR } from "@nikcli-ai/remote"
import { shouldUseAsciiQR } from "@nikcli-ai/util/win32"
import { buildMobilePairingDeepLink } from "@/cli/handlers/mobile/shared"
import { rankLocalAddress, selectPairingAddresses } from "@nikcli-ai/util/mobile-pairing"
import { normalizeMobileServerUrl, shouldShowPairingLink } from "@tui/component/dialog-mobile-connect"
import {
  asciiQRRuns,
  qrCanImageFit,
  qrDialogBudget,
  qrFittedSize,
  qrImagePlacement,
  qrRenderHeight,
  qrRenderMode,
  qrRenderWidth,
  qrToPixelImage,
  renderQRRows,
} from "@tui/component/qr"

describe("mobile pairing", () => {
  /**
   * The Windows shape that broke pairing: an unplugged adapter and the WSL switch both hold an
   * address, the Wi-Fi one is not first, and the QR took whatever came first.
   */
  const windowsInterfaces = [
    { name: "Ethernet", address: "169.254.83.107", family: "IPv4", internal: false },
    { name: "vEthernet (WSL)", address: "172.28.0.1", family: "IPv4", internal: false },
    { name: "Wi-Fi", address: "192.168.1.14", family: "IPv4", internal: false },
    { name: "Loopback", address: "127.0.0.1", family: "IPv4", internal: true },
    { name: "Wi-Fi", address: "fe80::1c2d", family: "IPv6", internal: false },
  ]

  test("puts the reachable Wi-Fi address first on the Windows shape that broke pairing", () => {
    expect(selectPairingAddresses(windowsInterfaces)).toEqual(["192.168.1.14", "172.28.0.1"])
  })

  test("drops link-local addresses, which no phone can reach", () => {
    const addresses = selectPairingAddresses(windowsInterfaces)

    expect(addresses).not.toContain("169.254.83.107")
  })

  test("drops loopback and IPv6 entries", () => {
    const addresses = selectPairingAddresses(windowsInterfaces)

    expect(addresses).not.toContain("127.0.0.1")
    expect(addresses).not.toContain("fe80::1c2d")
  })

  test("still offers virtual adapters when they are all there is", () => {
    expect(
      selectPairingAddresses([
        { name: "vEthernet (WSL)", address: "172.28.0.1", family: "IPv4", internal: false },
        { name: "docker0", address: "172.17.0.1", family: "IPv4", internal: false },
      ]),
    ).toEqual(["172.28.0.1", "172.17.0.1"])
  })

  test("returns nothing when every address is link-local, so the dialog can say so", () => {
    expect(
      selectPairingAddresses([
        { name: "Ethernet", address: "169.254.83.107", family: "IPv4", internal: false },
        { name: "Ethernet 2", address: "169.254.1.9", family: "IPv4", internal: false },
      ]),
    ).toEqual([])
  })

  test("keeps enumeration order between addresses of equal rank", () => {
    expect(
      selectPairingAddresses([
        { name: "Ethernet", address: "192.168.1.20", family: "IPv4", internal: false },
        { name: "Wi-Fi", address: "192.168.1.14", family: "IPv4", internal: false },
      ]),
    ).toEqual(["192.168.1.20", "192.168.1.14"])
  })

  test("does not mutate the interface list it is given", () => {
    const entries = [...windowsInterfaces]
    selectPairingAddresses(entries)

    expect(entries).toEqual(windowsInterfaces)
  })

  test("ranks a real LAN address above a virtual adapter", () => {
    const entries = [
      { name: "vEthernet (WSL)", address: "172.28.0.1" },
      { name: "Wi-Fi", address: "192.168.1.14" },
      { name: "Tailscale", address: "100.86.3.2" },
    ]

    const ordered = [...entries].sort((a, b) => rankLocalAddress(a) - rankLocalAddress(b)).map((e) => e.address)

    expect(ordered[0]).toBe("192.168.1.14")
    expect(ordered.at(-1)).toBe("100.86.3.2")
  })

  test("builds the deep link consumed by the mobile app", () => {
    const value = buildMobilePairingDeepLink({
      serverUrl: "http://192.168.1.4:4096",
      token: "nkm_secret",
      directory: "/tmp/a project",
    })
    const url = new URL(value)

    expect(url.protocol).toBe("nikcli:")
    expect(url.hostname).toBe("connect")
    expect(url.searchParams.get("server")).toBe("http://192.168.1.4:4096")
    expect(url.searchParams.get("token")).toBe("nkm_secret")
    expect(url.searchParams.get("directory")).toBe("/tmp/a project")
  })

  test("builds a cloud link without leaking the local directory", () => {
    const value = buildMobilePairingDeepLink({
      serverUrl: "https://cloud.example.com",
      token: "nkm_cloud",
    })
    const url = new URL(value)

    expect(url.searchParams.get("server")).toBe("https://cloud.example.com")
    expect(url.searchParams.get("token")).toBe("nkm_cloud")
    expect(url.searchParams.has("directory")).toBe(false)
  })

  test("normalizes cloud server and mobile endpoint URLs", () => {
    expect(normalizeMobileServerUrl("cloud.example.com/")).toBe("https://cloud.example.com")
    expect(normalizeMobileServerUrl("https://cloud.example.com/base/mobile/teleport")).toBe(
      "https://cloud.example.com/base",
    )
    expect(normalizeMobileServerUrl("ftp://cloud.example.com")).toBeNull()
    expect(normalizeMobileServerUrl("")).toBeNull()
  })

  test("generates the QR matrix used by the TUI", async () => {
    const matrix = await generateQRMatrix(
      buildMobilePairingDeepLink({
        serverUrl: "http://192.168.1.4:4096",
        token: "nkm_secret",
        directory: "/Volumes/SSD/Projects/nikcli",
      }),
    )

    expect(matrix).not.toBeNull()
    expect(matrix?.length).toBeGreaterThan(0)
    expect(matrix?.every((row) => row.length === matrix.length)).toBe(true)
  })

  test("packs two QR module rows into one terminal row without truncation", () => {
    const matrix = [
      [true, false, true],
      [true, true, false],
    ]

    expect(renderQRRows(matrix, 0)).toEqual(["█▄▀"])
  })

  test("pads odd-height matrices with a blank half-row so the output is even", () => {
    const matrix = [
      [true, false, true],
      [true, true, false],
      [false, true, true],
    ]

    // Three module rows → two terminal rows. The bottom output row is the
    // last module row paired with a blank half-row, so the trailing column
    // is `▀` (top half of the last filled module) — not a space.
    expect(renderQRRows(matrix, 0)).toEqual(["█▄▀", " ▀▀"])
  })

  test("spells the pairing link out only where the QR cannot be trusted", () => {
    // Windows terminals all run through ConPTY, where a large frame can lose
    // cells and leave the QR a blank white square. Everywhere else the link
    // stays off screen: it carries the pairing token in clear text.
    expect(shouldShowPairingLink("win32")).toBe(true)
    expect(shouldShowPairingLink("darwin")).toBe(false)
    expect(shouldShowPairingLink("linux")).toBe(false)
  })

  test("Windows draws the QR with ASCII spaces, not half-block glyphs", () => {
    const conhost = {}
    expect(shouldUseAsciiQR("win32", conhost)).toBe(true)
    expect(shouldUseAsciiQR("darwin", conhost)).toBe(false)
    expect(shouldUseAsciiQR("linux", conhost)).toBe(false)
    expect(qrRenderMode("win32", conhost)).toBe("ascii")
    expect(qrRenderMode("darwin", conhost)).toBe("half-block")
  })

  test("WezTerm and Windows Terminal on Windows keep the compact half-block QR", () => {
    // ASCII mode is two cells per module. On a GPU terminal that can draw
    // `█▀▄` that doubles a pairing symbol past a typical pane — WezTerm on
    // Windows was the report. cmd.exe / conhost still need the fallback.
    const wezterm = {
      TERM_PROGRAM: "WezTerm",
      WEZTERM_EXECUTABLE: "wezterm-gui.exe",
    }
    const windowsTerminal = { WT_SESSION: "abc", WT_PROFILE_ID: "{guid}" }
    expect(shouldUseAsciiQR("win32", wezterm)).toBe(false)
    expect(shouldUseAsciiQR("win32", windowsTerminal)).toBe(false)
    expect(qrRenderMode("win32", wezterm)).toBe("half-block")
    expect(qrRenderMode("win32", windowsTerminal)).toBe("half-block")
    expect(shouldRenderCompactTerminalQR("win32", wezterm)).toBe(true)
    expect(shouldRenderCompactTerminalQR("win32", windowsTerminal)).toBe(true)
    expect(shouldRenderCompactTerminalQR("win32", {})).toBe(false)
    expect(shouldRenderCompactTerminalQR("darwin", {})).toBe(true)
  })

  test("a herdr pane on Windows keeps the compact half-block QR", () => {
    // herdr's pane VT is libghostty. Host WezTerm identity can leak into
    // the child, but HERDR_* is what proves we are inside the multiplexer.
    const herdr = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1Y:p6",
      TERM_PROGRAM: "WezTerm",
    }
    expect(shouldUseAsciiQR("win32", herdr)).toBe(false)
    expect(qrRenderMode("win32", herdr)).toBe("half-block")
    expect(shouldRenderCompactTerminalQR("win32", herdr)).toBe(true)
    expect(qrCanImageFit(herdr)).toBe(true)
  })

  test("fits an overflowing pairing QR into the remaining dialog cells", () => {
    const matrix = Array.from({ length: 53 }, () => Array.from({ length: 53 }, () => true))
    const budget = qrDialogBudget(120, 40)
    expect(budget.columns).toBeLessThanOrEqual(114)
    expect(budget.rows).toBeLessThanOrEqual(24)

    const halfBlock = qrFittedSize(matrix, budget.columns, budget.rows, {
      mode: "half-block",
    })
    expect(halfBlock.image).toBe(false)
    expect(halfBlock.width).toBe(57)
    expect(halfBlock.height).toBe(28)

    const image = qrFittedSize(matrix, budget.columns, budget.rows, {
      mode: "half-block",
      image: true,
    })
    expect(image.image).toBe(true)
    expect(image.width).toBeLessThanOrEqual(budget.columns)
    expect(image.height).toBeLessThanOrEqual(budget.rows)
    expect(image.width).toBeGreaterThan(image.height)

    const placed = qrImagePlacement(40, 16, 2)
    expect(placed.columns).toBeLessThanOrEqual(40)
    expect(placed.rows).toBeLessThanOrEqual(16)
    expect(placed.columns).toBe(placed.rows * 2)

    const pixels = qrToPixelImage(
      [
        [true, false],
        [false, true],
      ],
      2,
      0,
    )
    expect(pixels.width).toBe(4)
    expect(pixels.height).toBe(4)
  })

  test("ASCII mode is two columns and one row per module so the square stays square", () => {
    const matrix = [
      [true, false, true],
      [true, true, false],
    ]

    expect(qrRenderWidth(matrix, 0, "half-block")).toBe(5)
    expect(qrRenderHeight(matrix, 0, "half-block")).toBe(1)
    expect(qrRenderWidth(matrix, 0, "ascii")).toBe(8)
    expect(qrRenderHeight(matrix, 0, "ascii")).toBe(2)
  })

  test("run-length encodes ASCII QR rows so adjacent modules share one cell run", () => {
    expect(asciiQRRuns([true, true, false, true])).toEqual([
      { dark: true, count: 2 },
      { dark: false, count: 1 },
      { dark: true, count: 1 },
    ])
  })

  test("CLI terminal QR on Windows is 16-color spaces, not █▀▄", async () => {
    const url = "nikcli://connect?server=http://192.168.1.4:4096&token=nkm_secret"
    const windows = await generateQR(url, { small: false })
    const compact = await generateQR(url, { small: true })

    expect(windows).toContain("\x1b[40m  \x1b[0m")
    expect(windows).toContain("\x1b[47m  \x1b[0m")
    expect(windows).not.toContain("█")
    expect(windows).not.toContain("▀")
    expect(windows).not.toContain("▄")
    expect(compact).toMatch(/[█▀▄]/)
  })
})
