//! Les fenêtres d'overlay : leur visibilité, leur mode d'édition, leur cadenas.
//!
//! Chaque élément d'overlay est une fenêtre déclarée dans `tauri.conf.json`,
//! cachée au départ : transparente, sans bordure, toujours au-dessus, absente
//! de la barre des tâches. Rust la montre et la cache ; le front ne fait que
//! dessiner dedans.
//!
//! **Ce qu'une fenêtre fait du curseur est tenu ici**, pas dans une fenêtre.
//! Trois régimes, dans cet ordre de priorité :
//!
//! 1. **L'édition** concerne toutes les fenêtres à la fois : chacune prend le
//!    curseur pour se déplacer, se redimensionner, se fermer. Elle se bascule
//!    d'un raccourci global qui tombe même quand aucune fenêtre n'a le clavier.
//! 2. **Le cadenas** est propre à chaque fenêtre. Fermé, la fenêtre est une
//!    image : le curseur la traverse et un clic dessus atteint le jeu — sauf
//!    sur la **zone de déverrouillage** qu'elle a déclarée, son bouton de
//!    cadenas. Une fenêtre qui ignore le curseur ne le voit plus jamais, donc
//!    c'est Rust qui suit la position du curseur et ne lui rend la souris que
//!    le temps qu'il survole cette zone. Ouvert, la fenêtre prend le curseur :
//!    on y choisit un lieu, on y tape une recherche.
//! 3. Sans cadenas déclaré, la fenêtre prend le curseur : c'est le cas de la
//!    fiche d'un lieu, qui n'existe que pour être lue et fermée.
//!
//! La météo et le personnage naissent fermés sans zone : rien à y cliquer, et
//! un panneau posé sur l'écran volerait sinon au jeu chaque clic dans sa zone.
//! « À proximité » naît ouvert. Le mode s'applique **avant** de montrer une
//! fenêtre : une fenêtre qui apparaîtrait un instant en prenant le curseur
//! volerait le clic qui vient de l'ouvrir.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

/// Le préfixe des étiquettes de fenêtre d'overlay, dans `tauri.conf.json`.
pub const PREFIXE_OVERLAY: &str = "overlay-";
pub const FENETRE_PRINCIPALE: &str = "principale";
/// L'élément « À proximité », à côté duquel la fiche s'ouvre.
pub const FENETRE_PROXIMITE: &str = "overlay-proximite";
/// La fiche d'un lieu : une fenêtre à part, ouverte par un lieu de la liste.
pub const FENETRE_FICHE: &str = "overlay-fiche";

/// Les fenêtres qui naissent cadenassées, sans zone : rien à y cliquer.
const VERROUILLEES_AU_DEPART: [&str; 2] = ["overlay-meteo", "overlay-personnage"];

/// Émis à toutes les fenêtres quand le mode d'édition change, avec un booléen.
pub const EVENEMENT_EDITION: &str = "edition";
/// Émis à toutes les fenêtres quand un overlay est montré ou caché.
pub const EVENEMENT_VISIBILITE: &str = "overlay-visibilite";
/// Émis à toutes les fenêtres quand le cadenas d'une fenêtre change.
pub const EVENEMENT_VERROU: &str = "overlay-verrou";
/// Émis à la fiche quand un lieu lui est demandé, avec son slug.
pub const EVENEMENT_FICHE: &str = "fiche";

/// La cadence du suivi du curseur quand un cadenas a une zone à surveiller,
/// et quand aucun n'en a : il n'y a alors rien à décider.
const SUIVI_ACTIF: Duration = Duration::from_millis(40);
const SUIVI_AU_REPOS: Duration = Duration::from_millis(250);
/// L'espace entre l'élément et la fiche qu'il ouvre, en pixels physiques.
const ECART_FICHE: i32 = 8;

#[derive(Default)]
pub struct Edition(AtomicBool);

