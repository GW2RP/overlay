//! La présence Discord de l'overlay : ce que les amis voient sous le nom du
//! joueur — le personnage joué, ce qu'il fait en jeu de rôle, et où, s'il le
//! partage.
//!
//! Le client Discord de la machine écoute un canal local, `discord-ipc-N` : un
//! tube nommé sous Windows, un socket Unix ailleurs. On s'y présente avec
//! l'identifiant de l'application Discord, sans OAuth : poser une présence
//! n'en demande pas. Chaque message est une **trame** — l'opération et la
//! longueur en entiers 32 bits petit-boutistes, puis le JSON.
//!
//! Le crate ne connaît ni le jeu ni le hub. Il reçoit une `Activite` déjà
//! composée, la borne aux limites de Discord, et la tient à jour depuis un fil
//! à lui (`Presence`) : connexion quand Discord apparaît, reprise quand il
//! redémarre, et pas plus d'un envoi toutes les quatre secondes — Discord en
//! accepte cinq par vingt secondes et ignore le reste sans le dire.

use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

/* --- Les trames -------------------------------------------------------------- */

/// La présentation : la version du protocole et l'identifiant de l'application.
pub const OP_PRESENTATION: u32 = 0;
/// Une commande, ou sa réponse.
pub const OP_TRAME: u32 = 1;
/// Discord ferme la connexion, avec un code et un message.
pub const OP_FERMETURE: u32 = 2;
pub const OP_PING: u32 = 3;
pub const OP_PONG: u32 = 4;

/// Une réponse de Discord tient en quelques kilo-octets. Une longueur
/// au-delà vient d'un canal qui n'est pas Discord, ou d'un flux décalé : on
/// ne l'alloue pas sur sa parole.
pub const TRAME_MAX: usize = 64 * 1024;

pub fn ecrire_trame(canal: &mut impl Write, op: u32, charge: &Value) -> io::Result<()> {
    let corps = serde_json::to_vec(charge).map_err(io::Error::other)?;
    let longueur = u32::try_from(corps.len()).map_err(io::Error::other)?;
    let mut trame = Vec::with_capacity(8 + corps.len());
    trame.extend_from_slice(&op.to_le_bytes());
    trame.extend_from_slice(&longueur.to_le_bytes());
    trame.extend_from_slice(&corps);
    canal.write_all(&trame)?;
    canal.flush()
}

pub fn lire_trame(canal: &mut impl Read) -> io::Result<(u32, Value)> {
    let mut entete = [0u8; 8];
    canal.read_exact(&mut entete)?;
    let op = u32::from_le_bytes([entete[0], entete[1], entete[2], entete[3]]);
    let longueur = u32::from_le_bytes([entete[4], entete[5], entete[6], entete[7]]) as usize;
    if longueur > TRAME_MAX {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("trame de {longueur} octets : ce n'est pas Discord qui répond"),
        ));
    }
    let mut corps = vec![0u8; longueur];
    canal.read_exact(&mut corps)?;
    let charge = if corps.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&corps)
            .map_err(|erreur| io::Error::new(io::ErrorKind::InvalidData, erreur))?
    };
    Ok((op, charge))
}

/* --- L'activité ---------------------------------------------------------------- */

/// Les limites de Discord, en caractères : au-delà, toute l'activité est
/// refusée, pas seulement le champ trop long.
pub const TEXTE_MAX: usize = 128;
pub const TEXTE_MIN: usize = 2;
pub const LIBELLE_MAX: usize = 32;
pub const URL_MAX: usize = 512;
pub const BOUTONS_MAX: usize = 2;

/// L'image téléversée dans l'application Discord, sous ce nom.
pub const IMAGE: &str = "gw2rp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bouton {
    pub libelle: String,
    pub url: String,
}

/// Une présence, telle que le front la compose. Les noms sont ceux du front ;
/// `vers_discord` les traduit dans ceux de Discord.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activite {
    /// La première ligne.
    pub details: String,
    /// La seconde ligne, facultative.
    pub etat: Option<String>,
    /// Le texte au survol de l'image, facultatif.
    pub texte_image: Option<String>,
    /// Le début de la partie, en millisecondes Unix : Discord en tire le
    /// « depuis 12 min ».
    pub debut: Option<u64>,
    pub boutons: Vec<Bouton>,
}

