//! GW2RP Overlay — le binaire Tauri.
//!
//! Trois choses vivent ici et nulle part ailleurs : le lien Mumble du jeu,
//! l'état des fenêtres d'overlay (visibilité, mode d'édition) et le raccourci
//! global qui bascule l'édition. Le front lit, dessine et parle au hub ; il ne
//! décide ni de ce qu'une fenêtre laisse passer, ni de ce que le jeu écrit.

mod mumble;
mod overlays;
mod plateau;

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

use overlays::{Edition, FENETRE_PRINCIPALE};

/// Émis à toutes les fenêtres à chaque lecture du lien, avec `Option<Lien>`.
const EVENEMENT_MUMBLE: &str = "mumble";

/// Quatre lectures par seconde : assez pour suivre un personnage qui court,
/// sans réveiller quatre vues web pour rien.
const CADENCE_MUMBLE: Duration = Duration::from_millis(250);

/// Le raccourci d'édition. Une seule combinaison, la même partout : le menu
/// du plateau l'affiche, le front la nomme.
const RACCOURCI_EDITION: &str = "ctrl+shift+o";

#[tauri::command]
fn lire_edition(app: AppHandle) -> bool {
    app.state::<Edition>().active()
}

#[tauri::command]
fn regler_edition(app: AppHandle, active: bool) -> Result<(), String> {
    overlays::regler_edition(&app, active)
}

#[tauri::command]
fn basculer_edition(app: AppHandle) -> Result<(), String> {
    overlays::basculer_edition(&app)
}

#[tauri::command]
fn montrer_overlay(app: AppHandle, label: String) -> Result<(), String> {
    overlays::montrer(&app, &label)
}

#[tauri::command]
fn cacher_overlay(app: AppHandle, label: String) -> Result<(), String> {
    overlays::cacher(&app, &label)
}

#[tauri::command]
fn overlay_visible(app: AppHandle, label: String) -> Result<bool, String> {
    overlays::visible(&app, &label)
}

/// Une lecture du lien à la demande, pour une fenêtre qui s'ouvre et ne veut
/// pas attendre le prochain quart de seconde.
#[tauri::command]
fn lire_mumble() -> Option<mumble::Lien> {
    mumble::Lecteur::ouvrir().ok()?.lire()
}

/// Lit le lien à cadence fixe et l'envoie à toutes les fenêtres.
///
/// Un seul lecteur pour toute l'application : chaque fenêtre qui lirait la
/// mémoire partagée de son côté ferait autant de copies du bloc par seconde.
fn suivre_mumble(app: AppHandle) {
    std::thread::Builder::new()
        .name("mumble".into())
        .spawn(move || {
            let mut lecteur = match mumble::Lecteur::ouvrir() {
                Ok(lecteur) => lecteur,
                Err(erreur) => {
                    eprintln!("{erreur}");
                    return;
                }
            };
            loop {
                let lien = lecteur.lire();
                if let Err(erreur) = app.emit(EVENEMENT_MUMBLE, &lien) {
                    eprintln!("le lien Mumble n'a pas pu être émis : {erreur}");
                }
                std::thread::sleep(CADENCE_MUMBLE);
            }
        })
        .expect("le fil de lecture du lien Mumble démarre");
}

pub fn run() {
    tauri::Builder::default()
        // `http` exécute les appels au hub et à l'API du jeu depuis Rust : pas
        // de CORS, et l'en-tête d'autorisation est posé par l'application.
        .plugin(tauri_plugin_http::init())
        // `store` range le jeton de session, l'adresse du hub et les réglages.
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(Edition::default())
        .invoke_handler(tauri::generate_handler![
            lire_edition,
            regler_edition,
            basculer_edition,
            montrer_overlay,
            cacher_overlay,
            overlay_visible,
            lire_mumble,
        ])
        .on_window_event(|fenetre, evenement| {
            // Fermer la fenêtre principale la range au lieu de la détruire :
            // l'application continue derrière son icône, et les overlays
            // restent à l'écran. Quitter est un choix du plateau.
            if fenetre.label() == FENETRE_PRINCIPALE {
                if let WindowEvent::CloseRequested { api, .. } = evenement {
                    api.prevent_close();
                    let _ = fenetre.hide();
                }
            }
        })
        .setup(|app| {
            if let Err(erreur) = plateau::installer(app.handle()) {
                eprintln!("l'icône du plateau n'est pas disponible : {erreur}");
            }

            // Enregistré ici et non sur le constructeur, et sans faire tomber
            // le lancement : le greffon relit sa configuration au démarrage,
            // et une configuration qu'il refuse — une clé publique vide, une
            // adresse mal formée — coûterait l'application entière. Perdre la
            // vérification des mises à jour ne vaut pas de la refuser.
            if let Err(erreur) = app
                .handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
            {
                eprintln!("la mise à jour automatique n'est pas disponible : {erreur}");
            }

            // Le raccourci s'enregistre depuis Rust : il doit tomber pendant que
            // le jeu a le clavier et qu'aucune fenêtre de l'application n'a le
            // focus. Un système qui le refuse ne fait pas tomber le lancement :
            // le plateau et la fenêtre principale basculent l'édition aussi.
            let raccourci: Shortcut = RACCOURCI_EDITION
                .parse()
                .expect("le raccourci d'édition est bien formé");
            let greffon = tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([raccourci])
                .expect("le raccourci d'édition s'enregistre")
                .with_handler(move |app, appuye, evenement| {
                    // Les deux fronts sont rapportés ; on agit sur l'appui.
                    if evenement.state != ShortcutState::Pressed || appuye != &raccourci {
                        return;
                    }
                    if let Err(erreur) = overlays::basculer_edition(app) {
                        eprintln!("le raccourci n'a pas pu basculer l'édition : {erreur}");
                    }
                })
                .build();
            if let Err(erreur) = app.handle().plugin(greffon) {
                eprintln!("le raccourci global n'est pas disponible : {erreur}");
            }

            // Hors édition dès le départ : une fenêtre d'overlay ne prend
            // jamais le curseur sans qu'on l'ait demandé.
            overlays::regler_edition(app.handle(), false)?;

            suivre_mumble(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("l'application démarre");
}
