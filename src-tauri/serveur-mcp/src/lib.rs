//! Un serveur MCP local : le protocole que Claude parle à ses outils, servi en
//! HTTP sur la boucle locale.
//!
//! Le crate ne connaît aucun outil. Il reçoit leurs définitions telles que le
//! protocole les écrit, et une implémentation d'`Outils` qui les exécute ; il
//! tient le reste — la négociation, la liste, l'appel, les erreurs.
//!
//! Le transport est le « HTTP en flux » du protocole, réduit à ce qu'un client
//! local demande : un `POST` par message, et une réponse JSON entière. Le
//! serveur n'ouvre pas de flux d'évènements (`GET` rend 405, ce que le
//! protocole prévoit) : il n'a rien à pousser de lui-même.
//!
//! Trois garde-fous, parce qu'un port local s'atteint aussi depuis une page
//! web ouverte sur la même machine :
//!
//! - **la boucle locale seulement** : le serveur n'écoute que `127.0.0.1` ;
//! - **l'hôte et l'origine** : une requête dont l'en-tête `Host` ne nomme pas
//!   la boucle locale vient d'un nom de domaine rebranché sur elle, et une
//!   origine étrangère vient d'une page. Les deux sont refusées ;
//! - **le jeton** : chaque requête porte `Authorization: Bearer <jeton>`. Une
//!   page ne le connaît pas, et un autre programme de la machine non plus.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Les versions du protocole que ce serveur parle, la plus récente d'abord.
/// Un client qui en demande une autre reçoit la première, et décide.
pub const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Le seul chemin servi.
pub const CHEMIN: &str = "/mcp";

/// Un message porte au plus une disposition entière en texte : quelques
/// dizaines de kilo-octets d'ordinaire, seize mégaoctets au pire.
const CORPS_MAX: usize = 24 * 1024 * 1024;
const ENTETES_MAX: usize = 16 * 1024;

/// Le temps qu'on laisse à un client pour écrire sa requête **entière**, et
/// pour lire la réponse. L'exécution d'un outil n'y compte pas. Un délai par
/// lecture ne suffirait pas : un octet toutes les vingt-neuf secondes tiendrait
/// un fil des heures.
const DELAI_RESEAU: Duration = Duration::from_secs(30);

/// Les requêtes servies de front. Au-delà, la connexion se ferme sans
/// réponse : un client local en tient une ou deux, et chaque requête coûte un
/// fil.
const CONNEXIONS_MAX: usize = 16;

/// Le rythme auquel le fil d'écoute regarde s'il doit s'arrêter.
const VEILLE: Duration = Duration::from_millis(100);

/// Ce qu'un appel d'outil rend : le contenu du protocole (`text`, `image`…),
/// ou une phrase d'erreur, que le client reçoit en `isError`.
pub type Resultat = Result<Vec<Value>, String>;

/// L'exécution des outils. Chaque requête a son fil : `appeler` peut
/// bloquer le temps qu'il faut.
pub trait Outils: Send + Sync + 'static {
    fn appeler(&self, nom: &str, arguments: Value) -> Resultat;
}

/// Ce que le serveur dit de lui à l'initialisation.
#[derive(Clone)]
pub struct Description {
    pub nom: String,
    pub version: String,
    /// Le mode d'emploi que le client montre au modèle.
    pub instructions: String,
    /// Les définitions des outils, telles que `tools/list` les rend.
    pub outils: Vec<Value>,
}

/// Un serveur qui écoute. Le lâcher l'arrête.
pub struct Serveur {
    adresse: SocketAddr,
    arret: Arc<AtomicBool>,
    fil: Option<JoinHandle<()>>,
}

