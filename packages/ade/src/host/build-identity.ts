/**
 * Which ADE build is running. The test build differs from the official one
 * only by its identifier (`src-tauri/tauri.test.conf.json`), mirroring
 * `is_test_build` in the Rust host.
 */
export const isTestIdentifier = (identifier: string): boolean => identifier.endsWith(".test")
