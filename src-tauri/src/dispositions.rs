//! Les dispositions de pavillon rangées sur la machine : le dossier où le jeu
//! les exporte, choisi une fois, et les fichiers XML qu'il contient.
//!
//! Tout passe par ici plutôt que par un greffon de fichiers ouvert au front :
//! on ne lit et n'écrit que des `.xml`, et seulement **dans** le dossier
//! choisi — un nom de fichier, jamais un chemin. Le dossier lui-même est tenu
//! ici (`DossierDispositions`) : il n'y entre que par la boîte de choix du
//! système ou par défaut, et se range dans un fichier à Rust, hors du magasin
//! de réglages que le front écrit. Le front ne nomme donc aucun dossier. La
//! seule écriture hors de celui-ci est l'export, dont le chemin sort de la
//! boîte d'enregistrement du système, ouverte par Rust.
//!
//! Ces commandes ne répondent qu'à l'éditeur de pavillon : une fenêtre
//! d'overlay n'a rien à faire des fichiers de la machine.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::FENETRE_PAVILLON;

/// Une disposition fait quelques dizaines de kilo-octets ; au-delà de ce
/// plafond, ce n'en est pas une, et on ne la charge pas en mémoire.
const TAILLE_MAX: u64 = 16 * 1024 * 1024;

/// Où le dossier choisi se range, dans les données locales de l'application :
/// un fichier à Rust, que le greffon `store` — rangé dans les données
/// itinérantes — ne nomme pas.
const FICHIER_DOSSIER: &str = "dossier-dispositions.txt";

/// Les noms que Windows réserve à ses périphériques : `NUL.xml` s'ouvre sans
/// erreur et n'écrit rien.
const NOMS_RESERVES: [&str; 4] = ["con", "prn", "aux", "nul"];

/// Le dossier des dispositions, tenu par Rust : `None` tant qu'il n'est ni
/// choisi ni retrouvé.
#[derive(Default)]
pub struct DossierDispositions(Mutex<Option<PathBuf>>);

/// Ce que la liste montre d'un fichier du dossier.
#[derive(Serialize)]
pub struct Fichier {
    pub nom: String,
    /// `mapName` de l'en-tête, s'il se lit.
    pub carte: Option<String>,
    pub decorations: Option<usize>,
    /// Dernière modification, en millisecondes depuis 1970.
    pub modifie: Option<u64>,
}

fn depuis_le_pavillon(fenetre: &WebviewWindow) -> Result<(), String> {
    if fenetre.label() == FENETRE_PAVILLON {
        Ok(())
    } else {
        Err("seul l'éditeur de pavillon lit les dispositions".to_string())
    }
}

fn dossier_courant(etat: &State<'_, DossierDispositions>) -> Result<Option<PathBuf>, String> {
    Ok(etat
        .0
        .lock()
        .map_err(|_| "le dossier des dispositions est inaccessible")?
        .clone())
}

fn adopter(etat: &State<'_, DossierDispositions>, dossier: PathBuf) -> Result<(), String> {
    *etat
        .0
        .lock()
        .map_err(|_| "le dossier des dispositions est inaccessible")? = Some(dossier);
    Ok(())
}

/// Le dossier choisi, s'il existe encore : un disque débranché ne se lit pas.
fn dossier_existant(etat: &State<'_, DossierDispositions>) -> Result<PathBuf, String> {
    let dossier = dossier_courant(etat)?.ok_or("aucun dossier de dispositions choisi")?;
    if dossier.is_dir() {
        Ok(dossier)
    } else {
        Err("ce dossier est introuvable".to_string())
    }
}

fn fichier_du_dossier(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join(FICHIER_DOSSIER))
}

fn texte(dossier: &Path) -> String {
    dossier.to_string_lossy().into_owned()
}

/// Un nom de fichier, pas un chemin : rien qui sorte du dossier, rien que
/// Windows refuse, et l'extension `.xml`.
fn nom_valide(nom: &str) -> Result<(), String> {
    let interdit = |c: char| c.is_control() || "<>:\"/\\|?*".contains(c);
    let minuscules = nom.to_lowercase();
    let base = minuscules.strip_suffix(".xml").unwrap_or_default();
    if base.trim().is_empty()
        || nom.len() > 200
        || nom.chars().any(interdit)
        || nom.starts_with('.')
        || nom.ends_with(' ')
        || reserve(&minuscules)
    {
        return Err("ce nom de fichier n'est pas valide".to_string());
    }
    Ok(())
}

/// `NUL.xml`, `com1.xml`, et même `con.ancien.xml` : Windows juge sur ce qui
/// précède le premier point.
fn reserve(minuscules: &str) -> bool {
    let tete = minuscules.split('.').next().unwrap_or_default().trim_end();
    NOMS_RESERVES.contains(&tete)
        || ["com", "lpt"].iter().any(|p| {
            tete.strip_prefix(p)
                .is_some_and(|n| n.len() == 1 && n.chars().all(|c| c.is_ascii_digit()))
        })
}

fn est_xml(chemin: &Path) -> bool {
    chemin
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("xml"))
}