/// Tronque au caractère, avec une ellipse : un texte coupé doit se voir coupé.
fn borner(texte: &str, max: usize) -> String {
    let propre = texte.split_whitespace().collect::<Vec<_>>().join(" ");
    if propre.chars().count() <= max {
        return propre;
    }
    let mut coupe: String = propre.chars().take(max - 1).collect();
    coupe = coupe.trim_end().to_string();
    coupe.push('…');
    coupe
}

/// Un texte facultatif : trop court pour Discord, il n'est pas écrit plutôt
/// que de faire refuser l'activité entière.
fn texte_facultatif(valeur: Option<&Value>) -> Option<String> {
    let texte = borner(valeur?.as_str()?, TEXTE_MAX);
    (texte.chars().count() >= TEXTE_MIN).then_some(texte)
}

impl Activite {
    /// Lit l'activité que le front envoie : `details`, `etat`, `texteImage`,
    /// `debut`, `boutons` (`libelle`, `url`). Tout est borné ici, au dernier
    /// endroit avant Discord.
    pub fn depuis_json(valeur: &Value) -> Result<Activite, String> {
        let objet = valeur
            .as_object()
            .ok_or_else(|| "une activité est un objet".to_string())?;
        let details = texte_facultatif(objet.get("details"))
            .ok_or_else(|| "une activité porte au moins sa première ligne".to_string())?;
        let mut boutons = Vec::new();
        for bouton in objet
            .get("boutons")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let libelle = bouton
                .get("libelle")
                .and_then(Value::as_str)
                .map(|texte| borner(texte, LIBELLE_MAX))
                .unwrap_or_default();
            let url = bouton
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // Discord n'ouvre que des liens web ; un autre schéma ferait
            // refuser toute l'activité.
            if libelle.is_empty() || url.len() > URL_MAX || !url.starts_with("https://") {
                continue;
            }
            boutons.push(Bouton {
                libelle,
                url: url.to_string(),
            });
            if boutons.len() == BOUTONS_MAX {
                break;
            }
        }
        Ok(Activite {
            details,
            etat: texte_facultatif(objet.get("etat")),
            texte_image: texte_facultatif(objet.get("texteImage")),
            debut: objet.get("debut").and_then(Value::as_u64),
            boutons,
        })
    }

    /// L'activité dans les noms de Discord.
    pub fn vers_discord(&self) -> Value {
        let mut activite = Map::new();
        activite.insert("details".into(), json!(self.details));
        if let Some(etat) = &self.etat {
            activite.insert("state".into(), json!(etat));
        }
        let mut images = Map::new();
        images.insert("large_image".into(), json!(IMAGE));
        if let Some(texte) = &self.texte_image {
            images.insert("large_text".into(), json!(texte));
        }
        activite.insert("assets".into(), Value::Object(images));
        if let Some(debut) = self.debut {
            activite.insert("timestamps".into(), json!({ "start": debut }));
        }
        if !self.boutons.is_empty() {
            let boutons: Vec<Value> = self
                .boutons
                .iter()
                .map(|bouton| json!({ "label": bouton.libelle, "url": bouton.url }))
                .collect();
            activite.insert("buttons".into(), Value::Array(boutons));
        }
        Value::Object(activite)
    }
}

/* --- Le client ------------------------------------------------------------------ */

/// Une connexion présentée au client Discord.
pub struct Client<C: Read + Write> {
    canal: C,
    nonce: u64,
}

fn message_de(charge: &Value) -> String {
    let texte = charge
        .get("message")
        .or_else(|| charge.pointer("/data/message"))
        .and_then(Value::as_str)
        .unwrap_or("sans message");
    match charge
        .get("code")
        .or_else(|| charge.pointer("/data/code"))
        .and_then(Value::as_i64)
    {
        Some(code) => format!("{texte} ({code})"),
        None => texte.to_string(),
    }
}