impl Serveur {
    /// Écoute `127.0.0.1:port` (`0` : un port libre, pour les tests).
    pub fn demarrer(
        port: u16,
        jeton: String,
        description: Description,
        outils: Arc<dyn Outils>,
    ) -> io::Result<Serveur> {
        let ecoute = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        // Sans attente : le fil regarde régulièrement s'il doit s'arrêter, au
        // lieu de rester pendu sur `accept`.
        ecoute.set_nonblocking(true)?;
        let adresse = ecoute.local_addr()?;
        let arret = Arc::new(AtomicBool::new(false));
        let contexte = Arc::new(Contexte {
            port: adresse.port(),
            jeton,
            description,
            outils,
        });

        let arret_fil = arret.clone();
        let en_cours = Arc::new(AtomicUsize::new(0));
        let fil = std::thread::Builder::new()
            .name("serveur-mcp".into())
            .spawn(move || {
                while !arret_fil.load(Ordering::Relaxed) {
                    match ecoute.accept() {
                        Ok((flux, _)) => {
                            if en_cours.fetch_add(1, Ordering::AcqRel) >= CONNEXIONS_MAX {
                                en_cours.fetch_sub(1, Ordering::AcqRel);
                                continue;
                            }
                            let place = Place(en_cours.clone());
                            let contexte = contexte.clone();
                            let lance = std::thread::Builder::new()
                                .name("requete-mcp".into())
                                .spawn(move || {
                                    let _place = place;
                                    servir(flux, &contexte)
                                });
                            if let Err(erreur) = lance {
                                eprintln!("une requête MCP n'a pas pu être servie : {erreur}");
                            }
                        }
                        Err(erreur) if erreur.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(VEILLE);
                        }
                        Err(erreur) => {
                            eprintln!("le serveur MCP n'accepte plus : {erreur}");
                            std::thread::sleep(VEILLE);
                        }
                    }
                }
            })?;

        Ok(Serveur {
            adresse,
            arret,
            fil: Some(fil),
        })
    }

    pub fn adresse(&self) -> SocketAddr {
        self.adresse
    }
}

impl Drop for Serveur {
    fn drop(&mut self) {
        self.arret.store(true, Ordering::Relaxed);
        if let Some(fil) = self.fil.take() {
            let _ = fil.join();
        }
    }
}

/// Une requête en cours : rendue en partant, quoi qu'il arrive au fil.
struct Place(Arc<AtomicUsize>);

impl Drop for Place {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Contexte {
    port: u16,
    jeton: String,
    description: Description,
    outils: Arc<dyn Outils>,
}

/* --- HTTP ------------------------------------------------------------------- */

struct Reponse {
    statut: u16,
    entetes: Vec<(&'static str, String)>,
    corps: Vec<u8>,
}

impl Reponse {
    fn vide(statut: u16) -> Reponse {
        Reponse {
            statut,
            entetes: Vec::new(),
            corps: Vec::new(),
        }
    }

    fn json(statut: u16, valeur: &Value) -> Reponse {
        Reponse {
            statut,
            entetes: vec![("Content-Type", "application/json".into())],
            corps: valeur.to_string().into_bytes(),
        }
    }

    fn texte(statut: u16, texte: &str) -> Reponse {
        Reponse {
            statut,
            entetes: vec![("Content-Type", "text/plain; charset=utf-8".into())],
            corps: texte.as_bytes().to_vec(),
        }
    }

    fn avec(mut self, nom: &'static str, valeur: &str) -> Reponse {
        self.entetes.push((nom, valeur.to_string()));
        self
    }
}

fn servir(flux: TcpStream, contexte: &Contexte) {
    // Le flux accepté hérite de l'écoute sans attente : on le veut bloquant,
    // borné dans le temps.
    let prepare = flux
        .set_nonblocking(false)
        .and_then(|()| flux.set_write_timeout(Some(DELAI_RESEAU)));
    if prepare.is_err() {
        return;
    }
    let borne = Borne {
        flux: &flux,
        fin: Instant::now() + DELAI_RESEAU,
    };
    let reponse = match lire_requete(borne, contexte) {
        Ok(corps) => repondre(&corps, contexte),
        Err(reponse) => reponse,
    };
    let _ = ecrire_reponse(&flux, reponse);
}

/// Le flux, dont chaque lecture n'a que le temps qui reste à la requête.
struct Borne<'a> {
    flux: &'a TcpStream,
    fin: Instant,
}

impl Read for Borne<'_> {
    fn read(&mut self, tampon: &mut [u8]) -> io::Result<usize> {
        let reste = self
            .fin
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "délai écoulé"))?;
        self.flux.set_read_timeout(Some(reste))?;
        (&*self.flux).read(tampon)
    }
}

