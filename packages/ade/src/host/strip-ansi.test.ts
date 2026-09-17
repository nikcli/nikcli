import { describe, expect, test } from "bun:test"
import { stripAnsi } from "./shell"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
/** String terminator: the standard close for OSC, DCS, APC, PM and SOS. */
const ST = `${ESC}\\`

describe("stripAnsi", () => {
  test("removes colour without eating the words it wrapped", () => {
    expect(stripAnsi(`${ESC}[32mfatto${ESC}[0m`)).toBe("fatto")
  })

  test("removes cursor movement and erase sequences", () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1Ariga${ESC}[?25l`)).toBe("riga")
  })

  test("removes an OSC string closed by BEL, title and all", () => {
    expect(stripAnsi(`${ESC}]0;claude — nikcli${BEL}pronto`)).toBe("pronto")
  })

  test("removes an OSC string closed by ST", () => {
    expect(stripAnsi(`${ESC}]8;;https://esempio.it${ST}link`)).toBe("link")
  })

  test("keeps the last version of a line a spinner redrew", () => {
    // A progress line rewrites itself with a bare carriage return. Keeping every
    // pass would show the user the animation as a transcript.
    expect(stripAnsi("10%\r55%\r100%")).toBe("100%")
  })

  test("leaves a real newline alone", () => {
    expect(stripAnsi("prima\r\nseconda")).toBe("prima\r\nseconda")
  })

  test("passes plain text through untouched", () => {
    expect(stripAnsi("nessuna sequenza qui")).toBe("nessuna sequenza qui")
  })

  /*
   * Private parameters. crossterm opens every ratatui session with
   * `ESC[>1u` — push keyboard enhancement flags — and the parameter class
   * used to be `[0-9;?]`, which does not contain `>`: the sequence broke
   * immediately and `1u` became the first thing the session appeared to say.
   */
  test("removes the private-parameter sequences crossterm sends on startup", () => {
    expect(stripAnsi(`${ESC}[>1upronto`)).toBe("pronto")
    expect(stripAnsi(`${ESC}[<0;10;20M`)).toBe("")
    expect(stripAnsi(`${ESC}[=5h`)).toBe("")
  })

  test("removes the alternate-screen and cursor-mode sequences around them", () => {
    expect(stripAnsi(`${ESC}[?1049h${ESC}[?25lciao${ESC}[?25h${ESC}[?1049l`)).toBe("ciao")
  })

  test("removes an SGR written with colon sub-parameters", () => {
    expect(stripAnsi(`${ESC}[38:2::255:0:0mrosso${ESC}[0m`)).toBe("rosso")
  })

  /*
   * A DCS reply. The terminal answers XTGETTCAP with `ESC P +q<hex>=<hex>`,
   * and the rule for two-character escapes removed only the `ESC P`: the
   * payload stayed, and `+q4d73Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA` was the
   * first thing a restored nikcli session appeared to have said.
   */
  test("removes a DCS string, payload included", () => {
    expect(stripAnsi(`${ESC}P+q4d73Gi=31337,s=1,v=1${ST}pronto`)).toBe("pronto")
    expect(stripAnsi(`${ESC}P0+r${ST}`)).toBe("")
  })

  test("removes the other string sequences: APC, PM and SOS", () => {
    expect(stripAnsi(`${ESC}_nascosto${ST}visibile`)).toBe("visibile")
    expect(stripAnsi(`${ESC}^stato${ST}testo`)).toBe("testo")
    expect(stripAnsi(`${ESC}Xqualcosa${ST}testo`)).toBe("testo")
  })
})
