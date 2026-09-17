/**
 * Ensures every table-of-contents entry points at a section that exists.
 *
 * A stale entry is invisible in review and silently does nothing when clicked,
 * which is how `/docs/mobile` ended up linking to two sections that had been
 * merged away. Pages whose `toc` is built at runtime (the generated API
 * reference) are skipped: their anchors come from the same data as their
 * sections, so they cannot disagree.
 */
import { Glob } from "bun"

const glob = new Glob("src/pages/docs/**/*.astro")
const failures: string[] = []
let checked = 0
let skipped = 0

for await (const file of glob.scan(".")) {
  const source = await Bun.file(file).text()

  const toc = source.match(/const toc = \[(.*?)\n\]/s)?.[1]
  if (!toc) continue

  // A computed toc is checked by construction, not by this script.
  if (toc.includes("...") || toc.includes("`") || toc.includes("${")) {
    skipped++
    continue
  }

  checked++
  const ids = new Set([...source.matchAll(/id="([^"]+)"/g)].map((match) => match[1]!))
  for (const [, anchor] of toc.matchAll(/href:\s*"#([^"]+)"/g)) {
    if (!ids.has(anchor!)) failures.push(`${file}: #${anchor} has no matching section`)
  }
}

if (failures.length > 0) {
  console.error(`Broken table-of-contents anchors:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}

console.log(`docs anchors OK (${checked} pages checked, ${skipped} generated pages skipped)`)
