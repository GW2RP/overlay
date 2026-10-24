//! La décompression des fichiers de l'archive.
//!
//! Le jeu compresse ses fichiers par un schéma à lui : un LZ77 dont les
//! symboles et les distances passent par deux arbres de Huffman, eux-mêmes
//! décrits au début de chaque bloc à l'aide d'un troisième arbre, fixe
//! (`ARBRE_DES_ARBRES`). Le flux se lit par mots de 32 bits petit-boutistes,
//! bit de poids fort d'abord, et un mot sur 16 384 — une somme de contrôle par
//! tranche de 64 Kio — n'appartient pas au flux.
//!
//! La disposition a été établie par la communauté (gw2DatTools d'Ahom, repris
//! par Tyria3D) ; ce module la réécrit, il ne la recopie pas.

use std::fmt;
use std::sync::OnceLock;

/// Un mot sur `MOTS_PAR_TRANCHE` est une somme de contrôle, sautée à la lecture.
const MOTS_PAR_TRANCHE: usize = 16_384;

/// Les symboles d'un bloc ne dépassent jamais cette valeur : 256 octets
/// littéraux, puis les codes de longueur de copie.
const SYMBOLES_MAX: u16 = 285;

/// Les codes de Huffman tiennent sur 32 bits au plus.
const LONGUEUR_MAX: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErreurDecompression {
    /// Le flux s'arrête avant la fin annoncée.
    FluxTronque,
    /// Un arbre annonce plus de symboles qu'il n'en existe.
    TropDeSymboles(u16),
    /// Un code de longueur ou de distance hors de la table.
    CodeInvalide(&'static str, u16),
    /// Une copie qui remonterait avant le début de la sortie.
    DistanceHorsSortie { distance: usize, ecrit: usize },
    /// Un code lu qu'aucun symbole de l'arbre ne porte.
    CodeInconnu,
}

impl fmt::Display for ErreurDecompression {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FluxTronque => write!(f, "flux compressé tronqué"),
            Self::TropDeSymboles(n) => write!(f, "arbre de {n} symboles, plus que permis"),
            Self::CodeInvalide(quoi, code) => write!(f, "code de {quoi} invalide : {code}"),
            Self::DistanceHorsSortie { distance, ecrit } => {
                write!(f, "copie à {distance} octets en arrière, {ecrit} écrits")
            }
            Self::CodeInconnu => write!(f, "code de Huffman inconnu"),
        }
    }
}

impl std::error::Error for ErreurDecompression {}

/* --- Le lecteur de bits ------------------------------------------------------ */

/// Lit le flux bit à bit, bits de poids fort d'abord, mot de 32 bits par mot.
struct LecteurDeBits<'a> {
    octets: &'a [u8],
    /// Index du prochain mot de 32 bits à charger.
    prochain_mot: usize,
    /// Les bits chargés, alignés sur le poids fort.
    reserve: u64,
    /// Combien de bits de `reserve` sont du flux.
    disponibles: u32,
}

impl<'a> LecteurDeBits<'a> {
    fn new(octets: &'a [u8]) -> Self {
        let mut lecteur = Self {
            octets,
            prochain_mot: 0,
            reserve: 0,
            disponibles: 0,
        };
        lecteur.remplir();
        lecteur
    }

    fn remplir(&mut self) {
        while self.disponibles <= 32 {
            if (self.prochain_mot + 1).is_multiple_of(MOTS_PAR_TRANCHE) {
                self.prochain_mot += 1;
            }
            let debut = self.prochain_mot * 4;
            let Some(mot) = self.octets.get(debut..debut + 4) else {
                return;
            };
            let mot = u32::from_le_bytes([mot[0], mot[1], mot[2], mot[3]]);
            self.reserve |= u64::from(mot) << (32 - self.disponibles);
            self.disponibles += 32;
            self.prochain_mot += 1;
        }
    }

    /// Les `n` prochains bits, sans les consommer ; complétés de zéros au-delà
    /// de la fin du flux, comme un regard en avant doit pouvoir le faire.
    fn regarder(&self, n: u32) -> u32 {
        debug_assert!((1..=32).contains(&n));
        (self.reserve >> (64 - n)) as u32
    }

