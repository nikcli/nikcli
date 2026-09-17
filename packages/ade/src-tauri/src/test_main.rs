// The same app as main.rs, built as `ade-test` for ADE Test in development:
// see the `ade-test` [[bin]] entry in Cargo.toml.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ade_lib::run()
}
