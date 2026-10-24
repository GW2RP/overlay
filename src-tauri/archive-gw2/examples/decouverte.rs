//! Retrouve, dans le contenu de jeu, la définition de chaque décoration du
//! pavillon et les fichiers qu'elle référence — dont, espère-t-on, son modèle.
//!
//! L'API publique donne de chaque décoration son numéro et son icône, rien de
//! plus. L'icône est un fichier de l'archive, et son numéro est dans l'adresse
//! que l'API rend : c'est le fil. On cherche dans le contenu les entrées qui
//! référencent l'icône d'une décoration, puis on relève tout ce qu'elles
//! référencent d'autre, et le type de chaque fichier visé.
//!
//! ```text
//! cargo run --release --example decouverte -- "C:\Program Files\Guild Wars 2\Gw2.dat"
//! ```
//!
//! Le parcours prend plusieurs minutes. Il s'interrompt et reprend : chaque
//! étape range ce qu'elle a fait dans un dossier d'état (`etat-decouverte`),
//! et `--duree <secondes>` l'arrête de lui-même, code de sortie 3, pour être
//! relancé là où il s'était arrêté. Le contenu se lit fichier par fichier,
//! sans tout garder en mémoire.
//!
//! Écrit le rapport complet (`rapport-decouverte.json`) et un résumé sur la
//! sortie.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use archive_gw2::contenu::{lire_contenu, Contenu};
use archive_gw2::pf::type_pf;
use archive_gw2::Archive;
use serde_json::{json, Value};

const A_REPRENDRE: i32 = 3;

struct Decoration {
    id: u32,
    nom: String,
    icone: u32,
}

struct Options {
    archive: String,
    decorations: String,
    rapport: String,
    etat: PathBuf,
    duree: Option<Duration>,
}

fn sortir(message: impl std::fmt::Display) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}

fn lire_options() -> Options {
    let mut positionnels = Vec::new();
    let mut duree = None;
    let mut etat = PathBuf::from("etat-decouverte");
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--duree" => {
                let secondes: u64 = arguments
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| sortir("--duree attend un nombre de secondes"));
                duree = Some(Duration::from_secs(secondes));
            }
            "--etat" => {
                etat = arguments
                    .next()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| sortir("--etat attend un dossier"))
            }
            _ => positionnels.push(argument),
        }
    }
    let Some(archive) = positionnels.first().cloned() else {
        eprintln!("usage : decouverte <Gw2.dat> [decorations.json] [rapport.json] [--etat <dossier>] [--duree <s>]");
        std::process::exit(2);
    };
    Options {
        archive,
        decorations: positionnels.get(1).cloned().unwrap_or_else(|| {
            concat!(env!("CARGO_MANIFEST_DIR"), "/examples/decorations.json").into()
        }),
        rapport: positionnels
            .get(2)
            .cloned()
            .unwrap_or_else(|| "rapport-decouverte.json".into()),
        etat,
        duree,
    }
}

/// Un journal d'étape : une ligne JSON par unité de travail faite, relu à la
/// reprise. Une ligne coupée par un arrêt brutal se jette.
struct Journal {
    fichier: File,
}

impl Journal {
    fn ouvrir(chemin: &Path) -> (Self, Vec<Value>) {
        let lignes = File::open(chemin)
            .map(|f| {
                BufReader::new(f)
                    .lines()
                    .map_while(Result::ok)
                    .filter_map(|l| serde_json::from_str(&l).ok())
                    .collect()
            })
            .unwrap_or_default();
        let fichier = OpenOptions::new()
            .create(true)
            .append(true)
            .open(chemin)
            .unwrap_or_else(|e| sortir(e));
        (Self { fichier }, lignes)
    }

    fn ecrire(&mut self, valeur: &Value) {
        writeln!(self.fichier, "{valeur}").unwrap_or_else(|e| sortir(e));
    }
}