    fn consommer(&mut self, n: u32) -> Result<(), ErreurDecompression> {
        if n > self.disponibles {
            return Err(ErreurDecompression::FluxTronque);
        }
        self.reserve = if n == 64 { 0 } else { self.reserve << n };
        self.disponibles -= n;
        self.remplir();
        Ok(())
    }

    fn lire(&mut self, n: u32) -> Result<u32, ErreurDecompression> {
        if n > self.disponibles {
            return Err(ErreurDecompression::FluxTronque);
        }
        let valeur = self.regarder(n);
        self.consommer(n)?;
        Ok(valeur)
    }
}

/* --- Les arbres de Huffman --------------------------------------------------- */

/// Les codes d'une longueur donnée forment une plage contiguë, attribuée en
/// descendant depuis `plus_haut` : le premier symbole de la liste prend
/// `plus_haut`, le suivant `plus_haut - 1`, et ainsi de suite.
#[derive(Debug, Clone)]
struct Longueur {
    bits: u32,
    plus_haut: u32,
    symboles: Vec<u16>,
}

#[derive(Debug, Clone)]
enum Arbre {
    /// Aucun symbole n'a de code : le bloc ne contient que ce symbole-là, et
    /// le lire ne consomme aucun bit.
    Unique(u16),
    Codes(Vec<Longueur>),
}

impl Arbre {
    /// Construit l'arbre depuis les symboles et leur longueur de code, dans
    /// l'ordre où le flux les donne. À longueur égale, le dernier donné prend
    /// le code le plus haut.
    fn construire(symboles: &[(u16, u32)], unique: u16) -> Self {
        let mut par_longueur: Vec<Vec<u16>> = vec![Vec::new(); LONGUEUR_MAX];
        for &(symbole, bits) in symboles {
            par_longueur[bits as usize].push(symbole);
        }
        if par_longueur.iter().all(Vec::is_empty) {
            return Self::Unique(unique);
        }

        let mut longueurs = Vec::new();
        let mut code: u64 = 0;
        for (bits, liste) in par_longueur.into_iter().enumerate() {
            if !liste.is_empty() {
                let plus_haut = code as u32;
                // Le dernier donné vient en tête de liste.
                let symboles: Vec<u16> = liste.into_iter().rev().collect();
                code = code.wrapping_sub(symboles.len() as u64);
                longueurs.push(Longueur {
                    bits: bits as u32,
                    plus_haut,
                    symboles,
                });
            }
            code = (code << 1).wrapping_add(1) & 0xFFFF_FFFF;
        }
        Self::Codes(longueurs)
    }

    fn lire(&self, lecteur: &mut LecteurDeBits<'_>) -> Result<u16, ErreurDecompression> {
        let longueurs = match self {
            Self::Unique(symbole) => return Ok(*symbole),
            Self::Codes(longueurs) => longueurs,
        };
        let devant = lecteur.regarder(32);
        // Les codes sont sans préfixe commun : la plus courte longueur dont la
        // plage contient le début du flux est la bonne.
        for longueur in longueurs {
            let code = devant >> (32 - longueur.bits);
            let n = longueur.symboles.len() as u32;
            if code <= longueur.plus_haut && longueur.plus_haut - code < n {
                let symbole = longueur.symboles[(longueur.plus_haut - code) as usize];
                lecteur.consommer(longueur.bits)?;
                return Ok(symbole);
            }
        }
        Err(ErreurDecompression::CodeInconnu)
    }
}

/// L'arbre fixe qui décrit les arbres de chaque bloc : par longueur de code,
/// les symboles dans l'ordre où ils sont donnés.
const ARBRE_DES_ARBRES_SOURCE: &[(u32, &[u16])] = &[
    (3, &[0x0A, 0x09, 0x08]),
    (4, &[0x0C, 0x0B, 0x07, 0x00]),
    (5, &[0xE0, 0x2A, 0x29, 0x06]),
    (6, &[0x4A, 0x40, 0x2C, 0x2B, 0x28, 0x20, 0x05, 0x04]),
    (7, &[0x49, 0x48, 0x27, 0x26, 0x25, 0x0D, 0x03]),
    (8, &[0x6A, 0x69, 0x4C, 0x4B, 0x47, 0x24]),
    (
        9,
        &[0xE8, 0xA0, 0x89, 0x88, 0x68, 0x67, 0x63, 0x60, 0x46, 0x23],
    ),
    (
        10,
        &[
            0xE9, 0xC9, 0xC0, 0xA9, 0xA8, 0x8A, 0x87, 0x80, 0x66, 0x65, 0x45, 0x44, 0x43, 0x2D,
            0x02, 0x01,
        ],
    ),
    (
        11,
        &[
            0xE5, 0xC8, 0xAA, 0xA5, 0xA4, 0x8B, 0x85, 0x84, 0x6C, 0x6B, 0x64, 0x4D, 0x0E,
        ],
    ),
    (12, &[0xE7, 0xCA, 0xC7, 0xA7, 0xA6, 0x86, 0x83]),
    (13, &[0xE6, 0xE4, 0xC4, 0x8C, 0x2E, 0x22]),
    (14, &[0xEC, 0xC6, 0x6D, 0x4E]),
    (15, &[0xEA, 0xCC, 0xAC, 0xAB, 0x8D, 0x11, 0x10, 0x0F]),
];

