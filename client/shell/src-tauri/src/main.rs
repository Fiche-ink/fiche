// fiche window app: a window around the app screen that the fiche CLI daemon serves on
// 127.0.0.1 (desktop/cli/ui.js), with a tray icon, on macOS, Linux, and Windows for fiche in WSL2.
// It has no logic of its own and no IPC into the page: the screen talks to the daemon over HTTP.
//
// Where the screen is:
//   --url <http://127.0.0.1:port/?t=token>   given by the daemon when it opens the window
//   --url-cmd <program> [args...]            a command that prints that address (Start menu shortcut for WSL2)
//   otherwise                                ~/.local/bin/fiche ui --url (Dock, Launchpad, app menu)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    thread,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const LABEL: &str = "main";
static HIDE_ON_CLOSE: AtomicBool = AtomicBool::new(false);

fn korean() -> bool {
    sys_locale::get_locale().map(|l| l.to_lowercase().starts_with("ko")).unwrap_or(false)
}
fn t(ko: &'static str, en: &'static str) -> &'static str {
    if korean() { ko } else { en }
}

fn local(url: &Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}
fn screen_url(s: &str) -> Option<Url> {
    Url::parse(s.trim()).ok().filter(local)
}

enum Source {
    Url(Url),
    Cmd(Vec<String>),
}

fn source(args: &[String]) -> Source {
    if let Some(i) = args.iter().position(|a| a == "--url") {
        if let Some(u) = args.get(i + 1).and_then(|s| screen_url(s)) {
            return Source::Url(u);
        }
    }
    if let Some(i) = args.iter().position(|a| a == "--url-cmd") {
        let cmd = args[i + 1..].to_vec();
        if !cmd.is_empty() {
            return Source::Cmd(cmd);
        }
    }
    Source::Cmd(default_cmd())
}

fn default_cmd() -> Vec<String> {
    if cfg!(windows) {
        ["wsl.exe", "-e", "sh", "-lc", "fiche ui --url"].iter().map(|s| s.to_string()).collect()
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        vec![format!("{home}/.local/bin/fiche"), "ui".into(), "--url".into()]
    }
}

// Runs the command and takes the last line that is a 127.0.0.1 address. `fiche ui --url` also
// starts the daemon when it is not running.
fn run_cmd(cmd: &[String]) -> Option<Url> {
    let mut c = Command::new(&cmd[0]);
    c.args(&cmd[1..]);
    #[cfg(not(windows))]
    {
        // Started from the Dock or an app menu, PATH is the bare system one, and the fiche
        // launcher may need a node from Homebrew or /usr/local.
        let path = std::env::var("PATH").unwrap_or_default();
        c.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up for wsl.exe
    }
    let out = c.output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().rev().find_map(screen_url)
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// The window starts on page/index.html ("starting") and moves to the screen once its address
// is known; if it cannot be found, the page says how to start fiche.
fn load(app: AppHandle, src: Source) {
    thread::spawn(move || {
        let url = match src {
            Source::Url(u) => Some(u),
            Source::Cmd(c) => run_cmd(&c),
        };
        if let Some(w) = app.get_webview_window(LABEL) {
            match url {
                Some(u) => {
                    let r = w.navigate(u);
                    eprintln!("fiche window: screen found, navigate {:?}", r.err());
                }
                None => {
                    eprintln!("fiche window: screen not found");
                    let _ = w.eval("document.body.classList.add('failed')");
                }
            }
        }
    });
}

fn tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", t("fiche 열기", "Open fiche"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t("종료", "Quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut b = TrayIconBuilder::with_id("fiche")
        .tooltip("fiche")
        .menu(&menu)
        .menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    eprintln!("fiche window: starting");
    tauri::Builder::default()
        // A second start (the daemon opening the window, a shortcut) goes to the running window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--url" || a == "--url-cmd") {
                load(app.clone(), source(&argv));
            }
            show(app);
        }))
        .setup(move |app| {
            eprintln!("fiche window: setup");
            let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
                .title("fiche")
                .inner_size(1040.0, 680.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .on_navigation(|url| {
                    let internal = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
                    if internal || local(url) {
                        return true;
                    }
                    if url.scheme() == "https" {
                        let _ = open::that_detached(url.as_str());
                    }
                    false
                })
                .build()?;
            // Shown explicitly: on some Linux setups a window built here stays unmapped otherwise.
            let shown = win.show();
            eprintln!("fiche window: created, show {:?}", shown.err());
            {
                let w = win.clone();
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_secs(5));
                    eprintln!("fiche window: after 5 s visible {:?} size {:?} position {:?}", w.is_visible().ok(), w.inner_size().ok(), w.outer_position().ok());
                });
            }
            // Linux without an AppIndicator library panics while making the tray; the window
            // then simply closes for real instead of hiding into a tray that is not there.
            let tray_ok = matches!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tray(app))), Ok(Ok(())));
            HIDE_ON_CLOSE.store(tray_ok || cfg!(target_os = "macos"), Ordering::Relaxed);
            eprintln!("fiche window: tray {}", if tray_ok { "on" } else { "off" });
            load(app.handle().clone(), source(&args));
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                if HIDE_ON_CLOSE.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("fiche window")
        .run(on_run);
}

// Dock icon clicked (or `open -a fiche`) while the window is hidden.
#[cfg(target_os = "macos")]
fn on_run(app: &AppHandle, e: tauri::RunEvent) {
    if let tauri::RunEvent::Reopen { .. } = e {
        show(app);
    }
}
#[cfg(not(target_os = "macos"))]
fn on_run(_app: &AppHandle, _e: tauri::RunEvent) {}
