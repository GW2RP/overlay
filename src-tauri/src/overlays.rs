//! Les fenêtres d'overlay et leur mode d'édition.
//!
//! Chaque élément d'overlay est une fenêtre déclarée dans `tauri.conf.json`,
//! cachée au départ : transparente, sans bordure, toujours au-dessus, absente
//! de la barre des tâches. Rust la montre et la cache ; le front ne fait que
//! dessiner dedans.
//!
//! **Le mode d'édition est tenu ici**, pas dans une fenêtre : il concerne
//! toutes les fenêtres à la fois, il se bascule d'un raccourci global qui
//! tombe même quand aucune fenêtre n'a le clavier, et une fenêtre encore
//! cachée doit le connaître quand elle s'ouvre. Hors édition, une fenêtre
//! d'overlay **laisse passer le curseur** : un clic dessus atteint le jeu en
//! dessous, sinon un panneau posé sur l'écran volerait au jeu chaque clic dans
//! sa zone. En édition, elle le reprend : on la déplace, on la redimensionne,
//! on la ferme.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Le préfixe des étiquettes de fenêtre d'overlay, dans `tauri.conf.json`.
pub const PREFIXE_OVERLAY: &str = "overlay-";
pub const FENETRE_PRINCIPALE: &str = "principale";

/// Émis à toutes les fenêtres quand le mode d'édition change, avec un booléen.
pub const EVENEMENT_EDITION: &str = "edition";
/// Émis à toutes les fenêtres quand un overlay est montré ou caché, avec son
/// étiquette et sa visibilité.
pub const EVENEMENT_VISIBILITE: &str = "overlay-visibilite";

#[derive(Default)]
pub struct Edition(AtomicBool);

impl Edition {
    pub fn active(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, serde::Serialize)]
pub struct Visibilite {
    pub label: String,
    pub visible: bool,
}

pub fn est_overlay(label: &str) -> bool {
    label.starts_with(PREFIXE_OVERLAY)
}

pub fn fenetre(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if !est_overlay(label) {
        return Err(format!("« {label} » n'est pas une fenêtre d'overlay"));
    }
    app.get_webview_window(label)
        .ok_or_else(|| format!("la fenêtre « {label} » n'est pas déclarée"))
}

/// Applique le mode courant à une fenêtre : le curseur la traverse hors
/// édition, elle le reprend en édition.
fn appliquer_curseur(fenetre: &WebviewWindow, edition: bool) -> Result<(), String> {
    fenetre
        .set_ignore_cursor_events(!edition)
        .map_err(|erreur| erreur.to_string())
}

pub fn regler_edition(app: &AppHandle, active: bool) -> Result<(), String> {
    app.state::<Edition>().0.store(active, Ordering::SeqCst);

    for (label, fenetre) in app.webview_windows() {
        if !est_overlay(&label) {
            continue;
        }
        appliquer_curseur(&fenetre, active)?;
        // En édition, une fenêtre ouverte doit pouvoir prendre le clavier pour
        // ses flèches ; hors édition, elle ne l'a jamais.
        if active {
            let _ = fenetre.set_focus();
        }
    }

    app.emit(EVENEMENT_EDITION, active)
        .map_err(|erreur| erreur.to_string())
}

pub fn basculer_edition(app: &AppHandle) -> Result<(), String> {
    let active = app.state::<Edition>().active();
    regler_edition(app, !active)
}

fn annoncer_visibilite(app: &AppHandle, label: &str, visible: bool) -> Result<(), String> {
    app.emit(
        EVENEMENT_VISIBILITE,
        Visibilite {
            label: label.to_string(),
            visible,
        },
    )
    .map_err(|erreur| erreur.to_string())
}

pub fn montrer(app: &AppHandle, label: &str) -> Result<(), String> {
    let fenetre = fenetre(app, label)?;
    // Le mode s'applique avant de montrer : une fenêtre qui apparaîtrait un
    // instant en prenant le curseur volerait le clic qui vient de l'ouvrir.
    appliquer_curseur(&fenetre, app.state::<Edition>().active())?;
    fenetre.show().map_err(|erreur| erreur.to_string())?;
    annoncer_visibilite(app, label, true)
}

pub fn cacher(app: &AppHandle, label: &str) -> Result<(), String> {
    fenetre(app, label)?
        .hide()
        .map_err(|erreur| erreur.to_string())?;
    annoncer_visibilite(app, label, false)
}

pub fn visible(app: &AppHandle, label: &str) -> Result<bool, String> {
    fenetre(app, label)?
        .is_visible()
        .map_err(|erreur| erreur.to_string())
}

/// Ramène la fenêtre principale, d'où qu'elle ait été rangée : cachée par sa
/// croix, ou réduite derrière le jeu.
pub fn montrer_principale(app: &AppHandle) -> Result<(), String> {
    let principale = app
        .get_webview_window(FENETRE_PRINCIPALE)
        .ok_or_else(|| "la fenêtre principale n'est pas déclarée".to_string())?;
    principale.show().map_err(|erreur| erreur.to_string())?;
    let _ = principale.unminimize();
    principale.set_focus().map_err(|erreur| erreur.to_string())
}