impl<C: Read + Write> Client<C> {
    /// Se présente, et attend que Discord se dise prêt.
    pub fn connecter(mut canal: C, id_application: &str) -> io::Result<Client<C>> {
        ecrire_trame(
            &mut canal,
            OP_PRESENTATION,
            &json!({ "v": 1, "client_id": id_application }),
        )?;
        let (op, charge) = lire_trame(&mut canal)?;
        match op {
            OP_TRAME if charge.get("evt").and_then(Value::as_str) == Some("READY") => {
                Ok(Client { canal, nonce: 0 })
            }
            OP_FERMETURE => Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                format!("Discord refuse la connexion : {}", message_de(&charge)),
            )),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Discord n'a pas répondu à la présentation",
            )),
        }
    }

    /// Pose l'activité, ou l'efface (`None`), au nom du processus `pid` :
    /// Discord l'efface de lui-même quand ce processus se termine.
    pub fn regler(&mut self, pid: u32, activite: Option<&Activite>) -> io::Result<()> {
        self.nonce += 1;
        let nonce = self.nonce.to_string();
        let mut arguments = Map::new();
        arguments.insert("pid".into(), json!(pid));
        if let Some(activite) = activite {
            arguments.insert("activity".into(), activite.vers_discord());
        }
        ecrire_trame(
            &mut self.canal,
            OP_TRAME,
            &json!({ "cmd": "SET_ACTIVITY", "args": arguments, "nonce": nonce }),
        )?;

        // La réponse porte le même nonce. Entre-temps, Discord peut sonder la
        // connexion : un ping se rend en pong, avec la même charge.
        for _ in 0..16 {
            let (op, charge) = lire_trame(&mut self.canal)?;
            match op {
                OP_PING => ecrire_trame(&mut self.canal, OP_PONG, &charge)?,
                OP_FERMETURE => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        format!("Discord ferme la connexion : {}", message_de(&charge)),
                    ))
                }
                OP_TRAME if charge.get("nonce").and_then(Value::as_str) == Some(&nonce) => {
                    if charge.get("evt").and_then(Value::as_str) == Some("ERROR") {
                        return Err(io::Error::other(format!(
                            "Discord refuse l'activité : {}",
                            message_de(&charge)
                        )));
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Discord n'a pas répondu à l'activité",
        ))
    }
}

/* --- Le canal ------------------------------------------------------------------- */

/// Discord en ouvre un par instance lancée, de 0 à 9 : le premier qui répond
/// est le bon.
const CANAUX: u32 = 10;

#[cfg(windows)]
pub type Canal = std::fs::File;

#[cfg(windows)]
pub fn ouvrir_canal() -> io::Result<Canal> {
    let mut derniere = io::Error::new(io::ErrorKind::NotFound, "Discord n'est pas lancé");
    for numero in 0..CANAUX {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!(r"\\?\pipe\discord-ipc-{numero}"))
        {
            Ok(canal) => return Ok(canal),
            Err(erreur) => derniere = erreur,
        }
    }
    Err(derniere)
}

#[cfg(unix)]
pub type Canal = std::os::unix::net::UnixStream;

/// Hors Windows, pour développer : le socket vit dans le dossier temporaire
/// de la session, et les paquets Flatpak et Snap le rangent un cran plus bas.
#[cfg(unix)]
pub fn ouvrir_canal() -> io::Result<Canal> {
    let mut dossiers: Vec<std::path::PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(std::env::var_os)
        .map(Into::into)
        .collect();
    dossiers.push("/tmp".into());
    let mut derniere = io::Error::new(io::ErrorKind::NotFound, "Discord n'est pas lancé");
    for dossier in &dossiers {
        for sous in ["", "app/com.discordapp.Discord", "snap.discord"] {
            for numero in 0..CANAUX {
                let chemin = dossier.join(sous).join(format!("discord-ipc-{numero}"));
                match Canal::connect(&chemin) {
                    Ok(canal) => {
                        // Un Discord figé ne doit pas tenir le fil pour toujours.
                        canal.set_read_timeout(Some(Duration::from_secs(10)))?;
                        return Ok(canal);
                    }
                    Err(erreur) => derniere = erreur,
                }
            }
        }
    }
    Err(derniere)
}

/* --- Le fil de présence ------------------------------------------------------------ */

/// Discord accepte cinq activités par vingt secondes : au-delà, il les
/// ignore sans le dire. Une frappe dans le champ de description ne part donc
/// qu'au plus toutes les quatre secondes, et c'est la dernière qui part.
pub const INTERVALLE_MIN: Duration = Duration::from_secs(4);
/// Discord absent, on retente à ce rythme : ouvrir un tube qui n'existe pas
/// ne coûte rien.
pub const RECONNEXION: Duration = Duration::from_secs(15);
/// Une connexion ne dit pas qu'elle est tombée tant qu'on n'y écrit pas : on
/// y repose l'activité à ce rythme, et un Discord redémarré la retrouve.
pub const RAFRAICHISSEMENT: Duration = Duration::from_secs(60);

/// Ce que le fil peut dire de lui-même.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Etat {
    /// Vrai quand la dernière activité voulue est posée.
    pub posee: bool,
    pub erreur: Option<String>,
}

