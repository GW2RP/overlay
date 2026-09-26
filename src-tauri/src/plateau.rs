//! L'icône de la zone de notification.
//!
//! L'application passe sa vie sans fenêtre à l'écran : la fenêtre principale se
//! range derrière le jeu, et les overlays sont là pour être vus, pas cliqués.
//! L'icône dit qu'elle tourne, et donne un chemin qui ne dépend d'aucun
//! raccourci : rouvrir la fenêtre principale, basculer l'édition, quitter.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::overlays::{basculer_edition, montrer_principale};

/// La marque à 128 px plutôt qu'à 32 : la zone de notification demande entre
/// 16 et 32 px selon l'écran, et une grande source se réduit mieux qu'une
/// petite ne s'agrandit.
const ICONE: &[u8] = include_bytes!("../icons/128x128.png");

const OUVRIR: &str = "plateau-ouvrir";
const EDITION: &str = "plateau-edition";
const QUITTER: &str = "plateau-quitter";

pub fn installer(app: &AppHandle) -> tauri::Result<()> {
    let ouvrir = MenuItem::with_id(app, OUVRIR, "Ouvrir GW2RP Overlay", true, None::<&str>)?;
    let edition = MenuItem::with_id(
        app,
        EDITION,
        "Basculer le mode édition",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let separateur = PredefinedMenuItem::separator(app)?;
    let quitter = MenuItem::with_id(app, QUITTER, "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&ouvrir, &edition, &separateur, &quitter])?;

    let mut plateau = TrayIconBuilder::with_id("gw2rp-overlay")
        .tooltip("GW2RP Overlay")
        .menu(&menu)
        // La convention de Windows : le bouton gauche ouvre, le menu est au
        // bouton droit.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, evenement| sur_menu(app, evenement.id().as_ref()))
        .on_tray_icon_event(|plateau, evenement| {
            // Au relâchement, pas à l'appui : agir sous un clic que l'on n'a
            // pas fini de faire ouvrirait la fenêtre sous le doigt.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = evenement
            {
                let app = plateau.app_handle().clone();
                deleguer(&app.clone(), move || {
                    if let Err(erreur) = montrer_principale(&app) {
                        eprintln!("le plateau n'a pas pu ouvrir la fenêtre principale : {erreur}");
                    }
                });
            }
        });

    match Image::from_bytes(ICONE) {
        Ok(icone) => plateau = plateau.icon(icone),
        Err(erreur) => {
            eprintln!("l'icône du plateau ne se décode pas : {erreur}");
            if let Some(icone) = app.default_window_icon() {
                plateau = plateau.icon(icone.clone());
            }
        }
    }

    plateau.build(app)?;
    Ok(())
}

fn sur_menu(app: &AppHandle, element: &str) {
    match element {
        OUVRIR => {
            let app = app.clone();
            deleguer(&app.clone(), move || {
                if let Err(erreur) = montrer_principale(&app) {
                    eprintln!("le plateau n'a pas pu ouvrir la fenêtre principale : {erreur}");
                }
            });
        }
        EDITION => {
            let app = app.clone();
            deleguer(&app.clone(), move || {
                if let Err(erreur) = basculer_edition(&app) {
                    eprintln!("le plateau n'a pas pu basculer l'édition : {erreur}");
                }
            });
        }
        QUITTER => app.exit(0),
        _ => {}
    }
}

/// Passe la tâche au fil principal, le seul d'où l'on touche aux fenêtres.
fn deleguer<F: FnOnce() + Send + 'static>(app: &AppHandle, tache: F) {
    if let Err(erreur) = app.run_on_main_thread(tache) {
        eprintln!("le plateau n'atteint pas le fil principal : {erreur}");
    }
}