/// Les symboles de 16 bits de l'arbre fixe : tous les octets de 0xFF à 0x12
/// qui n'ont pas de code plus court, en descendant.
fn symboles_de_seize_bits() -> Vec<u16> {
    let plus_courts: Vec<u16> = ARBRE_DES_ARBRES_SOURCE
        .iter()
        .flat_map(|(_, symboles)| symboles.iter().copied())
        .collect();
    (0x12..=0xFFu16)
        .rev()
        .filter(|s| !plus_courts.contains(s))
        .collect()
}

fn arbre_des_arbres() -> &'static Arbre {
    static ARBRE: OnceLock<Arbre> = OnceLock::new();
    ARBRE.get_or_init(|| {
        let mut symboles: Vec<(u16, u32)> = ARBRE_DES_ARBRES_SOURCE
            .iter()
            .flat_map(|(bits, liste)| liste.iter().map(move |s| (*s, *bits)))
            .collect();
        symboles.extend(symboles_de_seize_bits().into_iter().map(|s| (s, 16)));
        Arbre::construire(&symboles, 0)
    })
}

/// Lit la description d'un arbre de bloc.
fn lire_arbre(lecteur: &mut LecteurDeBits<'_>) -> Result<Arbre, ErreurDecompression> {
    let nombre = lecteur.lire(16)? as u16;
    if nombre > SYMBOLES_MAX {
        return Err(ErreurDecompression::TropDeSymboles(nombre));
    }

    let unique = nombre.wrapping_sub(1);
    let mut restant = i32::from(nombre) - 1;
    let mut symboles = Vec::new();
    while restant >= 0 {
        let code = arbre_des_arbres().lire(lecteur)?;
        let bits = u32::from(code & 0x1F);
        let repetitions = i32::from(code >> 5) + 1;
        if bits == 0 {
            restant -= repetitions;
        } else {
            for _ in 0..repetitions {
                if restant < 0 {
                    break;
                }
                symboles.push((restant as u16, bits));
                restant -= 1;
            }
        }
    }
    Ok(Arbre::construire(&symboles, unique))
}

/* --- La décompression -------------------------------------------------------- */

/// La taille décompressée annoncée par l'en-tête d'un fichier compressé.
pub fn taille_decompressee(compresse: &[u8]) -> Option<usize> {
    let octets = compresse.get(4..8)?;
    Some(u32::from_le_bytes([octets[0], octets[1], octets[2], octets[3]]) as usize)
}

