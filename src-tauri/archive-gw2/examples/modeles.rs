//! Lit le modèle de quelques décorations et l'écrit en OBJ, pour le regarder
//! dans n'importe quel visualiseur.
//!
//! ```text
//! cargo run --release --example modeles -- <Gw2.dat> <dossier> 805 988 901
//! ```

use std::fmt::Write as _;
use std::time::Instant;

use archive_gw2::decorations::{indexer, trouver_le_contenu};
use archive_gw2::modele::lire_modele;
use archive_gw2::Archive;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() < 2 {
        eprintln!("usage : modeles <Gw2.dat> <dossier> <id>…");
        std::process::exit(2);
    }
    let depart = Instant::now();
    let archive = Archive::ouvrir(&arguments[0]).expect("archive illisible");
    let contenu = trouver_le_contenu(&archive, None).expect("contenu introuvable");
    println!(
        "contenu : {} fichiers depuis {:?} ({:.0?})",
        contenu.len(),
        contenu.first(),
        depart.elapsed()
    );
    let index = indexer(&archive, &contenu).expect("index impossible");
    println!(
        "{} décorations indexées ({:.0?})",
        index.len(),
        depart.elapsed()
    );

    std::fs::create_dir_all(&arguments[1]).expect("dossier");
    for id in arguments[2..].iter().filter_map(|a| a.parse::<u32>().ok()) {
        let Some(&fichier) = index.get(&id) else {
            println!("{id} : pas de modèle");
            continue;
        };
        let octets = archive.lire(fichier).expect("modèle illisible");
        let Ok(Some(modele)) = lire_modele(&octets) else {
            println!("{id} : fichier {fichier} n'est pas un modèle lisible");
            continue;
        };
        let mut obj = String::new();
        let mut decalage = 1;
        let (mut min, mut max) = ([f32::MAX; 3], [f32::MIN; 3]);
        for (n, maillage) in modele.maillages.iter().enumerate() {
            writeln!(obj, "o maillage{n}").unwrap();
            for p in maillage.positions.chunks(3) {
                for k in 0..3 {
                    min[k] = min[k].min(p[k]);
                    max[k] = max[k].max(p[k]);
                }
                writeln!(obj, "v {} {} {}", p[0], p[1], p[2]).unwrap();
            }
            for t in maillage.triangles.chunks(3) {
                writeln!(
                    obj,
                    "f {} {} {}",
                    t[0] + decalage,
                    t[1] + decalage,
                    t[2] + decalage
                )
                .unwrap();
            }
            decalage += (maillage.positions.len() / 3) as u32;
        }
        println!(
            "{id} : fichier {fichier}, {} maillages, {} sommets, {} triangles, de {min:?} à {max:?}",
            modele.maillages.len(),
            modele.maillages.iter().map(|m| m.positions.len() / 3).sum::<usize>(),
            modele.maillages.iter().map(|m| m.triangles.len() / 3).sum::<usize>(),
        );
        std::fs::write(format!("{}/{id}.obj", arguments[1]), obj).expect("écriture");
    }
    println!("({:.0?})", depart.elapsed());
}
