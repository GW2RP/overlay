//! Le serveur MCP de l'éditeur de pavillon : Claude y ouvre une disposition,
//! en relève une image, tourne la caméra, et corrige des décorations — sans
//! prendre la souris de la machine.
//!
//! Le protocole et ses garde-fous vivent dans le crate `serveur-mcp`. Ici, on
//! le **relaie** : la disposition ouverte, la scène et sa caméra vivent dans
//! la fenêtre `pavillon`, donc chaque appel d'outil y part en évènement
//! (`mcp-appel`) et revient par `mcp_repondre`. La fenêtre se crée et se
//! montre à la demande — cachée ou réduite, la vue web suspend ses images, et
//! les modèles n'arriveraient jamais —, sans prendre le focus.
//!
//! Le serveur est **éteint par défaut** : un port ouvert ne s'ouvre que parce
//! qu'on l'a demandé, depuis l'éditeur. Ce choix et le jeton se rangent dans
//! un fichier à Rust (`mcp.json`), hors du magasin que le front écrit — comme
//! le dossier des dispositions.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use serveur_mcp::{Description, Outils, Resultat, Serveur};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::dispositions::depuis_le_pavillon;
use crate::FENETRE_PAVILLON;

/// Un port fixe : c'est l'adresse qu'on donne une fois à Claude.
pub const PORT: u16 = 47823;

const FICHIER: &str = "mcp.json";

const EVENEMENT_APPEL: &str = "mcp-appel";

/// Le temps qu'une fenêtre fraîchement créée a pour charger sa page et se
/// déclarer prête.
const DELAI_FENETRE: Duration = Duration::from_secs(30);
/// Un relevé attend que l'archive ait donné tous les modèles : une grande
/// disposition en compte plus de cent sortes.
const DELAI_CAPTURE: Duration = Duration::from_secs(180);
const DELAI_OUTIL: Duration = Duration::from_secs(60);

#[derive(Default, Serialize, Deserialize)]
struct Reglage {
    actif: bool,
    jeton: String,
}

#[derive(Default)]
struct EtatServeur {
    serveur: Option<Serveur>,
    erreur: Option<String>,
}

type Attente = mpsc::Sender<Resultat>;

#[derive(Default)]
pub struct Mcp {
    etat: Mutex<EtatServeur>,
    attentes: Mutex<HashMap<u64, Attente>>,
    suivant: AtomicU64,
    /// Vrai quand la fenêtre de l'éditeur écoute les appels.
    pret: AtomicBool,
}

/// Ce que l'éditeur montre du serveur.
#[derive(Serialize)]
pub struct EtatMcp {
    pub actif: bool,
    pub adresse: String,
    pub jeton: String,
    pub erreur: Option<String>,
}

fn fichier(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join(FICHIER))
}

