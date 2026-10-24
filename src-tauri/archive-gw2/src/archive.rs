//! L'archive `Gw2.dat` : son en-tête, sa table des fichiers (MFT) et l'index
//! qui relie un numéro de fichier à son entrée.
//!
//! L'archive pèse des dizaines de gigaoctets : elle ne se charge jamais, on y
//! lit fichier par fichier, à la position que la table donne.

use std::collections::HashMap;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;

use crate::decompression::{decompresser, ErreurDecompression};

/// « AN\x1A » : la signature d'une archive d'ArenaNet, après l'octet de version.
const SIGNATURE: &[u8; 3] = b"AN\x1A";
/// « Mft\x1A ».
const SIGNATURE_MFT: &[u8; 4] = b"Mft\x1A";

const TAILLE_ENTETE: usize = 40;
const TAILLE_ENTREE_MFT: usize = 24;
/// L'entrée de la table qui porte l'index des numéros de fichier.
const ENTREE_INDEX: usize = 2;
/// Ce qu'on lit d'un fichier compressé pour n'en décompresser que l'en-tête,
/// en élargissant tant que ça ne suffit pas.
const PREFIXES_POUR_EN_TETE: [usize; 3] = [1024, 8192, 65_536];

#[derive(Debug)]
pub enum ErreurArchive {
    Lecture(io::Error),
    /// Ni une archive d'ArenaNet, ni une table qu'on sache lire.
    Format(&'static str),
    /// Aucun fichier ne porte ce numéro.
    Absent(u32),
    Decompression(u32, ErreurDecompression),
}

impl fmt::Display for ErreurArchive {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lecture(erreur) => write!(f, "lecture de l'archive : {erreur}"),
            Self::Format(quoi) => write!(f, "archive illisible : {quoi}"),
            Self::Absent(id) => write!(f, "aucun fichier {id} dans l'archive"),
            Self::Decompression(id, erreur) => write!(f, "fichier {id} : {erreur}"),
        }
    }
}

impl std::error::Error for ErreurArchive {}

impl From<io::Error> for ErreurArchive {
    fn from(erreur: io::Error) -> Self {
        Self::Lecture(erreur)
    }
}

/// Une entrée de la table des fichiers.
#[derive(Debug, Clone, Copy)]
pub struct Entree {
    pub position: u64,
    pub taille: u32,
    pub compressee: bool,
}

/// Un fichier de l'archive et ses deux numéros. Le jeu en donne parfois deux à
/// un même fichier : le plus petit est le numéro de base, celui que portent les
/// références du contenu ; le plus grand, celui de la révision courante.
#[derive(Debug, Clone, Copy)]
pub struct Fichier {
    pub entree: usize,
    pub base: u32,
    pub revision: u32,
}

pub struct Archive {
    fichier: Mutex<File>,
    entrees: Vec<Entree>,
    /// Numéro de fichier (de base ou de révision) → index dans `entrees`.
    par_numero: HashMap<u32, usize>,
    fichiers: Vec<Fichier>,
}

fn u16_le(o: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([o[i], o[i + 1]])
}

fn u32_le(o: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([o[i], o[i + 1], o[i + 2], o[i + 3]])
}

fn u64_le(o: &[u8], i: usize) -> u64 {
    u64::from_le_bytes([
        o[i],
        o[i + 1],
        o[i + 2],
        o[i + 3],
        o[i + 4],
        o[i + 5],
        o[i + 6],
        o[i + 7],
    ])
}

