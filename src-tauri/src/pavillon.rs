//! Les modèles des décorations du pavillon, lus dans l'archive du jeu.
//!
//! L'archive `Gw2.dat` est celle de la machine : rien n'en sort de
//! l'application, et rien n'est rangé à côté. On l'ouvre une fois — retrouver
//! le contenu de jeu et indexer les décorations prend quelques secondes —,
//! puis chaque modèle se lit à la demande de l'éditeur.
//!
//! Un modèle voyage vers le front en binaire (`ipc::Response`), pas en JSON :
//! un mur de l'académie compte quatorze mille sommets, et leurs flottants
//! écrits en texte pèseraient le triple. Ses textures suivent à part, une
//! demande chacune : plusieurs décorations partagent la même écorce, et le
//! front ne la demande qu'une fois.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use archive_gw2::decorations::{indexer, trouver_le_contenu};
use archive_gw2::modele::lire_modele;
use archive_gw2::texture::Texture;
use archive_gw2::Archive;
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

struct Bibliotheque {
    chemin: String,
    /// Taille et date du fichier à l'indexation : le lanceur met l'archive à
    /// jour en place, et une table lue avant pointerait à côté.
    empreinte: Empreinte,
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

type Empreinte = (u64, Option<SystemTime>);

/// Le plus grand côté d'une texture rendue : le niveau de détail en dessous.
/// Une décoration se regarde de loin dans l'éditeur, et une texture de 512
/// pixels de côté pèse déjà un mégaoctet une fois décodée.
const COTE_MAX_TEXTURE: u16 = 512;

fn empreinte(chemin: &str) -> Option<Empreinte> {
    let meta = std::fs::metadata(chemin).ok()?;
    Some((meta.len(), meta.modified().ok()))
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
        if ouverte.chemin == chemin && empreinte(&chemin) == Some(ouverte.empreinte) {
            return Ok(EtatArchive {
                chemin,
                paquet: ouverte.paquet,
                decorations: ouverte.modeles.len(),
            });
        }
    }

    let chemin_lu = chemin.clone();
    let bibliotheque = tauri::async_runtime::spawn_blocking(move || {
        let empreinte = empreinte(&chemin_lu).ok_or("l'archive est introuvable à ce chemin")?;
        let archive = Archive::ouvrir(&chemin_lu).map_err(|e| e.to_string())?;
        let contenu = trouver_le_contenu(&archive, indice).map_err(|e| e.to_string())?;
        let Some(&paquet) = contenu.first() else {
            return Err("le contenu de jeu est introuvable dans cette archive".to_string());
        };
        let modeles = indexer(&archive, &contenu).map_err(|e| e.to_string())?;
        Ok(Bibliotheque {
            chemin: chemin_lu,
            empreinte,
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

/// L'archive ouverte, si elle n'a pas changé depuis.
fn ouverte(etat: &State<'_, Pavillon>) -> Result<Arc<Bibliotheque>, String> {
    let ouverte = bibliotheque(etat)?.ok_or("aucune archive ouverte")?;
    if empreinte(&ouverte.chemin) != Some(ouverte.empreinte) {
        return Err("l'archive a changé depuis son ouverture : rouvrez-la".to_string());
    }
    Ok(ouverte)
}

/// Le modèle d'une décoration, en binaire petit-boutiste :
///
/// ```text
/// u32 nombre de maillages
/// pour chacun : u32 sommets, u32 index, u32 texture (0 : aucune),
///               f32 × 3 × sommets, f32 × 2 × sommets si texture, u32 × index
/// ```
///
/// Zéro maillage : la décoration n'a pas de modèle que l'on sache lire. La
/// texture est le fichier à demander à `texture_decoration`, et les
/// coordonnées qui la posent ne voyagent qu'avec elle.
#[tauri::command]
pub async fn modele_decoration(etat: State<'_, Pavillon>, id: u32) -> Result<Response, String> {
    let ouverte = ouverte(&etat)?;
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
            .map(|m| 12 + m.positions.len() * 4 + m.uv.len() * 4 + m.triangles.len() * 4)
            .sum();
        let mut sortie = Vec::with_capacity(4 + taille);
        sortie.extend((maillages.len() as u32).to_le_bytes());
        for maillage in &maillages {
            sortie.extend(((maillage.positions.len() / 3) as u32).to_le_bytes());
            sortie.extend((maillage.triangles.len() as u32).to_le_bytes());
            sortie.extend(maillage.texture.unwrap_or(0).to_le_bytes());
            for valeur in &maillage.positions {
                sortie.extend(valeur.to_le_bytes());
            }
            if maillage.texture.is_some() {
                for valeur in &maillage.uv {
                    sortie.extend(valeur.to_le_bytes());
                }
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

/// Une texture, décodée, en binaire petit-boutiste :
///
/// ```text
/// u32 largeur, u32 hauteur, u32 découpée (0 ou 1), u8 × 4 × largeur × hauteur
/// ```
///
/// Les pixels sont en RGBA, ligne du haut d'abord, au plus grand niveau de
/// détail qui tienne dans `COTE_MAX_TEXTURE`. Découpée : l'alpha de l'image
/// découpe sa forme, et le rendu doit en tenir compte.
#[tauri::command]
pub async fn texture_decoration(
    etat: State<'_, Pavillon>,
    fichier: u32,
) -> Result<Response, String> {
    let ouverte = ouverte(&etat)?;
    let octets = tauri::async_runtime::spawn_blocking(move || {
        let octets = ouverte.archive.lire(fichier).map_err(|e| e.to_string())?;
        let texture = Texture::lire(&octets).map_err(|e| format!("fichier {fichier} : {e}"))?;
        let image = texture
            .decoder(texture.niveau_au_plus(COTE_MAX_TEXTURE))
            .map_err(|e| format!("fichier {fichier} : {e}"))?;
        let mut sortie = Vec::with_capacity(12 + image.rgba.len());
        sortie.extend(image.largeur.to_le_bytes());
        sortie.extend(image.hauteur.to_le_bytes());
        sortie.extend(u32::from(image.decoupee).to_le_bytes());
        sortie.extend(image.rgba);
        Ok::<_, String>(sortie)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(octets))
}