/// Lit la requête. Le corps ne se lit — ni ne s'alloue — qu'une fois l'hôte,
/// l'origine et le jeton vérifiés : un inconnu n'obtient pas vingt-quatre
/// mégaoctets en annonçant leur longueur.
fn lire_requete(flux: Borne<'_>, contexte: &Contexte) -> Result<Vec<u8>, Reponse> {
    let mut lecteur = BufReader::new(flux);
    let mut ligne = String::new();
    let mut lus = 0usize;
    let mut lire_ligne = |ligne: &mut String| -> Result<(), Reponse> {
        ligne.clear();
        let n = (&mut lecteur)
            .take((ENTETES_MAX - lus.min(ENTETES_MAX)) as u64)
            .read_line(ligne)
            .map_err(|_| Reponse::vide(400))?;
        lus += n;
        if n == 0 || !ligne.ends_with('\n') {
            return Err(Reponse::vide(if lus >= ENTETES_MAX { 431 } else { 400 }));
        }
        Ok(())
    };

    lire_ligne(&mut ligne)?;
    let mut morceaux = ligne.split_whitespace();
    let (Some(methode), Some(cible)) = (morceaux.next(), morceaux.next()) else {
        return Err(Reponse::vide(400));
    };
    let methode = methode.to_string();
    let chemin = cible.split('?').next().unwrap_or_default().to_string();

    let mut entetes = HashMap::new();
    loop {
        lire_ligne(&mut ligne)?;
        let propre = ligne.trim_end_matches(['\r', '\n']);
        if propre.is_empty() {
            break;
        }
        let Some((nom, valeur)) = propre.split_once(':') else {
            return Err(Reponse::vide(400));
        };
        entetes.insert(nom.trim().to_ascii_lowercase(), valeur.trim().to_string());
    }

    controler(&methode, &chemin, &entetes, contexte)?;

    // Le corps se lit sur sa longueur annoncée. Un client local écrit un
    // corps entier ; le découpage en morceaux n'est pas servi.
    if entetes.contains_key("transfer-encoding") {
        return Err(Reponse::vide(411));
    }
    let longueur = match entetes.get("content-length") {
        Some(valeur) => valeur.parse::<usize>().map_err(|_| Reponse::vide(400))?,
        None => 0,
    };
    if longueur > CORPS_MAX {
        return Err(Reponse::vide(413));
    }
    let mut corps = vec![0; longueur];
    lecteur
        .read_exact(&mut corps)
        .map_err(|_| Reponse::vide(400))?;

    Ok(corps)
}

fn ecrire_reponse(mut flux: &TcpStream, reponse: Reponse) -> io::Result<()> {
    let mut tete = format!("HTTP/1.1 {} {}\r\n", reponse.statut, raison(reponse.statut));
    for (nom, valeur) in &reponse.entetes {
        tete.push_str(&format!("{nom}: {valeur}\r\n"));
    }
    tete.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        reponse.corps.len()
    ));
    flux.write_all(tete.as_bytes())?;
    flux.write_all(&reponse.corps)?;
    flux.flush()
}

fn raison(statut: u16) -> &'static str {
    match statut {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "",
    }
}

/// L'en-tête `Host` ne nomme que la boucle locale, au port écouté : un autre
/// nom est celui d'un domaine qu'une page a fait pointer ici.
fn hote_local(hote: Option<&String>, port: u16) -> bool {
    let Some(hote) = hote else {
        return false;
    };
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|nom| hote.eq_ignore_ascii_case(&format!("{nom}:{port}")))
}

/// Pas d'origine : un programme, pas une page. Une origine : seulement la
/// boucle locale elle-même.
fn origine_admise(origine: Option<&String>) -> bool {
    let Some(origine) = origine else {
        return true;
    };
    let sans_schema = origine
        .strip_prefix("http://")
        .or_else(|| origine.strip_prefix("https://"));
    let Some(reste) = sans_schema else {
        return false;
    };
    let hote = reste.split(':').next().unwrap_or_default();
    hote == "127.0.0.1" || hote.eq_ignore_ascii_case("localhost")
}

