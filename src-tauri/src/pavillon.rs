//! Les modèles des décorations du pavillon, lus dans l'archive du jeu.
//!
//! L'archive `Gw2.dat` est celle de la machine : rien n'en sort de
//! l'application, et rien n'est rangé à côté. On l'ouvre une fois — retrouver
//! le contenu de jeu et indexer les décorations prend quelques secondes —,
//! puis chaque modèle se lit à la demande de l'éditeur.
//!
//! Un modèle voyage vers le front en binaire (`ipc::Response`), pas en JSON :
//! un mur de l'académie compte quatorze mille sommets, et leurs flottants
//! écrits en texte pèseraient le triple.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use archive_gw2::decorations::{indexer, trouver_le_contenu};
use archive_gw2::modele::lire_modele;
use archive_gw2::Archive;
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

struct Bibliotheque {
    chemin: String,
    paquet: u32,
    archive: Arc<Archive>,
    /// Identifiant de décoration → fichier de son modèle.
    modeles: HashMap<u32, u32>,
}

#[derive(Default)]
pub struct Pavillon(Mutex<Option<Arc<Bibliotheque>>>);

/// Ce que l'éditeur sait de l'archive ouverte.
#[derive(Serialize)]
pub struct EtatArchive {
    pub chemin: String,
    /// Le premier fichier du contenu de jeu, que l'éditeur range pour aller
    /// droit à lui la fois suivante.
    pub paquet: u32,
    pub decorations: usize,
}

fn bibliotheque(etat: &State<'_, Pavillon>) -> Result<Option<Arc<Bibliotheque>>, String> {
    Ok(etat
        .0
        .lock()
        .map_err(|_| "l'archive est inaccessible")?
        .clone())
}

/// Ouvre l'archive et indexe les décorations. `indice` est le premier fichier
/// du contenu la dernière fois : s'il l'est encore, on ne le cherche pas.
#[tauri::command]
pub async fn ouvrir_archive(
    etat: State<'_, Pavillon>,
    chemin: String,
    indice: Option<u32>,
) -> Result<EtatArchive, String> {
    if let Some(ouverte) = bibliotheque(&etat)? {
        if ouverte.chemin == chemin {
            return Ok(EtatArchive {
                chemin,
                paquet: ouverte.paquet,
                decorations: ouverte.modeles.len(),
            });
        }
    }

    let chemin_lu = chemin.clone();
    let bibliotheque = tauri::async_runtime::spawn_blocking(move || {
        let archive = Archive::ouvrir(&chemin_lu).map_err(|e| e.to_string())?;
        let contenu = trouver_le_contenu(&archive, indice).map_err(|e| e.to_string())?;
        let Some(&paquet) = contenu.first() else {
            return Err("le contenu de jeu est introuvable dans cette archive".to_string());
        };
        let modeles = indexer(&archive, &contenu).map_err(|e| e.to_string())?;
        Ok(Bibliotheque {
            chemin: chemin_lu,
            paquet,
            archive: Arc::new(archive),
            modeles,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    let reponse = EtatArchive {
        chemin,
        paquet: bibliotheque.paquet,
        decorations: bibliotheque.modeles.len(),
    };
    *etat.0.lock().map_err(|_| "l'archive est inaccessible")? = Some(Arc::new(bibliotheque));
    Ok(reponse)
}

/// Le modèle d'une décoration, en binaire petit-boutiste :
///
/// ```text
/// u32 nombre de maillages
/// pour chacun : u32 sommets, u32 index, f32 × 3 × sommets, u32 × index
/// ```
///
/// Zéro maillage : la décoration n'a pas de modèle que l'on sache lire.
#[tauri::command]
pub async fn modele_decoration(etat: State<'_, Pavillon>, id: u32) -> Result<Response, String> {
    let ouverte = bibliotheque(&etat)?.ok_or("aucune archive ouverte")?;
    let octets = tauri::async_runtime::spawn_blocking(move || {
        let maillages = match ouverte.modeles.get(&id) {
            Some(&fichier) => {
                let octets = ouverte.archive.lire(fichier).map_err(|e| e.to_string())?;
                lire_modele(&octets)
                    .map_err(|e| e.to_string())?
                    .map(|m| m.maillages)
                    .unwrap_or_default()
            }
            None => Vec::new(),
        };

        let taille: usize = maillages
            .iter()
            .map(|m| 8 + m.positions.len() * 4 + m.triangles.len() * 4)
            .sum();
        let mut sortie = Vec::with_capacity(4 + taille);
        sortie.extend((maillages.len() as u32).to_le_bytes());
        for maillage in &maillages {
            sortie.extend(((maillage.positions.len() / 3) as u32).to_le_bytes());
            sortie.extend((maillage.triangles.len() as u32).to_le_bytes());
            for valeur in &maillage.positions {
                sortie.extend(valeur.to_le_bytes());
            }
            for index in &maillage.triangles {
                sortie.extend(index.to_le_bytes());
            }
        }
        Ok::<_, String>(sortie)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(octets))
}