/// Décompresse un fichier de l'archive. `limite` borne la sortie : lire l'en-tête
/// d'un fichier n'oblige pas à le décompresser en entier.
pub fn decompresser(
    compresse: &[u8],
    limite: Option<usize>,
) -> Result<Vec<u8>, ErreurDecompression> {
    let mut lecteur = LecteurDeBits::new(compresse);

    // Un mot d'en-tête, puis la taille décompressée.
    lecteur.consommer(32)?;
    let annoncee = lecteur.lire(32)? as usize;
    let taille = limite.map_or(annoncee, |limite| limite.min(annoncee));

    let mut sortie = Vec::with_capacity(taille);

    lecteur.consommer(4)?;
    let ajout_longueur = lecteur.lire(4)? + 1;

    while sortie.len() < taille {
        let arbre_symboles = lire_arbre(&mut lecteur)?;
        let arbre_distances = lire_arbre(&mut lecteur)?;

        let codes_du_bloc = (lecteur.lire(4)? + 1) << 12;

        let mut lus = 0;
        while lus < codes_du_bloc && sortie.len() < taille {
            lus += 1;

            let symbole = arbre_symboles.lire(&mut lecteur)?;
            if symbole < 0x100 {
                sortie.push(symbole as u8);
                continue;
            }

            // Une copie : sa longueur…
            let code = u32::from(symbole - 0x100);
            let (quotient, reste) = (code / 4, code % 4);
            let mut longueur = if quotient == 0 {
                code
            } else if quotient < 7 {
                (1 << (quotient - 1)) * (4 + reste)
            } else if code == 28 {
                0xFF
            } else {
                return Err(ErreurDecompression::CodeInvalide("longueur", symbole));
            };
            if quotient > 1 && code != 28 {
                longueur |= lecteur.lire(quotient - 1)?;
            }
            longueur += ajout_longueur;

            // … puis sa distance.
            let symbole = arbre_distances.lire(&mut lecteur)?;
            let code = u32::from(symbole);
            let (quotient, reste) = (code / 2, code % 2);
            let mut distance = if quotient == 0 {
                code
            } else if quotient < 17 {
                (1 << (quotient - 1)) * (2 + reste)
            } else {
                return Err(ErreurDecompression::CodeInvalide("distance", symbole));
            };
            if quotient > 1 {
                distance |= lecteur.lire(quotient - 1)?;
            }
            let distance = distance as usize + 1;

            if distance > sortie.len() {
                return Err(ErreurDecompression::DistanceHorsSortie {
                    distance,
                    ecrit: sortie.len(),
                });
            }
            for _ in 0..longueur {
                if sortie.len() >= taille {
                    break;
                }
                let octet = sortie[sortie.len() - distance];
                sortie.push(octet);
            }
        }
    }

    Ok(sortie)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Écrit des bits de poids fort d'abord, en mots de 32 bits petit-boutistes,
    /// comme le jeu les range — sans les sommes de contrôle, inutiles ici.
    struct EcrivainDeBits {
        mots: Vec<u32>,
        courant: u64,
        n: u32,
    }

    impl EcrivainDeBits {
        fn new() -> Self {
            Self {
                mots: Vec::new(),
                courant: 0,
                n: 0,
            }
        }

        fn ecrire(&mut self, valeur: u32, bits: u32) {
            for i in (0..bits).rev() {
                let bit = (valeur >> i) & 1;
                self.courant = (self.courant << 1) | u64::from(bit);
                self.n += 1;
                if self.n == 32 {
                    self.mots.push(self.courant as u32);
                    self.courant = 0;
                    self.n = 0;
                }
            }
        }

        fn octets(mut self) -> Vec<u8> {
            if self.n > 0 {
                let reste = 32 - self.n;
                self.ecrire(0, reste);
            }
            // Un mot de marge, comme la fin d'un vrai fichier.
            self.mots.push(0);
            self.mots.iter().flat_map(|m| m.to_le_bytes()).collect()
        }
    }

    /// Le code qu'un arbre donne à un symbole, pour écrire un flux de test.
    fn code_de(arbre: &Arbre, symbole: u16) -> (u32, u32) {
        let Arbre::Codes(longueurs) = arbre else {
            panic!("arbre unique")
        };
        for longueur in longueurs {
            if let Some(i) = longueur.symboles.iter().position(|s| *s == symbole) {
                return (longueur.plus_haut - i as u32, longueur.bits);
            }
        }
        panic!("symbole {symbole:#x} absent");
    }

    #[test]
    fn l_arbre_des_arbres_couvre_tous_les_octets() {
        let Arbre::Codes(longueurs) = arbre_des_arbres() else {
            panic!()
        };
        let total: usize = longueurs.iter().map(|l| l.symboles.len()).sum();
        assert_eq!(total, 256);
        // Un code complet : la somme de Kraft vaut exactement un.
        let kraft: f64 = longueurs
            .iter()
            .map(|l| l.symboles.len() as f64 / f64::from(1u32 << l.bits))
            .sum();
        assert!((kraft - 1.0).abs() < 1e-12, "somme de Kraft {kraft}");
    }

    #[test]
    fn l_arbre_des_arbres_relit_chaque_symbole() {
        let arbre = arbre_des_arbres();
        for symbole in 0..=0xFFu16 {
            let (code, bits) = code_de(arbre, symbole);
            let mut ecrivain = EcrivainDeBits::new();
            ecrivain.ecrire(code, bits);
            let octets = ecrivain.octets();
            let mut lecteur = LecteurDeBits::new(&octets);
            assert_eq!(arbre.lire(&mut lecteur).unwrap(), symbole);
        }
    }

    /// Décrit un arbre de bloc où chaque symbole de `symboles` a `bits` bits.
    fn ecrire_arbre(ecrivain: &mut EcrivainDeBits, nombre: u16, symboles: &[(u16, u32)]) {
        ecrivain.ecrire(u32::from(nombre), 16);
        let dict = arbre_des_arbres();
        let mut restant = i32::from(nombre) - 1;
        while restant >= 0 {
            let bits = symboles
                .iter()
                .find(|(s, _)| i32::from(*s) == restant)
                .map_or(0, |(_, b)| *b);
            let (code, n) = code_de(dict, bits as u16);
            ecrivain.ecrire(code, n);
            restant -= 1;
        }
    }

    #[test]
    fn un_flux_de_litteraux_et_de_copies_se_relit() {
        // Deux arbres faits à la main : symboles 'a', 'b', et la copie de
        // longueur minimale (0x100) ; une seule distance, le code 1.
        let litteraux = [(0x61u16, 2u32), (0x62, 2), (0x100, 1)];
        let distances = [(1u16, 1u32)];

        let mut ecrivain = EcrivainDeBits::new();
        ecrivain.ecrire(0, 32); // en-tête
        ecrivain.ecrire(7, 32); // taille : « abababa »
        ecrivain.ecrire(0, 4);
        ecrivain.ecrire(0, 4); // longueur de copie - 1
        ecrire_arbre(&mut ecrivain, 0x101, &litteraux);
        ecrire_arbre(&mut ecrivain, 2, &distances);
        ecrivain.ecrire(0, 4); // 4 096 codes au plus dans le bloc

        // Le flux donne les symboles du plus grand au plus petit.
        let par_ordre_du_flux = |liste: &[(u16, u32)]| {
            let mut liste = liste.to_vec();
            liste.sort_by_key(|s| std::cmp::Reverse(s.0));
            liste
        };
        let symboles = Arbre::construire(&par_ordre_du_flux(&litteraux), 0);
        let dist = Arbre::construire(&par_ordre_du_flux(&distances), 0);
        let (a, na) = code_de(&symboles, 0x61);
        let (b, nb) = code_de(&symboles, 0x62);
        let (copie, nc) = code_de(&symboles, 0x100);
        let (d, nd) = code_de(&dist, 1);

        ecrivain.ecrire(a, na);
        ecrivain.ecrire(b, nb);
        // Copie de 0 + 1 octet à distance 1 + 1 = 2 : « a ».
        ecrivain.ecrire(copie, nc);
        ecrivain.ecrire(d, nd);
        ecrivain.ecrire(b, nb);
        ecrivain.ecrire(copie, nc);
        ecrivain.ecrire(d, nd);
        ecrivain.ecrire(b, nb);
        ecrivain.ecrire(copie, nc);
        ecrivain.ecrire(d, nd);

        let sortie = decompresser(&ecrivain.octets(), None).unwrap();
        assert_eq!(sortie, b"abababa");
    }

    #[test]
    fn un_flux_tronque_echoue_sans_paniquer() {
        let octets = [0u8; 8];
        assert!(decompresser(&octets, None).is_err());
    }

    #[test]
    fn le_lecteur_saute_les_sommes_de_controle() {
        let mut octets = vec![0u8; (MOTS_PAR_TRANCHE + 1) * 4];
        // Le mot 16 383 est une somme de contrôle ; le 16 384 est du flux.
        octets[(MOTS_PAR_TRANCHE - 1) * 4..MOTS_PAR_TRANCHE * 4]
            .copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        octets[MOTS_PAR_TRANCHE * 4..].copy_from_slice(&0x1234_5678u32.to_le_bytes());
        let mut lecteur = LecteurDeBits::new(&octets);
        for _ in 0..MOTS_PAR_TRANCHE - 1 {
            assert_eq!(lecteur.lire(32).unwrap(), 0);
        }
        assert_eq!(lecteur.lire(32).unwrap(), 0x1234_5678);
    }
}