/// L'attribut `mapName` de l'en-tête, sans lire le XML entier : la liste en
/// demande un par fichier.
fn nom_de_carte(texte: &str) -> Option<String> {
    let entete = &texte[..texte.find("<prop").unwrap_or(texte.len())];
    let debut = entete.find("mapName=\"")? + "mapName=\"".len();
    let fin = entete[debut..].find('"')? + debut;
    let brut = &entete[debut..fin];
    Some(
        brut.replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&"),
    )
}

/// Le dossier des dispositions : celui qu'on a choisi la dernière fois, à
/// défaut celui où le jeu les range quand on ne lui dit rien,
/// `Documents\Guild Wars 2\Homesteads`. Les Documents peuvent vivre
/// ailleurs — sous OneDrive, sur un autre disque — et le système le sait : on
/// le lui demande. `None` si ni l'un ni l'autre n'existe.
#[tauri::command]
pub fn dossier_dispositions(
    app: AppHandle,
    fenetre: WebviewWindow,
    etat: State<'_, DossierDispositions>,
) -> Result<Option<String>, String> {
    depuis_le_pavillon(&fenetre)?;
    if let Some(dossier) = dossier_courant(&etat)? {
        return Ok(Some(texte(&dossier)));
    }
    let range = fichier_du_dossier(&app)
        .and_then(|f| fs::read_to_string(f).ok())
        .map(|t| PathBuf::from(t.trim()))
        .filter(|d| d.is_dir());
    let par_defaut = || {
        let dossier = app
            .path()
            .document_dir()
            .ok()?
            .join("Guild Wars 2")
            .join("Homesteads");
        dossier.is_dir().then_some(dossier)
    };
    let Some(dossier) = range.or_else(par_defaut) else {
        return Ok(None);
    };
    adopter(&etat, dossier.clone())?;
    Ok(Some(texte(&dossier)))
}