fn main() {
    let options = lire_options();
    let depart = Instant::now();
    let temps_ecoule = || options.duree.is_some_and(|d| depart.elapsed() >= d);
    let interrompre = |etape: &str| -> ! {
        println!(
            "Arrêt au bout de {:.0?}, pendant {etape} : relancer pour reprendre.",
            depart.elapsed()
        );
        std::process::exit(A_REPRENDRE);
    };

    fs::create_dir_all(&options.etat).unwrap_or_else(|e| sortir(e));
    let archive = Archive::ouvrir(&options.archive).unwrap_or_else(|e| sortir(e));
    eprintln!("archive ouverte : {} fichiers", archive.fichiers().len());

    let decorations: Vec<Decoration> = {
        let texte = fs::read_to_string(&options.decorations).unwrap_or_else(|e| sortir(e));
        let valeurs: Vec<Value> = serde_json::from_str(&texte).unwrap_or_else(|e| sortir(e));
        valeurs
            .iter()
            .filter_map(|v| {
                Some(Decoration {
                    id: v["id"].as_u64()? as u32,
                    nom: v["nom"].as_str().unwrap_or_default().to_string(),
                    icone: v["icone"].as_u64()? as u32,
                })
            })
            .collect()
    };

    // Les icônes, par entrée de la table : deux numéros d'un même fichier
    // désignent la même icône.
    let mut par_icone: HashMap<usize, Vec<u32>> = HashMap::new();
    let mut icones_absentes = 0;
    for decoration in &decorations {
        match archive.index_de(decoration.icone) {
            Some(index) => par_icone.entry(index).or_default().push(decoration.id),
            None => icones_absentes += 1,
        }
    }
    eprintln!(
        "{} décorations, {} icônes retrouvées dans l'archive, {} absentes",
        decorations.len(),
        par_icone.len(),
        icones_absentes
    );

    // 1. Le type de chaque fichier, sur ses douze premiers octets. Le journal
    // range les fichiers par lots de mille : un lot par ligne.
    const LOT: usize = 1000;
    let (mut journal, faits) = Journal::ouvrir(&options.etat.join("1-entetes.jsonl"));
    let mut types: HashMap<usize, [u8; 4]> = HashMap::new();
    let mut lots_faits = HashSet::new();
    for lot in &faits {
        lots_faits.insert(lot["lot"].as_u64().unwrap_or(u64::MAX) as usize);
        for paire in lot["types"].as_array().into_iter().flatten() {
            let (Some(entree), Some(type_)) = (paire[0].as_u64(), paire[1].as_str()) else {
                continue;
            };
            let mut octets = [0u8; 4];
            for (i, o) in type_.bytes().take(4).enumerate() {
                octets[i] = o;
            }
            types.insert(entree as usize, octets);
        }
    }
    let fichiers = archive.fichiers();
    for (n, lot) in fichiers.chunks(LOT).enumerate() {
        if lots_faits.contains(&n) {
            continue;
        }
        if temps_ecoule() {
            interrompre("la lecture des en-têtes");
        }
        if n % 20 == 0 {
            eprintln!(
                "  en-têtes : {} / {} ({:.0?})",
                n * LOT,
                fichiers.len(),
                depart.elapsed()
            );
        }
        let mut lus = Vec::new();
        for fichier in lot {
            let Ok(debut) = archive.lire_debut(fichier.base, Some(12)) else {
                continue;
            };
            let Some(type_) = type_pf(&debut) else {
                continue;
            };
            types.insert(fichier.entree, type_);
            lus.push(json!([fichier.entree, String::from_utf8_lossy(&type_)]));
        }
        journal.ecrire(&json!({ "lot": n, "types": lus }));
    }
    let bases_contenu: Vec<u32> = fichiers
        .iter()
        .filter(|f| types.get(&f.entree) == Some(b"cntc"))
        .map(|f| f.base)
        .collect();
    eprintln!(
        "{} fichiers PF, {} de contenu ({:.0?})",
        types.len(),
        bases_contenu.len(),
        depart.elapsed()
    );

    let type_de = |numero: u32| -> String {
        archive
            .index_de(numero)
            .and_then(|i| types.get(&i))
            .map(|t| {
                String::from_utf8_lossy(t)
                    .trim_end_matches('\0')
                    .to_string()
            })
            .unwrap_or_else(|| "?".into())
    };

    // Les fichiers qu'une entrée référence, avec leur décalage dans l'entrée.
    let references =
        |contenu: &Contenu, table: &[Option<u32>], debut: usize, fin: usize| -> Vec<(usize, u32)> {
            let i = contenu.renvois_fichiers.partition_point(|p| *p < debut);
            contenu.renvois_fichiers[i..]
                .iter()
                .take_while(|p| **p < fin)
                .filter_map(|&position| {
                    let index = contenu.u32_a(position)? as usize;
                    let numero = (*table.get(index)?)?;
                    Some((position - debut, numero))
                })
                .collect()
        };
    let decrire = |refs: &[(usize, u32)]| -> Vec<Value> {
        refs.iter()
            .map(|(d, n)| json!({ "decalage": d, "fichier": n, "type": type_de(*n) }))
            .collect()
    };
    let lire = |base: u32| -> Option<Contenu> {
        match archive.lire(base).map(|octets| lire_contenu(&octets)) {
            Ok(Ok(contenu)) => contenu,
            Ok(Err(e)) => {
                eprintln!("  contenu {base} illisible : {e}");
                None
            }
            Err(e) => {
                eprintln!("  {e}");
                None
            }
        }
    };

    // 2. Les entrées qui référencent une icône de décoration. Le paquet
    // courant est le dernier fichier lu qui porte une table des types ; sa
    // table des fichiers se range dans le journal pour la reprise.
    let ids_de_decorations: HashSet<u32> = decorations.iter().map(|d| d.id).collect();
    let (mut journal, faits) = Journal::ouvrir(&options.etat.join("2-contenu.jsonl"));
    let mut tables: BTreeMap<u32, Vec<Option<u32>>> = BTreeMap::new();
    let mut lignes_contenu: BTreeMap<u32, Value> = BTreeMap::new();
    for ligne in faits {
        let base = ligne["base"].as_u64().unwrap_or_default() as u32;
        if let Some(table) = ligne["table"].as_array() {
            tables.insert(
                base,
                table.iter().map(|v| v.as_u64().map(|n| n as u32)).collect(),
            );
        }
        lignes_contenu.insert(base, ligne);
    }

    for (i, &base) in bases_contenu.iter().enumerate() {
        if lignes_contenu.contains_key(&base) {
            continue;
        }
        if temps_ecoule() {
            interrompre("la lecture du contenu");
        }
        if i % 100 == 0 {
            eprintln!(
                "  contenu : {i} / {} ({:.0?})",
                bases_contenu.len(),
                depart.elapsed()
            );
        }
        let Some(contenu) = lire(base) else {
            let ligne = json!({ "base": base, "illisible": true });
            journal.ecrire(&ligne);
            lignes_contenu.insert(base, ligne);
            continue;
        };
        let est_paquet = contenu.est_un_paquet();
        if est_paquet {
            tables.insert(base, contenu.fichiers.clone());
        }
        let Some((&paquet, table)) = tables.range(..=base).next_back() else {
            let ligne = json!({ "base": base, "sans_paquet": true });
            journal.ecrire(&ligne);
            lignes_contenu.insert(base, ligne);
            continue;
        };

        let mut candidats = Vec::new();
        for entree in &contenu.entrees {
            let refs = references(&contenu, table, entree.debut, entree.fin);
            let decos: Vec<u32> = refs
                .iter()
                .filter_map(|(_, numero)| archive.index_de(*numero).and_then(|i| par_icone.get(&i)))
                .flatten()
                .copied()
                .collect();
            if decos.is_empty() {
                continue;
            }
            let octets = contenu.octets_de(entree);
            let id_donnees = octets
                .get(40..44)
                .map(|o| u32::from_le_bytes([o[0], o[1], o[2], o[3]]));

            let j = contenu
                .renvois_externes
                .partition_point(|r| r.position < entree.debut);
            let renvois: Vec<Value> = contenu.renvois_externes[j..]
                .iter()
                .take_while(|r| r.position < entree.fin)
                .filter_map(|r| {
                    Some(json!({
                        "decalage": r.position - entree.debut,
                        "fichier": paquet + r.fichier_cible,
                        "position": contenu.u32_a(r.position)?,
                    }))
                })
                .collect();

            candidats.push(json!({
                "fichier": base,
                "paquet": paquet,
                "type": entree.type_,
                "debut": entree.debut,
                "taille": entree.fin - entree.debut,
                "id_donnees": id_donnees,
                "id_donnees_est_une_decoration": id_donnees.is_some_and(|id| ids_de_decorations.contains(&id)),
                "decorations": decos,
                "references": decrire(&refs),
                "octets": octets.iter().take(256).map(|o| format!("{o:02x}")).collect::<String>(),
                "renvois": renvois,
            }));
        }

        let mut ligne = json!({ "base": base, "candidats": candidats });
        if est_paquet {
            ligne["table"] = json!(contenu.fichiers);
        }
        journal.ecrire(&ligne);
        lignes_contenu.insert(base, ligne);
    }

    let mut candidats: Vec<Value> = lignes_contenu
        .values()
        .flat_map(|l| l["candidats"].as_array().cloned().unwrap_or_default())
        .collect();
    eprintln!(
        "{} entrées candidates ({:.0?})",
        candidats.len(),
        depart.elapsed()
    );

    // 3. Les entrées que les candidates désignent, fichier par fichier.
    let (mut journal, faits) = Journal::ouvrir(&options.etat.join("3-renvois.jsonl"));
    let mut resolus: HashMap<(u32, u64), Value> = HashMap::new();
    let mut cibles_faites = HashSet::new();
    for ligne in faits {
        let cible = ligne["fichier"].as_u64().unwrap_or_default() as u32;
        cibles_faites.insert(cible);
        for entree in ligne["entrees"].as_array().into_iter().flatten() {
            resolus.insert(
                (cible, entree["position"].as_u64().unwrap_or_default()),
                entree.clone(),
            );
        }
    }
    let mut a_resoudre: BTreeMap<u32, BTreeSet<(u64, u32)>> = BTreeMap::new();
    for candidat in &candidats {
        let paquet = candidat["paquet"].as_u64().unwrap_or_default() as u32;
        for renvoi in candidat["renvois"].as_array().into_iter().flatten() {
            let cible = renvoi["fichier"].as_u64().unwrap_or_default() as u32;
            let position = renvoi["position"].as_u64().unwrap_or_default();
            a_resoudre
                .entry(cible)
                .or_default()
                .insert((position, paquet));
        }
    }
    for (cible, positions) in &a_resoudre {
        if cibles_faites.contains(cible) {
            continue;
        }
        if temps_ecoule() {
            interrompre("la résolution des renvois");
        }
        let mut entrees = Vec::new();
        if let Some(contenu) = lire(*cible) {
            for &(position, paquet) in positions {
                let Some(entree) = contenu.entree_a(position as usize) else {
                    continue;
                };
                let Some(table) = tables.get(&paquet) else {
                    continue;
                };
                let refs = references(&contenu, table, entree.debut, entree.fin);
                let octets = contenu.octets_de(entree);
                let valeur = json!({
                    "position": position,
                    "type": entree.type_,
                    "debut": entree.debut,
                    "taille": entree.fin - entree.debut,
                    "references": decrire(&refs),
                    "octets": octets.iter().take(128).map(|o| format!("{o:02x}")).collect::<String>(),
                });
                resolus.insert((*cible, position), valeur.clone());
                entrees.push(valeur);
            }
        }
        journal.ecrire(&json!({ "fichier": cible, "entrees": entrees }));
    }
    for candidat in &mut candidats {
        let externes: Vec<Value> = candidat["renvois"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                let cible = r["fichier"].as_u64()? as u32;
                let mut valeur = resolus.get(&(cible, r["position"].as_u64()?))?.clone();
                valeur["decalage"] = r["decalage"].clone();
                valeur["fichier"] = json!(cible);
                Some(valeur)
            })
            .collect();
        candidat["externes"] = json!(externes);
    }

    // 4. Le résumé : quel type d'entrée porte les décorations, et à quels
    // décalages ses références visent des modèles.
    let mut par_type: BTreeMap<u64, usize> = BTreeMap::new();
    for candidat in &candidats {
        *par_type
            .entry(candidat["type"].as_u64().unwrap_or_default())
            .or_default() += 1;
    }
    println!("Entrées qui référencent une icône de décoration, par type :");
    for (type_, n) in &par_type {
        println!("  type {type_:>4} : {n}");
    }
    let mut histogramme: BTreeMap<String, usize> = BTreeMap::new();
    for candidat in &candidats {
        let type_ = &candidat["type"];
        for reference in candidat["references"].as_array().into_iter().flatten() {
            *histogramme
                .entry(format!(
                    "type {type_} +{} → {}",
                    reference["decalage"], reference["type"]
                ))
                .or_default() += 1;
        }
        for externe in candidat["externes"].as_array().into_iter().flatten() {
            *histogramme
                .entry(format!(
                    "type {type_} +{} ⇒ entrée de type {}",
                    externe["decalage"], externe["type"]
                ))
                .or_default() += 1;
            for reference in externe["references"].as_array().into_iter().flatten() {
                *histogramme
                    .entry(format!(
                        "type {type_} +{} ⇒ type {} +{} → {}",
                        externe["decalage"],
                        externe["type"],
                        reference["decalage"],
                        reference["type"]
                    ))
                    .or_default() += 1;
            }
        }
    }
    let mut lignes: Vec<_> = histogramme.into_iter().collect();
    lignes.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    println!("\nRéférences les plus fréquentes :");
    for (ligne, n) in lignes.iter().take(80) {
        println!("  {n:>6}  {ligne}");
    }

    let trouvees: HashSet<u64> = candidats
        .iter()
        .flat_map(|c| c["decorations"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.as_u64())
        .collect();
    println!(
        "\n{} décorations sur {} retrouvées par leur icône ({:.0?}).",
        trouvees.len(),
        decorations.len(),
        depart.elapsed()
    );

    let noms: HashMap<u32, &str> = decorations.iter().map(|d| (d.id, d.nom.as_str())).collect();
    let rapport = json!({
        "fichiers_de_contenu": bases_contenu,
        "paquets": tables.keys().collect::<Vec<_>>(),
        "par_type": par_type,
        "candidats": candidats,
        "noms": noms,
    });
    fs::write(
        &options.rapport,
        serde_json::to_string_pretty(&rapport).unwrap(),
    )
    .unwrap_or_else(|e| sortir(e));
    println!("Rapport complet : {}", options.rapport);
}