#[derive(Default)]
struct Interne {
    voulue: Option<Activite>,
    version: u64,
    arret: bool,
    etat: Etat,
}

#[derive(Default)]
struct Partage {
    interne: Mutex<Interne>,
    reveil: Condvar,
}

/// Le fil qui tient la présence. `regler` ne fait que ranger l'activité voulue
/// et réveiller le fil : il ne bloque jamais, Discord absent ou figé.
pub struct Presence {
    partage: Arc<Partage>,
    fil: Option<JoinHandle<()>>,
}

impl Presence {
    pub fn demarrer<C, F>(id_application: String, pid: u32, ouvrir: F) -> Presence
    where
        C: Read + Write,
        F: Fn() -> io::Result<C> + Send + 'static,
    {
        let partage = Arc::new(Partage::default());
        let pour_le_fil = Arc::clone(&partage);
        let fil = std::thread::Builder::new()
            .name("presence-discord".into())
            .spawn(move || boucle(&pour_le_fil, &id_application, pid, ouvrir))
            .expect("le fil de la présence Discord démarre");
        Presence {
            partage,
            fil: Some(fil),
        }
    }

    pub fn regler(&self, activite: Option<Activite>) {
        let Ok(mut interne) = self.partage.interne.lock() else {
            return;
        };
        if interne.voulue == activite {
            return;
        }
        interne.voulue = activite;
        interne.version += 1;
        interne.etat.posee = false;
        self.partage.reveil.notify_all();
    }

    pub fn etat(&self) -> Etat {
        self.partage
            .interne
            .lock()
            .map(|interne| interne.etat.clone())
            .unwrap_or_default()
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        if let Ok(mut interne) = self.partage.interne.lock() {
            interne.arret = true;
        }
        self.partage.reveil.notify_all();
        if let Some(fil) = self.fil.take() {
            let _ = fil.join();
        }
    }
}

fn noter(partage: &Partage, version: u64, posee: bool, erreur: Option<String>) {
    if let Ok(mut interne) = partage.interne.lock() {
        // Une activité arrivée pendant l'envoi n'est pas encore posée.
        if interne.version == version {
            interne.etat = Etat { posee, erreur };
        }
    }
}

