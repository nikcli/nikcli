/**
 * Asset imports, as the bundler rewrites them.
 *
 * `import url from "…?url"` is Vite's way of saying "emit this file next to
 * the application and give me its path". TypeScript knows nothing about the
 * suffix and refuses the specifier outright, so the shape is declared here
 * once. See `asr/ort-assets.ts`, the only place it is used, for why the
 * runtime's WebAssembly has to come from the bundle rather than from a CDN.
 *
 * Outside a bundler the import simply fails at runtime and the caller falls
 * back — the declaration is about the type checker, not about the behaviour.
 */
declare module "*?url" {
  const url: string
  export default url
}
