//! Les décorations du pavillon dans le contenu de jeu : de l'identifiant que
//! l'API et l'export XML donnent au fichier de son modèle.
//!
//! Établi sur l'archive du 24 octobre 2026 (`examples/decouverte.rs`) : chaque
//! décoration est une entrée du type 30 du paquet de contenu, son identifiant
//! est le mot à +40 — comme pour toutes les entrées —, son modèle le renvoi de
//! fichier à +64 et son icône celui à +152. Les 1 210 décorations de l'API y
//! sont, une entrée chacune.
//!
//! Le numéro d'un type est sa place dans la table du paquet : le jeu pourrait
//! la réordonner. Une entrée dont le mot à +64 n'est pas un renvoi de fichier
//! n'est donc pas lue comme un modèle — mieux vaut une décoration sans modèle
//! qu'avec celui d'une autre chose.

use std::collections::HashMap;

use crate::archive::{Archive, ErreurArchive};
use crate::contenu::{lire_contenu, Contenu};
use crate::pf::type_pf;

/// Le type des décorations du pavillon dans la table du paquet.
pub const TYPE_DECORATION: u32 = 30;
const DECALAGE_ID: usize = 40;
const DECALAGE_MODELE: usize = 64;

/// Les fichiers de contenu sont lourds : plusieurs mégaoctets compressés. Les
/// chercher parmi les seuls fichiers de plus d'un mégaoctet en lit quelques
/// milliers d'en-têtes au lieu de huit cent mille.
const TAILLE_MIN_CONTENU: u32 = 1 << 20;

/// Les fichiers du paquet de contenu : le paquet, puis ceux qui le suivent
/// sans interruption.
pub fn trouver_le_contenu(
    archive: &Archive,
    indice: Option<u32>,
) -> Result<Vec<u32>, ErreurArchive> {
    let est_contenu = |base: u32| -> bool {
        archive
            .lire_debut(base, Some(12))
            .ok()
            .and_then(|o| type_pf(&o))
            .is_some_and(|t| &t == b"cntc")
    };

    // Le paquet de la dernière fois, s'il l'est encore.
    let mut paquet = indice.filter(|&base| est_contenu(base) && !est_contenu(base.wrapping_sub(1)));

    if paquet.is_none() {
        paquet = archive
            .fichiers()
            .iter()
            .filter(|f| {
                archive
                    .entree(f.base)
                    .is_some_and(|e| e.taille >= TAILLE_MIN_CONTENU)
            })
            .map(|f| f.base)
            .find(|&base| est_contenu(base) && !est_contenu(base.wrapping_sub(1)));
    }
    if paquet.is_none() {
        paquet = archive
            .fichiers()
            .iter()
            .map(|f| f.base)
            .find(|&base| est_contenu(base) && !est_contenu(base.wrapping_sub(1)));
    }

    let Some(paquet) = paquet else {
        return Ok(Vec::new());
    };
    let mut fichiers = vec![paquet];
    while est_contenu(fichiers[fichiers.len() - 1] + 1) {
        fichiers.push(fichiers[fichiers.len() - 1] + 1);
    }
    Ok(fichiers)
}

/// Le modèle de chaque décoration, par identifiant.
pub fn indexer(archive: &Archive, fichiers: &[u32]) -> Result<HashMap<u32, u32>, ErreurArchive> {
    let mut modeles = HashMap::new();
    let mut table: Option<Vec<Option<u32>>> = None;

    for &base in fichiers {
        let octets = archive.lire(base)?;
        let Ok(Some(contenu)) = lire_contenu(&octets) else {
            continue;
        };
        if contenu.est_un_paquet() {
            table = Some(contenu.fichiers.clone());
        }
        let Some(table) = &table else { continue };
        relever(&contenu, table, &mut modeles);
    }
    Ok(modeles)
}

fn relever(contenu: &Contenu, table: &[Option<u32>], modeles: &mut HashMap<u32, u32>) {
    for entree in contenu
        .entrees
        .iter()
        .filter(|e| e.type_ == TYPE_DECORATION)
    {
        let position_modele = entree.debut + DECALAGE_MODELE;
        if position_modele + 4 > entree.fin
            || contenu
                .renvois_fichiers
                .binary_search(&position_modele)
                .is_err()
        {
            continue;
        }
        let (Some(id), Some(index)) = (
            contenu.u32_a(entree.debut + DECALAGE_ID),
            contenu.u32_a(position_modele),
        ) else {
            continue;
        };
        if let Some(Some(modele)) = table.get(index as usize) {
            modeles.insert(id, *modele);
        }
    }
}