fn boucle<C, F>(partage: &Partage, id_application: &str, pid: u32, ouvrir: F)
where
    C: Read + Write,
    F: Fn() -> io::Result<C>,
{
    let mut client: Option<Client<C>> = None;
    // La version posée sur la connexion courante, et quand.
    let mut envoyee: Option<u64> = None;
    let mut dernier_envoi: Option<Instant> = None;
    let mut prochaine_tentative = Instant::now();

    loop {
        let (voulue, version) = {
            let Ok(mut interne) = partage.interne.lock() else {
                return;
            };
            loop {
                if interne.arret {
                    if let Some(client) = client.as_mut() {
                        let _ = client.regler(pid, None);
                    }
                    return;
                }
                let maintenant = Instant::now();
                let a_poser = envoyee != Some(interne.version);
                let a_rafraichir = client.is_some()
                    && dernier_envoi.is_some_and(|t| maintenant - t >= RAFRAICHISSEMENT);
                if (a_poser && maintenant >= prochaine_tentative) || a_rafraichir {
                    break;
                }
                let mut attente = RAFRAICHISSEMENT;
                if a_poser {
                    attente = attente.min(prochaine_tentative - maintenant);
                }
                if let (true, Some(t)) = (client.is_some(), dernier_envoi) {
                    attente = attente.min(RAFRAICHISSEMENT.saturating_sub(maintenant - t));
                }
                interne = match partage.reveil.wait_timeout(interne, attente) {
                    Ok((garde, _)) => garde,
                    Err(_) => return,
                };
            }
            (interne.voulue.clone(), interne.version)
        };

        // Le rythme de Discord : trop tôt, on attend, puis on relit la
        // dernière activité voulue plutôt que d'envoyer celle-ci.
        if let Some(t) = dernier_envoi {
            let ecoule = t.elapsed();
            if ecoule < INTERVALLE_MIN {
                std::thread::sleep(INTERVALLE_MIN - ecoule);
                continue;
            }
        }

        let Some(activite) = voulue else {
            // Rien à montrer : on efface, et on lâche la connexion — Discord
            // efface de toute façon ce qu'un client parti avait posé.
            if let Some(mut parti) = client.take() {
                let _ = parti.regler(pid, None);
                dernier_envoi = Some(Instant::now());
            }
            envoyee = Some(version);
            noter(partage, version, true, None);
            continue;
        };

        if client.is_none() {
            match ouvrir().and_then(|canal| Client::connecter(canal, id_application)) {
                Ok(nouveau) => client = Some(nouveau),
                Err(erreur) => {
                    prochaine_tentative = Instant::now() + RECONNEXION;
                    noter(partage, version, false, Some(erreur.to_string()));
                    continue;
                }
            }
        }

        let resultat = client
            .as_mut()
            .map_or(Ok(()), |client| client.regler(pid, Some(&activite)));
        dernier_envoi = Some(Instant::now());
        match resultat {
            Ok(()) => {
                envoyee = Some(version);
                noter(partage, version, true, None);
            }
            Err(erreur) => {
                // La connexion est perdue ou refusée : on la refait au
                // prochain tour, et la même activité repart.
                client = None;
                envoyee = None;
                prochaine_tentative = Instant::now() + RECONNEXION;
                noter(partage, version, false, Some(erreur.to_string()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Un faux Discord : ce qu'il répondra, et ce qu'on lui a écrit.
    struct Faux {
        reponses: VecDeque<u8>,
        ecrit: Vec<u8>,
    }

    impl Faux {
        fn new(trames: &[(u32, Value)]) -> Faux {
            let mut reponses = Vec::new();
            for (op, charge) in trames {
                ecrire_trame(&mut reponses, *op, charge).unwrap();
            }
            Faux {
                reponses: reponses.into(),
                ecrit: Vec::new(),
            }
        }

        fn trames_ecrites(&self) -> Vec<(u32, Value)> {
            let mut lecture = &self.ecrit[..];
            let mut trames = Vec::new();
            while !lecture.is_empty() {
                trames.push(lire_trame(&mut lecture).unwrap());
            }
            trames
        }
    }

    impl Read for Faux {
        fn read(&mut self, tampon: &mut [u8]) -> io::Result<usize> {
            self.reponses.read(tampon)
        }
    }

    impl Write for Faux {
        fn write(&mut self, octets: &[u8]) -> io::Result<usize> {
            self.ecrit.extend_from_slice(octets);
            Ok(octets.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn pret() -> (u32, Value) {
        (OP_TRAME, json!({ "cmd": "DISPATCH", "evt": "READY" }))
    }

    fn activite() -> Activite {
        Activite::depuis_json(&json!({
            "details": "Aerin Valcourt, Sylvari Gardienne",
            "etat": "Tient le comptoir",
            "texteImage": "Arche du Lion",
            "debut": 1_700_000_000_000u64,
            "boutons": [{ "libelle": "Fiche du personnage", "url": "https://www.gw2rp.eu/personnages/aerin" }],
        }))
        .unwrap()
    }

    #[test]
    fn une_trame_fait_un_aller_retour() {
        let mut tampon = Vec::new();
        ecrire_trame(&mut tampon, OP_TRAME, &json!({ "a": "é" })).unwrap();
        assert_eq!(&tampon[..4], &1u32.to_le_bytes());
        let (op, charge) = lire_trame(&mut &tampon[..]).unwrap();
        assert_eq!(op, OP_TRAME);
        assert_eq!(charge, json!({ "a": "é" }));
    }

    #[test]
    fn une_longueur_demesuree_ne_s_alloue_pas() {
        let mut tampon = Vec::new();
        tampon.extend_from_slice(&1u32.to_le_bytes());
        tampon.extend_from_slice(&u32::MAX.to_le_bytes());
        let erreur = lire_trame(&mut &tampon[..]).unwrap_err();
        assert_eq!(erreur.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn l_activite_se_borne_aux_limites_de_discord() {
        let long = "a".repeat(300);
        let lue = Activite::depuis_json(&json!({
            "details": long,
            "etat": "x",
            "texteImage": "  Arche   du Lion  ",
            "boutons": [
                { "libelle": "Un", "url": "javascript:alert(1)" },
                { "libelle": "Deux", "url": "https://a.fr" },
                { "libelle": "Trois", "url": "https://b.fr" },
                { "libelle": "Quatre", "url": "https://c.fr" },
            ],
        }))
        .unwrap();
        assert_eq!(lue.details.chars().count(), TEXTE_MAX);
        assert!(lue.details.ends_with('…'));
        // Un seul caractère : Discord refuserait l'activité entière.
        assert_eq!(lue.etat, None);
        assert_eq!(lue.texte_image.as_deref(), Some("Arche du Lion"));
        let libelles: Vec<_> = lue.boutons.iter().map(|b| b.libelle.as_str()).collect();
        assert_eq!(libelles, ["Deux", "Trois"]);
    }

    #[test]
    fn une_activite_sans_premiere_ligne_est_refusee() {
        assert!(Activite::depuis_json(&json!({ "details": " " })).is_err());
        assert!(Activite::depuis_json(&json!("texte")).is_err());
    }

    #[test]
    fn l_activite_parle_la_langue_de_discord() {
        let discord = activite().vers_discord();
        assert_eq!(discord["details"], "Aerin Valcourt, Sylvari Gardienne");
        assert_eq!(discord["state"], "Tient le comptoir");
        assert_eq!(discord["assets"]["large_image"], IMAGE);
        assert_eq!(discord["assets"]["large_text"], "Arche du Lion");
        assert_eq!(discord["timestamps"]["start"], 1_700_000_000_000u64);
        assert_eq!(discord["buttons"][0]["label"], "Fiche du personnage");
    }

    #[test]
    fn le_client_se_presente_puis_pose_l_activite() {
        let faux = Faux::new(&[
            pret(),
            (OP_PING, json!({ "x": 1 })),
            (
                OP_TRAME,
                json!({ "cmd": "SET_ACTIVITY", "nonce": "1", "data": {} }),
            ),
        ]);
        let mut client = Client::connecter(faux, "123").unwrap();
        client.regler(42, Some(&activite())).unwrap();
        let ecrites = client.canal.trames_ecrites();
        assert_eq!(
            ecrites[0],
            (OP_PRESENTATION, json!({ "v": 1, "client_id": "123" }))
        );
        assert_eq!(ecrites[1].0, OP_TRAME);
        assert_eq!(ecrites[1].1["cmd"], "SET_ACTIVITY");
        assert_eq!(ecrites[1].1["args"]["pid"], 42);
        assert_eq!(
            ecrites[1].1["args"]["activity"]["details"],
            "Aerin Valcourt, Sylvari Gardienne"
        );
        // Le ping a reçu son pong, avec la même charge.
        assert_eq!(ecrites[2], (OP_PONG, json!({ "x": 1 })));
    }

    #[test]
    fn effacer_n_envoie_pas_d_activite() {
        let faux = Faux::new(&[pret(), (OP_TRAME, json!({ "nonce": "1" }))]);
        let mut client = Client::connecter(faux, "123").unwrap();
        client.regler(42, None).unwrap();
        let ecrites = client.canal.trames_ecrites();
        assert!(ecrites[1].1["args"].get("activity").is_none());
    }

    #[test]
    fn un_identifiant_refuse_se_dit() {
        let faux = Faux::new(&[(
            OP_FERMETURE,
            json!({ "code": 4000, "message": "Invalid Client ID" }),
        )]);
        let erreur = Client::connecter(faux, "0").err().unwrap();
        assert!(erreur.to_string().contains("Invalid Client ID"));
    }

    #[test]
    fn une_activite_refusee_se_dit() {
        let faux = Faux::new(&[
            pret(),
            (
                OP_TRAME,
                json!({ "nonce": "1", "evt": "ERROR", "data": { "code": 4002, "message": "child \"activity\" fails" } }),
            ),
        ]);
        let mut client = Client::connecter(faux, "123").unwrap();
        let erreur = client.regler(42, Some(&activite())).unwrap_err();
        assert!(erreur.to_string().contains("4002"));
    }

    #[test]
    fn le_fil_signale_un_discord_absent_sans_bloquer() {
        let presence = Presence::demarrer("123".into(), 1, || -> io::Result<Faux> {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Discord n'est pas lancé",
            ))
        });
        presence.regler(Some(activite()));
        let debut = Instant::now();
        while presence.etat().erreur.is_none() && debut.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        let etat = presence.etat();
        assert!(!etat.posee);
        assert!(etat.erreur.unwrap().contains("pas lancé"));
    }

    #[test]
    fn le_fil_pose_l_activite_voulue() {
        let presence = Presence::demarrer("123".into(), 1, || {
            Ok(Faux::new(&[pret(), (OP_TRAME, json!({ "nonce": "1" }))]))
        });
        presence.regler(Some(activite()));
        let debut = Instant::now();
        while !presence.etat().posee && debut.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            presence.etat(),
            Etat {
                posee: true,
                erreur: None
            }
        );
    }
}