fn lire_reglage(app: &AppHandle) -> Reglage {
    fichier(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn ecrire_reglage(app: &AppHandle, reglage: &Reglage) -> Result<(), String> {
    let chemin = fichier(app).ok_or("le dossier de l'application est introuvable")?;
    if let Some(parent) = chemin.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let texte = serde_json::to_string_pretty(reglage).map_err(|e| e.to_string())?;
    fs::write(chemin, texte).map_err(|e| e.to_string())
}

/// Trente-deux octets du générateur du système, en hexadécimal.
fn nouveau_jeton() -> Result<String, String> {
    let mut octets = [0u8; 32];
    getrandom::fill(&mut octets).map_err(|e| e.to_string())?;
    Ok(octets.iter().map(|o| format!("{o:02x}")).collect())
}

/// Le réglage rangé, avec un jeton : le premier lancement en tire un.
fn reglage_complet(app: &AppHandle) -> Result<Reglage, String> {
    let mut reglage = lire_reglage(app);
    if reglage.jeton.is_empty() {
        reglage.jeton = nouveau_jeton()?;
        ecrire_reglage(app, &reglage)?;
    }
    Ok(reglage)
}

fn adresse() -> String {
    format!("http://127.0.0.1:{PORT}{}", serveur_mcp::CHEMIN)
}

/// Allume ou éteint le serveur selon le réglage. Un port déjà pris ne fait
/// rien tomber : l'erreur se montre dans l'éditeur.
fn appliquer(app: &AppHandle, reglage: &Reglage) -> Result<(), String> {
    let mcp = app.state::<Mcp>();
    let mut etat = mcp
        .etat
        .lock()
        .map_err(|_| "le serveur MCP est inaccessible")?;
    // L'ancien s'arrête avant que le nouveau ne prenne le port.
    etat.serveur = None;
    etat.erreur = None;
    if !reglage.actif {
        return Ok(());
    }
    let relais = Arc::new(Relais { app: app.clone() });
    match Serveur::demarrer(PORT, reglage.jeton.clone(), description(app), relais) {
        Ok(serveur) => etat.serveur = Some(serveur),
        Err(erreur) => {
            etat.erreur = Some(format!("le port {PORT} ne s'ouvre pas : {erreur}"));
        }
    }
    Ok(())
}

fn etat_courant(app: &AppHandle) -> Result<EtatMcp, String> {
    let reglage = reglage_complet(app)?;
    let mcp = app.state::<Mcp>();
    let etat = mcp
        .etat
        .lock()
        .map_err(|_| "le serveur MCP est inaccessible")?;
    Ok(EtatMcp {
        actif: etat.serveur.is_some(),
        adresse: adresse(),
        jeton: reglage.jeton,
        erreur: etat.erreur.clone(),
    })
}

/// Au lancement : le serveur se rallume s'il l'était.
pub fn demarrer(app: &AppHandle) {
    let reglage = lire_reglage(app);
    if !reglage.actif {
        return;
    }
    let resultat = reglage_complet(app).and_then(|reglage| appliquer(app, &reglage));
    if let Err(erreur) = resultat {
        eprintln!("le serveur MCP ne démarre pas : {erreur}");
    }
}

#[tauri::command]
pub fn etat_mcp(app: AppHandle, fenetre: WebviewWindow) -> Result<EtatMcp, String> {
    depuis_le_pavillon(&fenetre)?;
    etat_courant(&app)
}

#[tauri::command]
pub fn regler_mcp(app: AppHandle, fenetre: WebviewWindow, actif: bool) -> Result<EtatMcp, String> {
    depuis_le_pavillon(&fenetre)?;
    let mut reglage = reglage_complet(&app)?;
    reglage.actif = actif;
    ecrire_reglage(&app, &reglage)?;
    appliquer(&app, &reglage)?;
    etat_courant(&app)
}

/// Un nouveau jeton : l'ancien ne vaut plus rien, et le serveur allumé
/// redémarre avec celui-ci.
#[tauri::command]
pub fn renouveler_jeton_mcp(app: AppHandle, fenetre: WebviewWindow) -> Result<EtatMcp, String> {
    depuis_le_pavillon(&fenetre)?;
    let mut reglage = reglage_complet(&app)?;
    reglage.jeton = nouveau_jeton()?;
    ecrire_reglage(&app, &reglage)?;
    let allume = app
        .state::<Mcp>()
        .etat
        .lock()
        .map_err(|_| "le serveur MCP est inaccessible")?
        .serveur
        .is_some();
    if allume {
        appliquer(&app, &reglage)?;
    }
    etat_courant(&app)
}

/// L'éditeur écoute les appels.
#[tauri::command]
pub fn mcp_pret(fenetre: WebviewWindow, etat: State<'_, Mcp>) -> Result<(), String> {
    depuis_le_pavillon(&fenetre)?;
    etat.pret.store(true, Ordering::Relaxed);
    Ok(())
}

/// La réponse de l'éditeur à un appel : le contenu du protocole, ou une
/// phrase d'erreur.
#[tauri::command]
pub fn mcp_repondre(
    fenetre: WebviewWindow,
    etat: State<'_, Mcp>,
    id: u64,
    contenu: Option<Vec<Value>>,
    erreur: Option<String>,
) -> Result<(), String> {
    depuis_le_pavillon(&fenetre)?;
    let attente = etat
        .attentes
        .lock()
        .map_err(|_| "le serveur MCP est inaccessible")?
        .remove(&id);
    // Un appel déjà abandonné, faute de réponse à temps : rien n'attend plus.
    if let Some(attente) = attente {
        let resultat = match (contenu, erreur) {
            (_, Some(erreur)) => Err(erreur),
            (Some(contenu), None) => Ok(contenu),
            (None, None) => Ok(Vec::new()),
        };
        let _ = attente.send(resultat);
    }
    Ok(())
}

/* --- Le relais ------------------------------------------------------------------ */

struct Relais {
    app: AppHandle,
}

impl Relais {
    /// La fenêtre de l'éditeur, créée s'il le faut, montrée sans prendre le
    /// focus, et prête à écouter.
    fn fenetre(&self) -> Result<(), String> {
        let fenetre = crate::fenetre_pavillon(&self.app)?;
        let _ = fenetre.unminimize();
        if !fenetre.is_visible().unwrap_or(false) {
            fenetre.show().map_err(|e| e.to_string())?;
        }
        let mcp = self.app.state::<Mcp>();
        let debut = Instant::now();
        while !mcp.pret.load(Ordering::Relaxed) {
            if debut.elapsed() > DELAI_FENETRE {
                return Err("l'éditeur de pavillon ne s'est pas ouvert à temps".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }
}

impl Outils for Relais {
    fn appeler(&self, nom: &str, arguments: Value) -> Resultat {
        self.fenetre()?;
        let mcp = self.app.state::<Mcp>();
        let id = mcp.suivant.fetch_add(1, Ordering::Relaxed);
        let (envoi, reception) = mpsc::channel();
        mcp.attentes
            .lock()
            .map_err(|_| "le serveur MCP est inaccessible")?
            .insert(id, envoi);

        let emis = self.app.emit_to(
            FENETRE_PAVILLON,
            EVENEMENT_APPEL,
            json!({ "id": id, "outil": nom, "arguments": arguments }),
        );
        let delai = if nom == "capturer_vue" {
            DELAI_CAPTURE
        } else {
            DELAI_OUTIL
        };
        let resultat = match emis {
            Ok(()) => reception
                .recv_timeout(delai)
                .map_err(|_| "l'éditeur de pavillon n'a pas répondu à temps".to_string())
                .and_then(|r| r),
            Err(erreur) => Err(erreur.to_string()),
        };
        if let Ok(mut attentes) = mcp.attentes.lock() {
            attentes.remove(&id);
        }
        resultat
    }
}

/* --- Les outils --------------------------------------------------------------- */

const INSTRUCTIONS: &str = "\
L'éditeur de pavillon de GW2RP Overlay : une disposition de décorations de pavillon (homestead) de Guild Wars 2, \
telle que le jeu l'exporte en XML, vue en trois dimensions avec les modèles lus dans l'archive du jeu.

Repère : celui du fichier. Les positions sont en pouces du jeu, x vers l'est, y vers le nord, z vers le BAS \
(une altitude négative est au-dessus du sol). Les rotations sont en radians, comme dans le fichier ; l'échelle \
est uniforme, par pas de 1/252.

Chaque décoration a une `cle`, stable pendant la session : c'est par elle qu'on la choisit, la cadre ou la modifie, \
pas par son rang dans le fichier.

La caméra tourne autour d'une cible : `azimut` en degrés est le côté d'où elle regarde (0 = depuis le nord, \
90 = depuis l'est, 180 = depuis le sud, 270 = depuis l'ouest), `elevation` en degrés au-dessus de l'horizon \
(89 : vue de dessus ; avec un azimut de 180, le nord est en haut de l'image), `distance` en pouces. \
`cadrer` pose la cible et la distance sur des décorations.

Une décoration sans modèle lisible — archive fermée, ou modèle inconnu — se montre en cube de repère de 60 pouces, \
sans prétendre à sa taille. Les décorations choisies sont en carmin.

Les modifications passent par l'historique de l'éditeur : `annuler` les défait une à une. Rien ne s'écrit sur le \
disque sans `enregistrer_disposition`, qui crée toujours un nouveau fichier.";

fn proprietes_camera() -> serde_json::Map<String, Value> {
    let triplet =
        json!({ "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 });
    let mut proprietes = serde_json::Map::new();
    proprietes.insert(
        "cadrer".into(),
        json!({
            "description": "Pose la cible au centre et la distance qui embrasse : « tout », « selection », ou une liste de clés.",
            "anyOf": [
                { "type": "string", "enum": ["tout", "selection"] },
                { "type": "array", "items": { "type": "integer" } }
            ]
        }),
    );
    proprietes.insert(
        "cible".into(),
        json!({ "description": "Le point regardé, en pouces du jeu [x, y, z].", "allOf": [triplet] }),
    );
    proprietes.insert(
        "azimut".into(),
        json!({ "type": "number", "description": "Le côté d'où la caméra regarde, en degrés : 0 nord, 90 est, 180 sud, 270 ouest." }),
    );
    proprietes.insert(
        "elevation".into(),
        json!({ "type": "number", "minimum": -89, "maximum": 89.5, "description": "En degrés au-dessus de l'horizon ; 89 pour une vue de dessus." }),
    );
    proprietes.insert(
        "distance".into(),
        json!({ "type": "number", "exclusiveMinimum": 0, "description": "De la caméra à la cible, en pouces." }),
    );
    proprietes
}

fn objet(proprietes: serde_json::Map<String, Value>, requis: &[&str]) -> Value {
    json!({ "type": "object", "properties": proprietes, "required": requis, "additionalProperties": false })
}

fn outil(nom: &str, description: &str, schema: Value, lecture: bool) -> Value {
    json!({
        "name": nom,
        "description": description,
        "inputSchema": schema,
        "annotations": { "readOnlyHint": lecture, "destructiveHint": false, "openWorldHint": false },
    })
}

fn description(app: &AppHandle) -> Description {
    let vide = || objet(serde_json::Map::new(), &[]);
    let cles = json!({ "type": "array", "items": { "type": "integer" } });
    let triplet =
        json!({ "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 });

    let mut capture = proprietes_camera();
    capture.insert(
        "largeur".into(),
        json!({ "type": "integer", "minimum": 256, "maximum": 2048, "default": 1280 }),
    );
    capture.insert(
        "hauteur".into(),
        json!({ "type": "integer", "minimum": 256, "maximum": 2048, "default": 800 }),
    );
    capture.insert(
        "attendre_modeles".into(),
        json!({ "type": "boolean", "default": true, "description": "Attendre que l'archive ait donné les modèles de toutes les sortes avant le relevé." }),
    );

    let mut ouvrir = serde_json::Map::new();
    ouvrir.insert(
        "fichier".into(),
        json!({ "type": "string", "description": "Le nom d'un fichier du dossier des dispositions (voir lister_dispositions)." }),
    );
    ouvrir.insert(
        "xml".into(),
        json!({ "type": "string", "description": "Le texte d'une disposition, au format de l'export du jeu." }),
    );
    ouvrir.insert(
        "nom".into(),
        json!({ "type": "string", "description": "Le nom affiché d'une disposition passée en `xml`." }),
    );
    ouvrir.insert(
        "abandonner_modifications".into(),
        json!({ "type": "boolean", "default": false, "description": "Vrai pour remplacer une disposition ouverte dont les modifications ne sont pas enregistrées." }),
    );

    let mut lister = serde_json::Map::new();
    lister.insert("cles".into(), cles.clone());
    lister.insert("ids".into(), json!({ "type": "array", "items": { "type": "integer" }, "description": "Identifiants de décoration (ceux de l'API)." }));
    lister.insert(
        "recherche".into(),
        json!({ "type": "string", "description": "Un morceau du nom." }),
    );
    lister.insert(
        "avec_boites".into(),
        json!({ "type": "boolean", "default": false, "description": "Ajoute la boîte englobante de chaque décoration dont le modèle est lu, en pouces du jeu." }),
    );

    let mut modifier = serde_json::Map::new();
    modifier.insert(
        "modifier".into(),
        json!({
            "type": "array",
            "description": "Valeurs absolues ; ce qui n'est pas donné ne change pas.",
            "items": {
                "type": "object",
                "properties": { "cle": { "type": "integer" }, "position": triplet, "rotation": triplet, "echelle": { "type": "number", "exclusiveMinimum": 0 } },
                "required": ["cle"],
                "additionalProperties": false
            }
        }),
    );
    modifier.insert(
        "deplacer".into(),
        json!({
            "type": "object",
            "description": "Un même écart pour plusieurs décorations ; angles et échelles restent ceux du fichier.",
            "properties": { "cles": cles, "ecart": triplet },
            "required": ["cles", "ecart"],
            "additionalProperties": false
        }),
    );
    modifier.insert(
        "ajouter".into(),
        json!({
            "type": "array",
            "items": {
                "type": "object",
                "properties": { "id": { "type": "integer" }, "position": triplet, "rotation": triplet, "echelle": { "type": "number", "exclusiveMinimum": 0 } },
                "required": ["id", "position"],
                "additionalProperties": false
            }
        }),
    );
    modifier.insert("retirer".into(), cles.clone());

    let mut choisir = serde_json::Map::new();
    choisir.insert("cles".into(), cles.clone());

    let mut enregistrer = serde_json::Map::new();
    enregistrer.insert(
        "nom".into(),
        json!({ "type": "string", "description": "Le nom du nouveau fichier, avec ou sans .xml. Un fichier du même nom fait refuser l'écriture." }),
    );

    Description {
        nom: "gw2rp-pavillon".into(),
        version: app.package_info().version.to_string(),
        instructions: INSTRUCTIONS.into(),
        outils: vec![
            outil("etat_editeur", "La disposition ouverte, l'archive, les modèles lus, la sélection et la caméra.", vide(), true),
            outil("lister_dispositions", "Les fichiers .xml du dossier des dispositions.", vide(), true),
            outil(
                "ouvrir_disposition",
                "Ouvre une disposition, par son nom de fichier dans le dossier ou par son texte XML. La caméra se cadre sur elle.",
                objet(ouvrir, &[]),
                false,
            ),
            outil(
                "lister_decorations",
                "Les décorations de la disposition ouverte : clé, identifiant, nom, position, rotation, échelle. Sans filtre, toutes.",
                objet(lister, &[]),
                true,
            ),
            outil(
                "capturer_vue",
                "Une image PNG de la scène. Les réglages de caméra donnés s'appliquent d'abord, et restent.",
                objet(capture, &[]),
                true,
            ),
            outil("regler_camera", "Déplace la caméra de l'éditeur, sans relevé.", objet(proprietes_camera(), &[]), true),
            outil("choisir", "Choisit des décorations : elles s'allument en carmin. Une liste vide vide la sélection.", objet(choisir, &["cles"]), true),
            outil(
                "modifier_decorations",
                "Modifie, déplace, ajoute ou retire des décorations, en un seul geste d'historique. Rend les clés des ajoutées.",
                objet(modifier, &[]),
                false,
            ),
            outil("annuler", "Défait le dernier geste.", vide(), false),
            outil("retablir", "Refait le dernier geste défait.", vide(), false),
            outil("lire_xml", "La disposition ouverte, au format de l'export du jeu, telle qu'elle s'enregistrerait.", vide(), true),
            outil(
                "enregistrer_disposition",
                "Écrit la disposition ouverte dans un nouveau fichier du dossier des dispositions. N'écrase jamais un fichier.",
                objet(enregistrer, &["nom"]),
                false,
            ),
        ],
    }
}
