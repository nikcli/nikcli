mod events;
mod paths;
mod repo;
mod service;
mod shell;
mod sys;
mod tasks;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sys::SysState::new())
        .manage(tasks::Tasks::default())
        .manage(events::Streams::default())
        .setup(|app| {
            shell::install(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            service::discover_services,
            service::api_request,
            service::provider_models,
            service::account_complete,
            service::account_sign_out,
            events::event_stream,
            events::event_stop,
            sys::system_snapshot,
            sys::system_subscribe,
            shell::window_effects,
            sys::kill_process,
            repo::repo_root,
            repo::set_repo_root,
            repo::read_repo_file,
            repo::write_scratch,
            repo::list_tests,
            repo::read_benchmarks,
            repo::storage_report,
            repo::list_logs,
            repo::tail_log,
            tasks::task_start,
            tasks::task_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nikcli devhub");
}