/// Une comparaison qui ne s'arrête pas au premier octet différent : le temps
/// de réponse ne dit pas combien d'octets d'un jeton deviné étaient justes.
fn egaux(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn autorise(entete: Option<&String>, jeton: &str) -> bool {
    let Some(valeur) = entete else {
        return false;
    };
    let Some((schema, recu)) = valeur.split_once(' ') else {
        return false;
    };
    !jeton.is_empty()
        && schema.eq_ignore_ascii_case("bearer")
        && egaux(recu.trim().as_bytes(), jeton.as_bytes())
}

fn controler(
    methode: &str,
    chemin: &str,
    entetes: &HashMap<String, String>,
    contexte: &Contexte,
) -> Result<(), Reponse> {
    if chemin != CHEMIN {
        return Err(Reponse::vide(404));
    }
    if !hote_local(entetes.get("host"), contexte.port) {
        return Err(Reponse::texte(403, "hôte refusé"));
    }
    if !origine_admise(entetes.get("origin")) {
        return Err(Reponse::texte(403, "origine refusée"));
    }
    if !autorise(entetes.get("authorization"), &contexte.jeton) {
        return Err(Reponse::texte(401, "jeton absent ou faux").avec("WWW-Authenticate", "Bearer"));
    }
    if methode != "POST" {
        return Err(Reponse::vide(405).avec("Allow", "POST"));
    }
    Ok(())
}

/// Une requête vérifiée : son corps, message ou lot de messages JSON-RPC.
fn repondre(corps: &[u8], contexte: &Contexte) -> Reponse {
    let message: Value = match serde_json::from_slice(corps) {
        Ok(message) => message,
        Err(_) => {
            return Reponse::json(400, &erreur(Value::Null, -32700, "message JSON illisible"));
        }
    };
    let reponses: Vec<Value> = match &message {
        Value::Array(lot) => lot.iter().filter_map(|m| traiter(m, contexte)).collect(),
        _ => traiter(&message, contexte).into_iter().collect(),
    };
    match (message.is_array(), reponses.len()) {
        (_, 0) => Reponse::vide(202),
        (false, _) => Reponse::json(200, &reponses[0]),
        (true, _) => Reponse::json(200, &Value::Array(reponses)),
    }
}

/* --- JSON-RPC ----------------------------------------------------------------- */

fn erreur(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn succes(id: Value, resultat: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": resultat })
}

/// Un message : sa réponse, ou rien pour une notification ou une réponse du
/// client.
fn traiter(message: &Value, contexte: &Contexte) -> Option<Value> {
    let Some(objet) = message.as_object() else {
        return Some(erreur(Value::Null, -32600, "requête invalide"));
    };
    let methode = objet.get("method").and_then(Value::as_str);
    let id = objet.get("id").cloned();
    let (Some(methode), Some(id)) = (methode, id) else {
        // `notifications/initialized`, `notifications/cancelled`, ou la
        // réponse du client à une requête que ce serveur n'envoie jamais.
        return None;
    };
    let parametres = objet.get("params").cloned().unwrap_or(Value::Null);
    let description = &contexte.description;

    Some(match methode {
        "initialize" => {
            let demandee = parametres.get("protocolVersion").and_then(Value::as_str);
            let version = demandee
                .filter(|v| VERSIONS.contains(v))
                .unwrap_or(VERSIONS[0]);
            succes(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": description.nom, "version": description.version },
                    "instructions": description.instructions,
                }),
            )
        }
        "ping" => succes(id, json!({})),
        "tools/list" => succes(id, json!({ "tools": description.outils })),
        "tools/call" => {
            let Some(nom) = parametres.get("name").and_then(Value::as_str) else {
                return Some(erreur(id, -32602, "outil sans nom"));
            };
            let connu = description
                .outils
                .iter()
                .any(|o| o.get("name").and_then(Value::as_str) == Some(nom));
            if !connu {
                return Some(erreur(id, -32602, &format!("outil inconnu : {nom}")));
            }
            let arguments = match parametres.get("arguments") {
                None | Some(Value::Null) => json!({}),
                Some(arguments) => arguments.clone(),
            };
            let resultat = match contexte.outils.appeler(nom, arguments) {
                Ok(contenu) => json!({ "content": contenu, "isError": false }),
                Err(phrase) => json!({
                    "content": [{ "type": "text", "text": phrase }],
                    "isError": true,
                }),
            };
            succes(id, resultat)
        }
        _ => erreur(id, -32601, &format!("méthode inconnue : {methode}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo;

    impl Outils for Echo {
        fn appeler(&self, nom: &str, arguments: Value) -> Resultat {
            match nom {
                "echo" => Ok(vec![
                    json!({ "type": "text", "text": arguments.to_string() }),
                ]),
                _ => Err("refusé".into()),
            }
        }
    }

    const JETON: &str = "secret-de-test";

    fn serveur() -> Serveur {
        let description = Description {
            nom: "essai".into(),
            version: "0.0.0".into(),
            instructions: "mode d'emploi".into(),
            outils: vec![
                json!({ "name": "echo", "inputSchema": { "type": "object" } }),
                json!({ "name": "refus", "inputSchema": { "type": "object" } }),
            ],
        };
        Serveur::demarrer(0, JETON.into(), description, Arc::new(Echo)).expect("le serveur démarre")
    }

    /// Une requête brute, et la réponse entière : statut, en-têtes, corps.
    fn envoyer(
        serveur: &Serveur,
        methode: &str,
        entetes: &[(&str, String)],
        corps: &str,
    ) -> (u16, String, String) {
        let mut flux = TcpStream::connect(serveur.adresse()).unwrap();
        let mut texte = format!("{methode} {CHEMIN} HTTP/1.1\r\n");
        for (nom, valeur) in entetes {
            texte.push_str(&format!("{nom}: {valeur}\r\n"));
        }
        texte.push_str(&format!("Content-Length: {}\r\n\r\n{corps}", corps.len()));
        flux.write_all(texte.as_bytes()).unwrap();
        let mut reponse = String::new();
        flux.read_to_string(&mut reponse).unwrap();
        let (tete, corps) = reponse.split_once("\r\n\r\n").unwrap();
        let statut = tete.split_whitespace().nth(1).unwrap().parse().unwrap();
        (statut, tete.to_string(), corps.to_string())
    }

    fn entetes(serveur: &Serveur) -> Vec<(&'static str, String)> {
        vec![
            ("Host", format!("127.0.0.1:{}", serveur.adresse().port())),
            ("Authorization", format!("Bearer {JETON}")),
            ("Content-Type", "application/json".into()),
        ]
    }

    fn appel(serveur: &Serveur, corps: Value) -> (u16, Value) {
        let (statut, _, texte) = envoyer(serveur, "POST", &entetes(serveur), &corps.to_string());
        (statut, serde_json::from_str(&texte).unwrap_or(Value::Null))
    }

    #[test]
    fn l_initialisation_negocie_la_version() {
        let s = serveur();
        let (statut, reponse) = appel(
            &s,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }),
        );
        assert_eq!(statut, 200);
        assert_eq!(reponse["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reponse["result"]["serverInfo"]["name"], "essai");
        assert_eq!(reponse["result"]["instructions"], "mode d'emploi");

        let (_, reponse) = appel(
            &s,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }),
        );
        assert_eq!(reponse["result"]["protocolVersion"], VERSIONS[0]);
    }

    #[test]
    fn une_notification_n_a_pas_de_reponse() {
        let s = serveur();
        let (statut, _, corps) = envoyer(
            &s,
            "POST",
            &entetes(&s),
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        );
        assert_eq!(statut, 202);
        assert!(corps.is_empty());
    }

    #[test]
    fn les_outils_se_listent_et_s_appellent() {
        let s = serveur();
        let (_, liste) = appel(
            &s,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        );
        assert_eq!(liste["result"]["tools"].as_array().unwrap().len(), 2);

        let (_, reponse) = appel(
            &s,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "echo", "arguments": { "a": 1 } } }),
        );
        assert_eq!(reponse["id"], 2);
        assert_eq!(reponse["result"]["isError"], false);
        assert_eq!(reponse["result"]["content"][0]["text"], r#"{"a":1}"#);

        let (_, reponse) = appel(
            &s,
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "refus" } }),
        );
        assert_eq!(reponse["result"]["isError"], true);
        assert_eq!(reponse["result"]["content"][0]["text"], "refusé");

        let (_, reponse) = appel(
            &s,
            json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "absent" } }),
        );
        assert_eq!(reponse["error"]["code"], -32602);

        let (_, reponse) = appel(
            &s,
            json!({ "jsonrpc": "2.0", "id": 5, "method": "resources/list" }),
        );
        assert_eq!(reponse["error"]["code"], -32601);
    }

    #[test]
    fn un_message_illisible_est_refuse() {
        let s = serveur();
        let (statut, _, corps) = envoyer(&s, "POST", &entetes(&s), "{pas du json");
        assert_eq!(statut, 400);
        assert!(corps.contains("-32700"));
    }

    #[test]
    fn sans_le_jeton_rien_ne_passe() {
        let s = serveur();
        let corps = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let hote = ("Host", format!("127.0.0.1:{}", s.adresse().port()));

        let (statut, tete, _) = envoyer(&s, "POST", std::slice::from_ref(&hote), corps);
        assert_eq!(statut, 401);
        assert!(tete.contains("WWW-Authenticate: Bearer"));

        let faux = ("Authorization", "Bearer secret-de-tesT".to_string());
        let (statut, _, _) = envoyer(&s, "POST", &[hote.clone(), faux], corps);
        assert_eq!(statut, 401);

        let bon = ("Authorization", format!("Bearer {JETON}"));
        let (statut, _, _) = envoyer(&s, "POST", &[hote, bon], corps);
        assert_eq!(statut, 200);
    }

    #[test]
    fn une_page_web_est_refusee() {
        let s = serveur();
        let corps = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;

        // Un domaine rebranché sur la boucle locale.
        let mut rebranche = entetes(&s);
        rebranche[0].1 = format!("attaque.example:{}", s.adresse().port());
        assert_eq!(envoyer(&s, "POST", &rebranche, corps).0, 403);

        // Une page d'ailleurs.
        let mut page = entetes(&s);
        page.push(("Origin", "https://attaque.example".into()));
        assert_eq!(envoyer(&s, "POST", &page, corps).0, 403);

        // La boucle locale elle-même.
        let mut locale = entetes(&s);
        locale.push(("Origin", format!("http://localhost:{}", s.adresse().port())));
        assert_eq!(envoyer(&s, "POST", &locale, corps).0, 200);
    }

    #[test]
    fn seul_post_sur_le_chemin_est_servi() {
        let s = serveur();
        let (statut, tete, _) = envoyer(&s, "GET", &entetes(&s), "");
        assert_eq!(statut, 405);
        assert!(tete.contains("Allow: POST"));

        let mut flux = TcpStream::connect(s.adresse()).unwrap();
        flux.write_all(b"POST /ailleurs HTTP/1.1\r\nContent-Length: 0\r\n\r\n")
            .unwrap();
        let mut reponse = String::new();
        flux.read_to_string(&mut reponse).unwrap();
        assert!(reponse.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn un_inconnu_est_refuse_avant_son_corps() {
        let s = serveur();
        let mut flux = TcpStream::connect(s.adresse()).unwrap();
        // Une longueur annoncée, et rien derrière : la réponse part sans
        // attendre le corps.
        let tete = format!(
            "POST {CHEMIN} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 20000000\r\n\r\n",
            s.adresse().port()
        );
        flux.write_all(tete.as_bytes()).unwrap();
        flux.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut reponse = String::new();
        flux.read_to_string(&mut reponse).unwrap();
        assert!(reponse.starts_with("HTTP/1.1 401"), "{reponse}");
    }

    #[test]
    fn un_lot_rend_un_lot() {
        let s = serveur();
        let (statut, reponse) = appel(
            &s,
            json!([
                { "jsonrpc": "2.0", "id": 1, "method": "ping" },
                { "jsonrpc": "2.0", "method": "notifications/initialized" },
                { "jsonrpc": "2.0", "id": 2, "method": "ping" },
            ]),
        );
        assert_eq!(statut, 200);
        assert_eq!(reponse.as_array().unwrap().len(), 2);
    }

    #[test]
    fn lache_le_serveur_s_arrete() {
        let s = serveur();
        let adresse = s.adresse();
        drop(s);
        assert!(TcpStream::connect(adresse).is_err());
    }
}
