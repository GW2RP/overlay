//! Le contenu de jeu : les fichiers PF de type `cntc`, où le jeu range ses
//! définitions — objets, apparences, cartes, et les décorations du pavillon.
//!
//! Le contenu est réparti sur une suite de fichiers consécutifs. Le premier,
//! le « paquet », porte la table des types et la table des fichiers
//! référencés ; les suivants y renvoient. Chaque fichier porte une liste
//! d'entrées typées, posées bout à bout dans un même tableau d'octets
//! (`octets`), et des correctifs qui disent où, dans ce tableau, un mot est
//! un renvoi : vers un fichier de l'archive (`renvois_fichiers`), vers une
//! entrée d'un autre fichier du paquet (`renvois_externes`), vers une chaîne.

use crate::pf::{ErreurPf, FichierPf};

/// Une entrée : son type (l'index dans la table des types du paquet) et sa
/// place dans le tableau d'octets.
#[derive(Debug, Clone, Copy)]
pub struct EntreeContenu {
    pub type_: u32,
    pub debut: usize,
    pub fin: usize,
}

/// Un renvoi vers une entrée d'un autre fichier : le mot à `position` est une
/// position dans le tableau d'octets du fichier `paquet + fichier_cible`.
#[derive(Debug, Clone, Copy)]
pub struct RenvoiExterne {
    pub position: usize,
    pub fichier_cible: u32,
}

#[derive(Debug, Clone)]
pub struct Contenu {
    /// Combien de types la table du paquet décrit ; zéro hors du paquet.
    pub nombre_de_types: usize,
    /// Les fichiers que le paquet référence ; vide hors du paquet.
    pub fichiers: Vec<Option<u32>>,
    pub entrees: Vec<EntreeContenu>,
    pub renvois_externes: Vec<RenvoiExterne>,
    /// Les positions où le mot est un index dans `fichiers` du paquet.
    pub renvois_fichiers: Vec<usize>,
    pub chaines: Vec<String>,
    pub octets: Vec<u8>,
}

impl Contenu {
    pub fn est_un_paquet(&self) -> bool {
        self.nombre_de_types > 0
    }

    pub fn octets_de(&self, entree: &EntreeContenu) -> &[u8] {
        &self.octets[entree.debut..entree.fin]
    }

    pub fn u32_a(&self, position: usize) -> Option<u32> {
        let o = self.octets.get(position..position + 4)?;
        Some(u32::from_le_bytes([o[0], o[1], o[2], o[3]]))
    }

    /// L'entrée qui contient cette position du tableau d'octets.
    pub fn entree_a(&self, position: usize) -> Option<&EntreeContenu> {
        let i = self.entrees.partition_point(|e| e.debut <= position);
        let entree = self.entrees.get(i.checked_sub(1)?)?;
        (position < entree.fin).then_some(entree)
    }
}

/// Lit le bloc principal d'un fichier `cntc`. Seule la version 0 du bloc est
/// connue ; une autre se refuse plutôt que de se lire de travers.
pub fn lire_contenu(octets: &[u8]) -> Result<Option<Contenu>, ErreurPf> {
    let fichier = FichierPf::lire(octets)?;
    if fichier.type_() != "cntc" {
        return Ok(None);
    }
    let Some(bloc) = fichier.bloc("Main") else {
        return Ok(None);
    };
    if bloc.version != 0 {
        return Ok(None);
    }

    let mut c = fichier.curseur(bloc.debut);
    let _drapeaux = c.u32()?;
    let (_, nombre_de_types) = c.tableau()?;
    let _espaces_de_noms = c.tableau()?;

    let (debut, n) = c.tableau_de(c.taille_pointeur())?;
    let mut fichiers = Vec::with_capacity(n);
    let mut f = fichier.curseur(debut);
    for _ in 0..n {
        fichiers.push(f.reference_fichier()?);
    }

    let (debut, n) = c.tableau_de(16)?;
    let mut index = Vec::with_capacity(n);
    let mut f = fichier.curseur(debut);
    for _ in 0..n {
        let type_ = f.u32()?;
        let position = f.u32()? as usize;
        let _espace = f.u32()?;
        let _racine = f.u32()?;
        index.push((type_, position));
    }

    let _renvois_locaux = c.tableau()?;

    let (debut, n) = c.tableau_de(8)?;
    let mut renvois_externes = Vec::with_capacity(n);
    let mut f = fichier.curseur(debut);
    for _ in 0..n {
        let position = f.u32()? as usize;
        let fichier_cible = f.u32()?;
        renvois_externes.push(RenvoiExterne {
            position,
            fichier_cible,
        });
    }

    let (debut, n) = c.tableau_de(4)?;
    let mut renvois_fichiers = Vec::with_capacity(n);
    let mut f = fichier.curseur(debut);
    for _ in 0..n {
        renvois_fichiers.push(f.u32()? as usize);
    }

    let _renvois_chaines = c.tableau()?;
    let _references_suivies = c.tableau()?;

    let (debut, n) = c.tableau_de(c.taille_pointeur())?;
    let mut chaines = Vec::with_capacity(n);
    let mut f = fichier.curseur(debut);
    for _ in 0..n {
        chaines.push(f.chaine16()?.unwrap_or_default());
    }

    let (debut, n) = c.tableau_de(1)?;
    let octets_contenu = octets
        .get(debut..debut + n)
        .ok_or(ErreurPf::HorsLimites("contenu"))?
        .to_vec();

    let mut entrees: Vec<EntreeContenu> = index
        .iter()
        .enumerate()
        .map(|(i, &(type_, debut))| {
            let fin = index
                .get(i + 1)
                .map_or(octets_contenu.len(), |&(_, suivant)| suivant);
            EntreeContenu {
                type_,
                debut,
                fin: fin.max(debut).min(octets_contenu.len()),
            }
        })
        .collect();
    entrees.sort_by_key(|e| e.debut);

    renvois_fichiers.sort_unstable();
    renvois_externes.sort_by_key(|r| r.position);

    Ok(Some(Contenu {
        nombre_de_types,
        fichiers,
        entrees,
        renvois_externes,
        renvois_fichiers,
        chaines,
        octets: octets_contenu,
    }))
}