/// La boîte de choix de dossier du système, ouverte sur le dossier courant.
/// Le dossier choisi devient celui des dispositions, et se range pour la
/// fois suivante. `None` si on la referme sans choisir.
#[tauri::command]
pub async fn choisir_dossier(
    app: AppHandle,
    fenetre: WebviewWindow,
    etat: State<'_, DossierDispositions>,
) -> Result<Option<String>, String> {
    depuis_le_pavillon(&fenetre)?;
    let depart = dossier_courant(&etat)?.filter(|d| d.is_dir());
    let choix = tauri::async_runtime::spawn_blocking(move || {
        let mut boite = fenetre.dialog().file().set_parent(&fenetre);
        if let Some(depart) = depart {
            boite = boite.set_directory(depart);
        }
        boite.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(choix) = choix else {
        return Ok(None);
    };
    let dossier = choix.into_path().map_err(|e| e.to_string())?;
    adopter(&etat, dossier.clone())?;
    // Le dossier vaut pour cette session même s'il ne se range pas.
    if let Some(fichier) = fichier_du_dossier(&app) {
        let rangement = fichier
            .parent()
            .map(fs::create_dir_all)
            .transpose()
            .and_then(|_| fs::write(&fichier, texte(&dossier)));
        if let Err(erreur) = rangement {
            eprintln!("le dossier des dispositions ne se range pas : {erreur}");
        }
    }
    Ok(Some(texte(&dossier)))
}

/// Les dispositions du dossier, sans descendre dans ses sous-dossiers.
#[tauri::command]
pub async fn lister_dispositions(
    fenetre: WebviewWindow,
    etat: State<'_, DossierDispositions>,
) -> Result<Vec<Fichier>, String> {
    depuis_le_pavillon(&fenetre)?;
    let dossier = dossier_existant(&etat)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entrees = fs::read_dir(&dossier).map_err(|e| e.to_string())?;
        let mut fichiers = Vec::new();
        for entree in entrees.flatten() {
            let chemin = entree.path();
            let Ok(meta) = entree.metadata() else {
                continue;
            };
            if !meta.is_file() || !est_xml(&chemin) {
                continue;
            }
            // Un fichier qu'on ne pourrait pas rouvrir par son nom n'est pas
            // listé.
            let Some(nom) = chemin
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|n| nom_valide(n).is_ok())
            else {
                continue;
            };
            let texte = (meta.len() <= TAILLE_MAX)
                .then(|| fs::read_to_string(&chemin).ok())
                .flatten();
            fichiers.push(Fichier {
                nom: nom.to_string(),
                carte: texte.as_deref().and_then(nom_de_carte),
                decorations: texte.as_deref().map(|t| t.matches("<prop").count()),
                modifie: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
            });
        }
        Ok(fichiers)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Le texte d'une disposition du dossier.
#[tauri::command]
pub async fn lire_disposition(
    fenetre: WebviewWindow,
    etat: State<'_, DossierDispositions>,
    nom: String,
) -> Result<String, String> {
    depuis_le_pavillon(&fenetre)?;
    nom_valide(&nom)?;
    let chemin = dossier_existant(&etat)?.join(&nom);
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&chemin).map_err(|_| "ce fichier est introuvable".to_string())?;
        if meta.len() > TAILLE_MAX {
            return Err("ce fichier est trop lourd pour une disposition".to_string());
        }
        fs::read_to_string(&chemin).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Écrit une disposition dans le dossier. Sans `remplacer`, un fichier du
/// même nom fait refuser l'écriture : un nouveau fichier n'en écrase jamais
/// un autre. Avec, le texte passe par un fichier voisin renommé par-dessus
/// l'ancien : une écriture interrompue ne laisse pas une disposition à moitié.
///
/// `attendu` est le dossier que l'éditeur croit courant : s'il a changé entre-
/// temps, on refuse plutôt que d'écrire — et surtout de remplacer — un
/// homonyme dans un autre dossier. Il ne désigne rien, il confirme.
#[tauri::command]
pub async fn ecrire_disposition(
    fenetre: WebviewWindow,
    etat: State<'_, DossierDispositions>,
    attendu: String,
    nom: String,
    contenu: String,
    remplacer: bool,
) -> Result<(), String> {
    depuis_le_pavillon(&fenetre)?;
    nom_valide(&nom)?;
    let dossier = dossier_existant(&etat)?;
    if texte(&dossier) != attendu {
        return Err("le dossier des dispositions a changé : rien n'a été écrit".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let chemin = dossier.join(&nom);
        if remplacer {
            remplacer_fichier(&chemin, contenu.as_bytes())
        } else {
            let mut fichier = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&chemin)
                .map_err(|e| match e.kind() {
                    std::io::ErrorKind::AlreadyExists => "un fichier porte déjà ce nom".to_string(),
                    _ => e.to_string(),
                })?;
            fichier
                .write_all(contenu.as_bytes())
                .and_then(|()| fichier.sync_all())
                .map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn remplacer_fichier(chemin: &Path, octets: &[u8]) -> Result<(), String> {
    let mut provisoire = chemin.as_os_str().to_owned();
    provisoire.push(".enregistrement");
    let provisoire = PathBuf::from(provisoire);
    let ecrire = || -> std::io::Result<()> {
        let mut fichier = fs::File::create(&provisoire)?;
        fichier.write_all(octets)?;
        fichier.sync_all()?;
        fs::rename(&provisoire, chemin)
    };
    ecrire().map_err(|e| {
        let _ = fs::remove_file(&provisoire);
        e.to_string()
    })
}

/// Exporte une disposition où l'on veut, par la boîte d'enregistrement du
/// système. Rend le chemin écrit, ou `None` si on l'a refermée.
#[tauri::command]
pub async fn exporter_disposition(
    fenetre: WebviewWindow,
    etat: State<'_, DossierDispositions>,
    nom: String,
    contenu: String,
) -> Result<Option<String>, String> {
    depuis_le_pavillon(&fenetre)?;
    let depart = dossier_courant(&etat)?.filter(|d| d.is_dir());
    tauri::async_runtime::spawn_blocking(move || {
        let mut boite = fenetre
            .dialog()
            .file()
            .set_parent(&fenetre)
            .add_filter("Disposition de pavillon", &["xml"])
            .set_file_name(&nom);
        if let Some(depart) = depart {
            boite = boite.set_directory(depart);
        }
        let Some(choix) = boite.blocking_save_file() else {
            return Ok(None);
        };
        let chemin = choix.into_path().map_err(|e| e.to_string())?;
        // Lui ajouter l'extension écrirait un fichier que la boîte n'a pas
        // montré, et dont elle n'a pas fait confirmer le remplacement.
        if !est_xml(&chemin) {
            return Err("une disposition s'exporte en .xml".to_string());
        }
        remplacer_fichier(&chemin, contenu.as_bytes())?;
        Ok(Some(chemin.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_nom_ne_sort_pas_du_dossier() {
        assert!(nom_valide("Serre Silvie.xml").is_ok());
        assert!(nom_valide("Île Comosus (2).xml").is_ok());
        assert!(nom_valide("Console.xml").is_ok());
        assert!(nom_valide("COM10.xml").is_ok());
        for nom in [
            "..\\x.xml",
            "../x.xml",
            "a/b.xml",
            "C:x.xml",
            ".xml",
            "x.txt",
            "x",
            " .xml",
            "NUL.xml",
            "con.xml",
            "Com1.xml",
            "lpt9.ancien.xml",
            "aux .xml",
        ] {
            assert!(nom_valide(nom).is_err(), "{nom}");
        }
    }

    #[test]
    fn la_carte_se_lit_dans_l_en_tete() {
        let texte = "<?xml version=\"1.0\"?>\n<Decorations version=\"1\" mapId=\"1558\" mapName=\"Lueur de l'âtre &amp; co\" type=\"0\">\n    <prop id=\"1\" name=\"mapName=&quot;x&quot;\"/>\n";
        assert_eq!(nom_de_carte(texte).as_deref(), Some("Lueur de l'âtre & co"));
        assert_eq!(
            nom_de_carte("<Decorations>\n    <prop mapName=\"x\"/>"),
            None
        );
    }
}
