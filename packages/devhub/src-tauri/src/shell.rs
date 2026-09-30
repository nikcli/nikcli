//! Native shell integration: menu bar, tray, window effects.
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const PAGES: &[(&str, &str)] = &[
    ("overview", "Overview"),
    ("processes", "Processes"),
    ("tests", "Tests"),
    ("benchmarks", "Benchmarks"),
    ("playground", "Playground"),
    ("telemetry", "Telemetry"),
    ("manage", "Manage"),
    ("api", "API console"),
    ("activity", "Activity"),
    ("system", "System"),
    ("settings", "Settings"),
];

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // ── menu bar: ⌘1…⌘8 jump between pages, ⌘J toggles the assistant, ⌘K opens the command palette
    let go = Submenu::with_id(app, "go", "Go", true)?;
    for (i, (id, label)) in PAGES.iter().enumerate() {
        // ⌘1…⌘9 for the first nine pages, the macOS-standard ⌘, for Settings.
        let accel = match *id {
            "settings" => Some("CmdOrCtrl+,".to_string()),
            _ if i < 9 => Some(format!("CmdOrCtrl+{}", i + 1)),
            _ => None,
        };
        go.append(&MenuItem::with_id(
            app,
            format!("nav:{id}"),
            *label,
            true,
            accel,
        )?)?;
    }
    let tools = Submenu::with_id(app, "tools", "Tools", true)?;
    tools.append(&MenuItem::with_id(
        app,
        "ui:assistant",
        "Toggle assistant",
        true,
        Some("CmdOrCtrl+J"),
    )?)?;
    tools.append(&MenuItem::with_id(
        app,
        "ui:palette",
        "Command palette",
        true,
        Some("CmdOrCtrl+K"),
    )?)?;
    tools.append(&MenuItem::with_id(
        app,
        "ui:sample",
        "Sample now",
        true,
        Some("CmdOrCtrl+R"),
    )?)?;

    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "Nikcli DevHub",
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        menu.append(&app_menu)?;
    }
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    {
        let file =
            Submenu::with_items(app, "File", true, &[&PredefinedMenuItem::quit(app, None)?])?;
        menu.append(&file)?;
    }
    menu.append(&edit)?;
    menu.append(&go)?;
    menu.append(&tools)?;
    menu.append(&window)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        if let Some(page) = id.strip_prefix("nav:") {
            let _ = app.emit("nav", page);
        } else if let Some(ui) = id.strip_prefix("ui:") {
            let _ = app.emit("ui", ui);
        }
    });

    // ── tray: live nikcli memory in the menu bar (kept fresh by the sampler), quick jump to a page
    let tray_menu = Menu::new(app)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "tray:show",
        "Open DevHub",
        true,
        None::<&str>,
    )?)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "nav:processes",
        "Processes",
        true,
        None::<&str>,
    )?)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "nav:tests",
        "Tests",
        true,
        None::<&str>,
    )?)?;
    tray_menu.append(&PredefinedMenuItem::separator(app)?)?;
    tray_menu.append(&MenuItem::with_id(
        app,
        "tray:quit",
        "Quit",
        true,
        None::<&str>,
    )?)?;
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .tooltip("nikcli DevHub")
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "tray:show" => show_main(app),
            "tray:quit" => app.exit(0),
            id if id.starts_with("nav:") => {
                show_main(app);
                let _ = app.emit("nav", &id[4..]);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    // A missing tray backend (e.g. no appindicator library on a minimal Linux desktop) must not stop the app.
    if let Err(e) = tray.build(app) {
        eprintln!("devhub: tray icon unavailable: {e}");
    }
    Ok(())
}

/// Native translucent sidebar material on macOS. Returns whether an effect was applied so the
/// page only turns transparent when the window really is.
#[tauri::command]
pub fn window_effects(window: tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        return apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, Some(10.0)).is_ok();
    }
    #[allow(unreachable_code)]
    {
        let _ = window;
        false
    }
}
