//! In-app updates.
//!
//! The manifest and the signed bundles come from the fork's releases; see
//! `.github/workflows/ade-release.yml` for how they are produced, and
//! `plugins.updater` in `tauri.conf.json` for the endpoint and the public key.

/// Downloads the newest signed ADE release, installs it and restarts into it.
///
/// Everything happens here rather than through the updater plugin's JavaScript
/// API, so no updater permission is granted to the window: a page in the
/// browser pane cannot trigger an install, and the only thing this command can
/// install is what the fork's manifest, signed with ADE's key, points at.
///
/// On Windows the NSIS installer takes over and closes ADE itself; elsewhere
/// the new bundle is in place when the download returns, and ADE restarts.
#[tauri::command]
pub async fn ade_update_install(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "nessun aggiornamento installabile per questa piattaforma".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg(test)]
mod tests {
    /// The plugin reads this section when ADE starts: a key or endpoint it
    /// cannot parse stops every installed copy from opening, not just from
    /// updating.
    #[test]
    fn the_updater_section_of_the_config_parses() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).expect("plugins.updater");
        assert_eq!(updater.endpoints.len(), 1);
        assert!(updater.endpoints[0].as_str().starts_with("https://github.com/SandroHub013/nikcli/releases/"));
        assert!(!updater.pubkey.is_empty());
    }
}