impl Edition {
    pub fn active(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Où est le bouton de cadenas, en pixels CSS depuis le coin haut gauche de la
/// fenêtre — ce que `getBoundingClientRect` donne, que Rust ramène à l'écran.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Zone {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy)]
struct Verrou {
    /// `None` : la fenêtre n'a rien qui la déverrouille depuis elle-même.
    zone: Option<Zone>,
    /// Ce que la fenêtre fait du curseur en ce moment, pour ne le changer que
    /// quand ça change.
    ignore: bool,
}

/// Les fenêtres cadenassées, par étiquette. Absente : la fenêtre prend le curseur.
#[derive(Default)]
pub struct Verrous(Mutex<HashMap<String, Verrou>>);

#[derive(Default)]
pub struct FicheCourante(Mutex<Option<String>>);

#[derive(Clone, Serialize)]
pub struct Visibilite {
    pub label: String,
    pub visible: bool,
}

#[derive(Clone, Serialize)]
pub struct EtatVerrou {
    pub label: String,
    pub verrouille: bool,
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

/// Pose les cadenas de départ. Appelé une fois, avant d'appliquer quoi que ce
/// soit aux fenêtres.
pub fn initialiser(app: &AppHandle) {
    if let Ok(mut verrous) = app.state::<Verrous>().0.lock() {
        for label in VERROUILLEES_AU_DEPART {
            verrous.insert(
                label.to_string(),
                Verrou {
                    zone: None,
                    ignore: true,
                },
            );
        }
    }
}

fn poser_curseur(fenetre: &WebviewWindow, ignore: bool) -> Result<(), String> {
    fenetre
        .set_ignore_cursor_events(ignore)
        .map_err(|erreur| erreur.to_string())
}

/// Ce que cette fenêtre doit faire du curseur, selon les trois régimes.
fn appliquer(app: &AppHandle, label: &str) -> Result<(), String> {
    let fenetre = fenetre(app, label)?;
    if app.state::<Edition>().active() {
        return poser_curseur(&fenetre, false);
    }
    let state = app.state::<Verrous>();
    let mut verrous = state
        .0
        .lock()
        .map_err(|_| "les cadenas sont inaccessibles")?;
    match verrous.get_mut(label) {
        Some(verrou) => {
            poser_curseur(&fenetre, true)?;
            verrou.ignore = true;
            Ok(())
        }
        None => poser_curseur(&fenetre, false),
    }
}

fn appliquer_a_toutes(app: &AppHandle) -> Result<(), String> {
    for label in app.webview_windows().keys() {
        if est_overlay(label) {
            appliquer(app, label)?;
        }
    }
    Ok(())
}

pub fn regler_edition(app: &AppHandle, active: bool) -> Result<(), String> {
    app.state::<Edition>().0.store(active, Ordering::SeqCst);
    appliquer_a_toutes(app)?;
    if active {
        // En édition, une fenêtre ouverte doit pouvoir prendre le clavier pour
        // ses flèches ; hors édition, elle ne l'a jamais.
        for (label, fenetre) in app.webview_windows() {
            if est_overlay(&label) {
                let _ = fenetre.set_focus();
            }
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

fn annoncer_verrou(app: &AppHandle, label: &str, verrouille: bool) -> Result<(), String> {
    app.emit(
        EVENEMENT_VERROU,
        EtatVerrou {
            label: label.to_string(),
            verrouille,
        },
    )
    .map_err(|erreur| erreur.to_string())
}

pub fn montrer(app: &AppHandle, label: &str) -> Result<(), String> {
    // Le mode s'applique avant de montrer : une fenêtre qui apparaîtrait un
    // instant en prenant le curseur volerait le clic qui vient de l'ouvrir.
    appliquer(app, label)?;
    fenetre(app, label)?
        .show()
        .map_err(|erreur| erreur.to_string())?;
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

/// Ferme le cadenas d'une fenêtre, ou déplace sa zone si elle l'est déjà : le
/// bouton se redéclare chaque fois que la fenêtre change de taille.
pub fn verrouiller(app: &AppHandle, label: &str, zone: Option<Zone>) -> Result<(), String> {
    fenetre(app, label)?;
    let deja = {
        let state = app.state::<Verrous>();
        let mut verrous = state
            .0
            .lock()
            .map_err(|_| "les cadenas sont inaccessibles")?;
        let deja = verrous.contains_key(label);
        let ignore = verrous
            .get(label)
            .map(|verrou| verrou.ignore)
            .unwrap_or(false);
        verrous.insert(label.to_string(), Verrou { zone, ignore });
        deja
    };
    if !deja {
        appliquer(app, label)?;
        annoncer_verrou(app, label, true)?;
    }
    Ok(())
}

pub fn deverrouiller(app: &AppHandle, label: &str) -> Result<(), String> {
    fenetre(app, label)?;
    let etait = {
        let state = app.state::<Verrous>();
        let mut verrous = state
            .0
            .lock()
            .map_err(|_| "les cadenas sont inaccessibles")?;
        verrous.remove(label).is_some()
    };
    if etait {
        appliquer(app, label)?;
        annoncer_verrou(app, label, false)?;
    }
    Ok(())
}

pub fn verrouille(app: &AppHandle, label: &str) -> Result<bool, String> {
    let state = app.state::<Verrous>();
    let verrous = state
        .0
        .lock()
        .map_err(|_| "les cadenas sont inaccessibles")?;
    Ok(verrous.contains_key(label))
}

/// Le curseur est-il sur la zone de déverrouillage de cette fenêtre ?
fn curseur_sur_zone(
    fenetre: &WebviewWindow,
    zone: Zone,
    curseur: PhysicalPosition<f64>,
) -> Result<bool, String> {
    let position = fenetre
        .outer_position()
        .map_err(|erreur| erreur.to_string())?;
    let echelle = fenetre
        .scale_factor()
        .map_err(|erreur| erreur.to_string())?;
    let gauche = f64::from(position.x) + zone.x * echelle;
    let haut = f64::from(position.y) + zone.y * echelle;
    let droite = gauche + zone.width * echelle;
    let bas = haut + zone.height * echelle;
    Ok(curseur.x >= gauche && curseur.x < droite && curseur.y >= haut && curseur.y < bas)
}

/// Suit le curseur pour les fenêtres cadenassées qui ont une zone, et ne leur
/// rend la souris que le temps qu'il la survole.
///
/// Un fil à part, qui dort quand il n'y a rien à surveiller : en édition, ou
/// quand aucune fenêtre cadenassée n'a de zone, aucune décision à prendre.
pub fn suivre_les_cadenas(app: AppHandle) {
    std::thread::Builder::new()
        .name("cadenas".into())
        .spawn(move || loop {
            if app.state::<Edition>().active() {
                std::thread::sleep(SUIVI_AU_REPOS);
                continue;
            }

            let a_surveiller: Vec<(String, Zone, bool)> = match app.state::<Verrous>().0.lock() {
                Ok(verrous) => verrous
                    .iter()
                    .filter_map(|(label, verrou)| {
                        verrou.zone.map(|zone| (label.clone(), zone, verrou.ignore))
                    })
                    .collect(),
                Err(_) => Vec::new(),
            };

            if a_surveiller.is_empty() {
                std::thread::sleep(SUIVI_AU_REPOS);
                continue;
            }

            // Pas de curseur — une session distante, un écran qui s'en va :
            // rien à décider, on réessaie au prochain tour.
            let Ok(curseur) = app.cursor_position() else {
                std::thread::sleep(SUIVI_ACTIF);
                continue;
            };

            for (label, zone, ignorait) in a_surveiller {
                let Ok(fenetre) = fenetre(&app, &label) else {
                    continue;
                };
                if !fenetre.is_visible().unwrap_or(false) {
                    continue;
                }
                let Ok(dessus) = curseur_sur_zone(&fenetre, zone, curseur) else {
                    continue;
                };
                let ignore = !dessus;
                if ignore == ignorait {
                    continue;
                }
                // Décidé et appliqué sous le verrou, contre l'entrée telle
                // qu'elle est maintenant : un déverrouillage passé entre-temps
                // a retiré l'entrée et rendu la souris, et appliquer le
                // verdict d'avant laisserait une fenêtre que plus personne ne
                // surveille ignorer chaque clic pour de bon.
                let state = app.state::<Verrous>();
                let Ok(mut verrous) = state.0.lock() else {
                    continue;
                };
                let Some(courant) = verrous.get_mut(&label) else {
                    continue;
                };
                if courant.ignore == ignore {
                    continue;
                }
                if poser_curseur(&fenetre, ignore).is_ok() {
                    courant.ignore = ignore;
                }
            }

            std::thread::sleep(SUIVI_ACTIF);
        })
        .expect("le fil de suivi des cadenas démarre");
}

/// Ouvre la fiche d'un lieu : la fenêtre se pose à droite de « À proximité »
/// si celle-ci est à l'écran, prend le curseur, et reçoit le slug.
///
/// Une seule fiche à la fois : choisir un autre lieu remplace le contenu.
pub fn ouvrir_fiche(app: &AppHandle, slug: &str) -> Result<(), String> {
    if let Ok(mut courante) = app.state::<FicheCourante>().0.lock() {
        *courante = Some(slug.to_string());
    }

    let fiche = fenetre(app, FENETRE_FICHE)?;
    let deja_visible = fiche.is_visible().unwrap_or(false);

    // Posée une fois, à l'ouverture : ensuite elle garde la place où on l'a
    // mise, et le cadre rangé dans les réglages la reprend au démarrage.
    if !deja_visible {
        if let Ok(proximite) = fenetre(app, FENETRE_PROXIMITE) {
            if proximite.is_visible().unwrap_or(false) {
                if let (Ok(position), Ok(taille)) =
                    (proximite.outer_position(), proximite.outer_size())
                {
                    let _ = fiche.set_position(PhysicalPosition::new(
                        position.x + taille.width as i32 + ECART_FICHE,
                        position.y,
                    ));
                }
            }
        }
    }

    montrer(app, FENETRE_FICHE)?;
    let _ = fiche.set_focus();
    app.emit_to(FENETRE_FICHE, EVENEMENT_FICHE, slug)
        .map_err(|erreur| erreur.to_string())
}

pub fn fiche_courante(app: &AppHandle) -> Option<String> {
    app.state::<FicheCourante>()
        .0
        .lock()
        .ok()
        .and_then(|courante| courante.clone())
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
