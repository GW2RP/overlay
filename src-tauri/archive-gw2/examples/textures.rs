//! Relève les textures des décorations : combien de maillages en ont, sous
//! quels formats, et si elles se décodent. Écrit en TGA celles des
//! décorations demandées, pour les regarder.
//!
//! ```text
//! cargo run --release --example textures -- <Gw2.dat> <dossier> [id…]
//! cargo run --release --example textures -- <fichier MODL>
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use archive_gw2::decorations::{indexer, trouver_le_contenu};
use archive_gw2::modele::lire_modele;
use archive_gw2::texture::{nom_du_format, Image, Texture};
use archive_gw2::Archive;

/// Le côté le plus grand qu'on décode, comme l'éditeur.
const COTE_MAX: u16 = 512;

fn ecrire_tga(chemin: &str, image: &Image) {
    let mut o = vec![0u8; 18];
    o[2] = 2;
    o[12..14].copy_from_slice(&(image.largeur as u16).to_le_bytes());
    o[14..16].copy_from_slice(&(image.hauteur as u16).to_le_bytes());
    o[16] = 32;
    o[17] = 0x28; // ligne du haut d'abord, huit bits d'alpha
    for p in image.rgba.as_chunks::<4>().0 {
        o.extend([p[2], p[1], p[0], p[3]]);
    }
    std::fs::write(chemin, o).expect("écriture");
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() == 1 {
        let octets = std::fs::read(&arguments[0]).expect("fichier");
        let modele = lire_modele(&octets)
            .expect("modèle")
            .expect("pas un modèle");
        for (n, m) in modele.maillages.iter().enumerate() {
            println!(
                "maillage {n} : {} sommets, {} uv, matériau {}, texture {:?}, uv[0..4] {:?}",
                m.positions.len() / 3,
                m.uv.len() / 2,
                m.materiau,
                m.texture,
                &m.uv[..m.uv.len().min(4)]
            );
        }
        return;
    }
    let depart = Instant::now();
    let archive = Archive::ouvrir(&arguments[0]).expect("archive illisible");
    let contenu = trouver_le_contenu(&archive, Some(1_282_830)).expect("contenu introuvable");
    let index = indexer(&archive, &contenu).expect("index impossible");
    println!(
        "{} décorations indexées ({:.0?})",
        index.len(),
        depart.elapsed()
    );
    let dossier = &arguments[1];
    std::fs::create_dir_all(dossier).expect("dossier");
    let demandees: BTreeSet<u32> = arguments[2..]
        .iter()
        .filter_map(|a| a.parse().ok())
        .collect();

    let mut maillages = 0;
    let mut avec_uv = 0;
    let mut avec_texture = 0;
    let mut sans_maillage = 0;
    let mut textures: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let ids: Vec<u32> = if demandees.is_empty() {
        index.keys().copied().collect()
    } else {
        demandees.iter().copied().collect()
    };
    for &id in &ids {
        let Some(&fichier) = index.get(&id) else {
            continue;
        };
        let Ok(octets) = archive.lire(fichier) else {
            continue;
        };
        let Ok(Some(modele)) = lire_modele(&octets) else {
            continue;
        };
        if modele.maillages.is_empty() {
            sans_maillage += 1;
        }
        for m in &modele.maillages {
            maillages += 1;
            avec_uv += usize::from(!m.uv.is_empty());
            if let Some(t) = m.texture {
                avec_texture += 1;
                textures.entry(t).or_default().push(id);
            }
        }
    }
    println!(
        "{} modèles, {sans_maillage} sans maillage ; {maillages} maillages, {avec_uv} avec uv, {avec_texture} avec texture ; {} textures distinctes ({:.0?})",
        ids.len(),
        textures.len(),
        depart.elapsed()
    );

    let mut formats: BTreeMap<String, usize> = BTreeMap::new();
    let mut echecs: BTreeMap<String, usize> = BTreeMap::new();
    let mut tailles: BTreeMap<(u16, u16), usize> = BTreeMap::new();
    let mut decoupees = 0;
    let mut decodees = 0;
    let mut duree_decodage = Duration::ZERO;
    for (&t, ids) in &textures {
        let octets = match archive.lire(t) {
            Ok(o) => o,
            Err(e) => {
                *echecs.entry(format!("lecture : {e}")).or_default() += 1;
                continue;
            }
        };
        let texture = match Texture::lire(&octets) {
            Ok(texture) => texture,
            Err(e) => {
                let signature =
                    String::from_utf8_lossy(&octets[..octets.len().min(4)]).into_owned();
                *echecs.entry(format!("{e} ({signature})")).or_default() += 1;
                continue;
            }
        };
        *formats.entry(nom_du_format(texture.format)).or_default() += 1;
        *tailles
            .entry((texture.niveaux[0].largeur, texture.niveaux[0].hauteur))
            .or_default() += 1;
        let niveau = texture.niveau_au_plus(COTE_MAX);
        let debut = Instant::now();
        match texture.decoder(niveau) {
            Ok(image) => {
                duree_decodage += debut.elapsed();
                decodees += 1;
                decoupees += usize::from(image.decoupee);
                if ids.iter().any(|id| demandees.contains(id)) {
                    ecrire_tga(&format!("{dossier}/{}-{t}.tga", ids[0]), &image);
                }
            }
            Err(e) => {
                *echecs
                    .entry(format!("{} : {e}", nom_du_format(texture.format)))
                    .or_default() += 1;
            }
        }
    }
    println!("formats : {formats:?}");
    println!("tailles : {tailles:?}");
    println!("échecs : {echecs:?}");
    println!(
        "{decodees} décodées en {duree_decodage:.0?}, {decoupees} découpées ({:.0?})",
        depart.elapsed()
    );
}
