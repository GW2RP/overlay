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
//! Écrit `rapport-decouverte.json` à côté, et un résumé sur la sortie.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use archive_gw2::contenu::{lire_contenu, Contenu};
use archive_gw2::pf::type_pf;
use archive_gw2::Archive;
use serde_json::{json, Value};

struct Decoration {
    id: u32,
    nom: String,
    icone: u32,
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let Some(chemin) = arguments.first() else {
        eprintln!("usage : decouverte <Gw2.dat> [decorations.json] [rapport.json]");
        std::process::exit(2);
    };
    let chemin_decorations = arguments.get(1).cloned().unwrap_or_else(|| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/examples/decorations.json").into()
    });
    let chemin_rapport = arguments
        .get(2)
        .cloned()
        .unwrap_or_else(|| "rapport-decouverte.json".into());

    let depart = Instant::now();
    let archive = Archive::ouvrir(chemin).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    eprintln!("archive ouverte : {} fichiers", archive.fichiers().len());

    let decorations: Vec<Decoration> = {
        let texte =
            std::fs::read_to_string(&chemin_decorations).expect("liste des décorations illisible");
        let valeurs: Vec<Value> =
            serde_json::from_str(&texte).expect("liste des décorations invalide");
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

    // 1. Les fichiers de contenu.
    let mut contenus: BTreeMap<u32, Contenu> = BTreeMap::new();
    // Le type PF de chaque fichier, par entrée de la table.
    let mut types_vus: HashMap<usize, String> = HashMap::new();
    let total = archive.fichiers().len();
    for (i, fichier) in archive.fichiers().iter().enumerate() {
        if i % 50_000 == 0 {
            eprintln!("  en-têtes : {i} / {total} ({:.0?})", depart.elapsed());
        }
        let Ok(debut) = archive.lire_debut(fichier.base, Some(12)) else {
            continue;
        };
        let Some(type_) = type_pf(&debut) else {
            continue;
        };
        let type_ = String::from_utf8_lossy(&type_)
            .trim_end_matches('\0')
            .to_string();
        types_vus.insert(fichier.entree, type_.clone());
        if type_ != "cntc" {
            continue;
        }
        match archive
            .lire(fichier.base)
            .map(|octets| lire_contenu(&octets))
        {
            Ok(Ok(Some(contenu))) => {
                contenus.insert(fichier.base, contenu);
            }
            Ok(Ok(None)) => {}
            Ok(Err(e)) => eprintln!("  contenu {} illisible : {e}", fichier.base),
            Err(e) => eprintln!("  {e}"),
        }
    }
    let paquets: Vec<u32> = contenus
        .iter()
        .filter(|(_, c)| c.est_un_paquet())
        .map(|(b, _)| *b)
        .collect();
    eprintln!(
        "{} fichiers de contenu, {} paquets ({:.0?})",
        contenus.len(),
        paquets.len(),
        depart.elapsed()
    );

    let paquet_de = |base: u32| -> Option<u32> {
        let i = paquets.partition_point(|p| *p <= base);
        paquets.get(i.checked_sub(1)?).copied()
    };
    let type_de = |numero: u32| -> String {
        archive
            .index_de(numero)
            .and_then(|i| types_vus.get(&i).cloned())
            .unwrap_or_else(|| "?".into())
    };

    // Les fichiers qu'une entrée référence, avec leur décalage dans l'entrée.
    let references =
        |contenu: &Contenu, paquet: &Contenu, debut: usize, fin: usize| -> Vec<(usize, u32)> {
            let i = contenu.renvois_fichiers.partition_point(|p| *p < debut);
            contenu.renvois_fichiers[i..]
                .iter()
                .take_while(|p| **p < fin)
                .filter_map(|&position| {
                    let index = contenu.u32_a(position)? as usize;
                    let numero = (*paquet.fichiers.get(index)?)?;
                    Some((position - debut, numero))
                })
                .collect()
        };

    // 2. Les entrées qui référencent une icône de décoration.
    let ids_de_decorations: std::collections::HashSet<u32> =
        decorations.iter().map(|d| d.id).collect();
    let mut candidats = Vec::new();
    let mut par_type: BTreeMap<u32, usize> = BTreeMap::new();
    for (&base, contenu) in &contenus {
        let Some(base_paquet) = paquet_de(base) else {
            continue;
        };
        let paquet = &contenus[&base_paquet];
        for entree in &contenu.entrees {
            let refs = references(contenu, paquet, entree.debut, entree.fin);
            let decos: Vec<u32> = refs
                .iter()
                .filter_map(|(_, numero)| archive.index_de(*numero).and_then(|i| par_icone.get(&i)))
                .flatten()
                .copied()
                .collect();
            if decos.is_empty() {
                continue;
            }
            *par_type.entry(entree.type_).or_default() += 1;

            let octets = contenu.octets_de(entree);
            let id_donnees = octets
                .get(40..44)
                .map(|o| u32::from_le_bytes([o[0], o[1], o[2], o[3]]));

            // Les renvois vers d'autres entrées, et ce que ces entrées-là
            // référencent à leur tour.
            let i = contenu
                .renvois_externes
                .partition_point(|r| r.position < entree.debut);
            let externes: Vec<Value> = contenu.renvois_externes[i..]
                .iter()
                .take_while(|r| r.position < entree.fin)
                .filter_map(|renvoi| {
                    let base_cible = base_paquet + renvoi.fichier_cible;
                    let cible = contenus.get(&base_cible)?;
                    let position_cible = contenu.u32_a(renvoi.position)? as usize;
                    let entree_cible = cible.entree_a(position_cible)?;
                    let refs_cible =
                        references(cible, paquet, entree_cible.debut, entree_cible.fin);
                    Some(json!({
                        "decalage": renvoi.position - entree.debut,
                        "fichier": base_cible,
                        "type": entree_cible.type_,
                        "taille": entree_cible.fin - entree_cible.debut,
                        "references": refs_cible.iter().map(|(d, n)| json!({
                            "decalage": d, "fichier": n, "type": type_de(*n),
                        })).collect::<Vec<_>>(),
                    }))
                })
                .collect();

            candidats.push(json!({
                "fichier": base,
                "type": entree.type_,
                "debut": entree.debut,
                "taille": entree.fin - entree.debut,
                "id_donnees": id_donnees,
                "id_donnees_est_une_decoration": id_donnees.is_some_and(|id| ids_de_decorations.contains(&id)),
                "decorations": decos,
                "references": refs.iter().map(|(d, n)| json!({
                    "decalage": d, "fichier": n, "type": type_de(*n),
                })).collect::<Vec<_>>(),
                "externes": externes,
            }));
        }
    }

    // 3. Le résumé : quel type d'entrée porte les décorations, et à quels
    // décalages ses références visent des modèles.
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
    for (ligne, n) in lignes.iter().take(60) {
        println!("  {n:>6}  {ligne}");
    }

    let decorations_trouvees: std::collections::HashSet<u64> = candidats
        .iter()
        .flat_map(|c| c["decorations"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.as_u64())
        .collect();
    println!(
        "\n{} décorations sur {} retrouvées par leur icône ({:.0?}).",
        decorations_trouvees.len(),
        decorations.len(),
        depart.elapsed()
    );

    let noms: HashMap<u32, &str> = decorations.iter().map(|d| (d.id, d.nom.as_str())).collect();
    let rapport = json!({
        "fichiers_de_contenu": contenus.len(),
        "paquets": paquets,
        "par_type": par_type,
        "candidats": candidats,
        "noms": noms,
    });
    std::fs::write(
        &chemin_rapport,
        serde_json::to_string_pretty(&rapport).unwrap(),
    )
    .expect("rapport non écrit");
    println!("Rapport complet : {chemin_rapport}");
}