impl Archive {
    pub fn ouvrir(chemin: impl AsRef<Path>) -> Result<Self, ErreurArchive> {
        let mut fichier = File::open(chemin)?;

        let mut entete = [0u8; TAILLE_ENTETE];
        fichier.read_exact(&mut entete)?;
        if &entete[1..4] != SIGNATURE {
            return Err(ErreurArchive::Format("signature d'archive absente"));
        }
        let position_mft = u64_le(&entete, 24);
        let taille_mft = u32_le(&entete, 32) as usize;

        let mut mft = vec![0u8; taille_mft];
        fichier.seek(SeekFrom::Start(position_mft))?;
        fichier.read_exact(&mut mft)?;
        if mft.len() < TAILLE_ENTREE_MFT || &mft[0..4] != SIGNATURE_MFT {
            return Err(ErreurArchive::Format("signature de table absente"));
        }
        let nombre = u32_le(&mft, 12) as usize;
        if nombre * TAILLE_ENTREE_MFT > mft.len() {
            return Err(ErreurArchive::Format("table plus courte que son compte"));
        }

        // L'entrée 0 est l'en-tête de la table elle-même : on la garde à sa
        // place pour que l'index d'une entrée soit celui que l'archive écrit.
        let entrees: Vec<Entree> = (0..nombre)
            .map(|i| {
                let o = i * TAILLE_ENTREE_MFT;
                Entree {
                    position: u64_le(&mft, o),
                    taille: u32_le(&mft, o + 8),
                    compressee: i > 0 && u16_le(&mft, o + 12) != 0,
                }
            })
            .collect();

        let index = entrees
            .get(ENTREE_INDEX)
            .ok_or(ErreurArchive::Format("index absent"))?;
        let mut octets_index = vec![0u8; index.taille as usize];
        fichier.seek(SeekFrom::Start(index.position))?;
        fichier.read_exact(&mut octets_index)?;

        let mut par_numero = HashMap::new();
        let mut par_entree: HashMap<usize, Fichier> = HashMap::new();
        for paire in octets_index.chunks_exact(8) {
            let numero = u32_le(paire, 0);
            let entree = u32_le(paire, 4) as usize;
            if numero == 0 && entree == 0 {
                continue;
            }
            if entree == 0 || entree >= entrees.len() {
                continue;
            }
            par_numero.insert(numero, entree);
            par_entree
                .entry(entree)
                .and_modify(|f| {
                    if numero < f.base {
                        f.base = numero;
                    }
                    if numero > f.revision {
                        f.revision = numero;
                    }
                })
                .or_insert(Fichier {
                    entree,
                    base: numero,
                    revision: numero,
                });
        }
        let mut fichiers: Vec<Fichier> = par_entree.into_values().collect();
        fichiers.sort_by_key(|f| f.base);

        Ok(Self {
            fichier: Mutex::new(fichier),
            entrees,
            par_numero,
            fichiers,
        })
    }

    /// Tous les fichiers indexés, par numéro de base croissant.
    pub fn fichiers(&self) -> &[Fichier] {
        &self.fichiers
    }

    pub fn entree(&self, numero: u32) -> Option<Entree> {
        self.par_numero.get(&numero).map(|&i| self.entrees[i])
    }

    fn lire_brut(&self, entree: Entree, taille: usize) -> Result<Vec<u8>, ErreurArchive> {
        let mut octets = vec![0u8; taille];
        let mut fichier = self.fichier.lock().unwrap_or_else(|e| e.into_inner());
        fichier.seek(SeekFrom::Start(entree.position))?;
        fichier.read_exact(&mut octets)?;
        Ok(octets)
    }

    /// Le contenu d'un fichier, décompressé.
    pub fn lire(&self, numero: u32) -> Result<Vec<u8>, ErreurArchive> {
        self.lire_debut(numero, None)
    }

    /// L'entrée de la table qui porte ce numéro : deux numéros d'un même
    /// fichier donnent la même.
    pub fn index_de(&self, numero: u32) -> Option<usize> {
        self.par_numero.get(&numero).copied()
    }

    /// Les `limite` premiers octets d'un fichier, décompressés : de quoi lire
    /// son en-tête sans tout décompresser.
    pub fn lire_debut(&self, numero: u32, limite: Option<usize>) -> Result<Vec<u8>, ErreurArchive> {
        let entree = self.entree(numero).ok_or(ErreurArchive::Absent(numero))?;
        let taille = entree.taille as usize;

        if !entree.compressee {
            let n = limite.map_or(taille, |limite| limite.min(taille));
            return self.lire_brut(entree, n);
        }

        // Pour quelques octets, le début du flux suffit presque toujours : il
        // faut seulement que les arbres du premier bloc y tiennent. On
        // élargit la lecture jusqu'à ce qu'ils y tiennent, plutôt que de lire
        // d'emblée un fichier qui peut peser des centaines de mégaoctets.
        if let Some(limite) = limite {
            for prefixe in PREFIXES_POUR_EN_TETE {
                let essai = prefixe.max(limite) & !3;
                if essai >= taille {
                    break;
                }
                let brut = self.lire_brut(entree, essai)?;
                if let Ok(octets) = decompresser(&brut, Some(limite)) {
                    return Ok(octets);
                }
            }
        }

        let brut = self.lire_brut(entree, taille)?;
        decompresser(&brut, limite).map_err(|e| ErreurArchive::Decompression(numero, e))
    }
}
