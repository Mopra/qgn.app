use arboard::{Clipboard, ImageData};
use image::GenericImageView;
use xcap::Monitor;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");

#[derive(serde::Deserialize)]
pub struct CaptureRegion {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[tauri::command]
async fn capture_region(region: CaptureRegion, window: WebviewWindow) -> Result<(), String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;

    // Get the window's position to determine which monitor it's on
    let window_pos = window.outer_position().map_err(|e| e.to_string())?;

    // Find the monitor that contains the window position
    let monitor = monitors
        .iter()
        .find(|m| {
            let mx = m.x();
            let my = m.y();
            let mw = m.width() as i32;
            let mh = m.height() as i32;
            window_pos.x >= mx && window_pos.x < mx + mw &&
            window_pos.y >= my && window_pos.y < my + mh
        })
        .or_else(|| monitors.first())
        .ok_or("No monitor found")?;

    // Capture the specified region
    let capture = monitor.capture_image().map_err(|e| e.to_string())?;

    // Crop to the requested region
    let cropped = capture.view(
        region.x as u32,
        region.y as u32,
        region.width,
        region.height,
    ).to_image();

    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let img_data = ImageData {
        width: cropped.width() as usize,
        height: cropped.height() as usize,
        bytes: cropped.into_raw().into(),
    };
    clipboard
        .set_image(img_data)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn hide_overlay(window: WebviewWindow) {
    let _ = window.hide();
}

fn show_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        // Get cursor position to determine which monitor to show overlay on
        if let Ok(monitors) = Monitor::all() {
            if let Ok(cursor_pos) = window.cursor_position() {
                let cursor_x = cursor_pos.x as i32;
                let cursor_y = cursor_pos.y as i32;

                // Find the monitor containing the cursor
                if let Some(target_monitor) = monitors.iter().find(|m| {
                    let mx = m.x();
                    let my = m.y();
                    let mw = m.width() as i32;
                    let mh = m.height() as i32;
                    cursor_x >= mx
                        && cursor_x < mx + mw
                        && cursor_y >= my
                        && cursor_y < my + mh
                }) {
                    // Move and resize window to cover the target monitor
                    let _ = window.set_fullscreen(false);
                    let _ = window.set_position(tauri::Position::Physical(
                        tauri::PhysicalPosition::new(target_monitor.x(), target_monitor.y()),
                    ));
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                        target_monitor.width(),
                        target_monitor.height(),
                    )));
                }
            }
        }

        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let quit_item = MenuItem::with_id(app, "quit", "Quit qgn", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit_item])?;
    let icon = Image::from_bytes(TRAY_ICON)?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("qgn - Press Ctrl+Q to capture")
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .build(app)?;

    Ok(())
}

fn setup_hotkey(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyQ);
    let app_handle = app.clone();

    app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, _event| {
        show_overlay(&app_handle);
    })?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![capture_region, hide_overlay])
        .setup(|app| {
            setup_tray(app.handle())?;
            setup_hotkey(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
