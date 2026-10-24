//! Les textures : les fichiers `ATEX` de l'archive.
//!
//! Une texture est une suite de niveaux de détail (« mips »), chacun la moitié
//! du précédent. Chaque niveau porte des blocs DXT — quatre pixels sur quatre —
//! passés par une seconde compression, propre au jeu : des suites de blocs
//! identiques (blanc, alpha constant, couleur unie) se codent par leur
//! longueur, et les autres blocs suivent tels quels.
//!
//! La disposition a été établie par la communauté (gw2DatTools d'Ahom, repris
//! par Tyria3D et Gw2Browser) ; ce module la réécrit, il ne la recopie pas.
//! Il en rend les pixels en RGBA, ligne du haut d'abord.

use std::fmt;

use crate::bc7;

/// « ATEX », et ses variantes : même en-tête, mêmes niveaux.
const SIGNATURES: [&[u8; 4]; 8] = [
    b"ATEX", b"ATEC", b"ATEP", b"ATET", b"ATEU", b"ATTX", b"CTEX", b"CTEU",
];
const TAILLE_ENTETE: usize = 12;

const DXT1: u32 = u32::from_le_bytes(*b"DXT1");
const DXT2: u32 = u32::from_le_bytes(*b"DXT2");
const DXT3: u32 = u32::from_le_bytes(*b"DXT3");
const DXT4: u32 = u32::from_le_bytes(*b"DXT4");
const DXT5: u32 = u32::from_le_bytes(*b"DXT5");
const DXTA: u32 = u32::from_le_bytes(*b"DXTA");
const DXTL: u32 = u32::from_le_bytes(*b"DXTL");
const DXTN: u32 = u32::from_le_bytes(*b"DXTN");
const DCX3: u32 = u32::from_le_bytes(*b"3DCX");
const BC7X: u32 = u32::from_le_bytes(*b"BC7X");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErreurTexture {
    PasUneTexture,
    /// Un format de blocs que ce module ne sait pas rendre en pixels.
    FormatInconnu(String),
    /// Le flux s'arrête avant la fin de ce qu'il annonce.
    Tronquee,
    /// Un niveau plus grand qu'aucune texture du jeu : un en-tête abîmé.
    Demesuree(u16, u16),
}

impl fmt::Display for ErreurTexture {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PasUneTexture => write!(f, "pas une texture"),
            Self::FormatInconnu(format) => write!(f, "format de texture inconnu : {format}"),
            Self::Tronquee => write!(f, "texture tronquée"),
            Self::Demesuree(l, h) => write!(f, "texture de {l} × {h} pixels, plus que permis"),
        }
    }
}

impl std::error::Error for ErreurTexture {}

/// Le nom de quatre lettres d'un format, pour le dire.
pub fn nom_du_format(format: u32) -> String {
    String::from_utf8_lossy(&format.to_le_bytes()).into_owned()
}

/// Une image décodée : quatre octets par pixel, ligne du haut d'abord.
#[derive(Debug, Clone)]
pub struct Image {
    pub largeur: u32,
    pub hauteur: u32,
    pub rgba: Vec<u8>,
    /// Vrai si l'image découpe sa forme — un feuillage, une grille — par son
    /// alpha : le rendu doit l'en laisser faire. Voir `decoupee`.
    pub decoupee: bool,
}

/// Un niveau de détail, encore compressé.
#[derive(Debug, Clone, Copy)]
pub struct Niveau<'a> {
    pub largeur: u16,
    pub hauteur: u16,
    pub octets: &'a [u8],
}

/// L'en-tête d'une texture : son format et ses niveaux, du plus grand au plus
/// petit.
#[derive(Debug, Clone)]
pub struct Texture<'a> {
    pub format: u32,
    pub niveaux: Vec<Niveau<'a>>,
}

impl<'a> Texture<'a> {
    pub fn lire(octets: &'a [u8]) -> Result<Self, ErreurTexture> {
        if octets.len() < TAILLE_ENTETE || !SIGNATURES.iter().any(|s| &octets[0..4] == *s) {
            return Err(ErreurTexture::PasUneTexture);
        }
        let format = u32::from_le_bytes([octets[4], octets[5], octets[6], octets[7]]);
        let mut largeur = u16::from_le_bytes([octets[8], octets[9]]);
        let mut hauteur = u16::from_le_bytes([octets[10], octets[11]]);

        // Chaque niveau commence par sa taille, ce mot compris.
        let mut niveaux = Vec::new();
        let mut position = TAILLE_ENTETE;
        while position + 4 <= octets.len() && largeur > 0 && hauteur > 0 {
            let o = &octets[position..];
            let taille = u32::from_le_bytes([o[0], o[1], o[2], o[3]]) as usize;
            if taille < 8 || position + taille > octets.len() {
                break;
            }
            niveaux.push(Niveau {
                largeur,
                hauteur,
                octets: &octets[position..position + taille],
            });
            position += taille;
            largeur >>= 1;
            hauteur >>= 1;
        }
        if niveaux.is_empty() {
            return Err(ErreurTexture::Tronquee);
        }
        Ok(Self { format, niveaux })
    }

    /// Le plus grand niveau dont aucun côté ne dépasse `cote_max` ; le plus
    /// petit s'ils le dépassent tous.
    pub fn niveau_au_plus(&self, cote_max: u16) -> Niveau<'a> {
        self.niveaux
            .iter()
            .copied()
            .find(|n| n.largeur.max(n.hauteur) <= cote_max)
            .unwrap_or(self.niveaux[self.niveaux.len() - 1])
    }

    /// Les pixels d'un niveau.
    pub fn decoder(&self, niveau: Niveau<'_>) -> Result<Image, ErreurTexture> {
        decoder_niveau(self.format, niveau)
    }
}

/* --- La compression des blocs ------------------------------------------------- */

/// Ce que chaque format porte dans un bloc, pour la décompression.
#[derive(Debug, Clone, Copy)]
struct Disposition {
    /// Les blocs portent une couleur.
    couleur: bool,
    /// Les blocs portent un alpha.
    alpha: bool,
    /// L'alpha se déduit de la couleur (DXT1) : il n'a pas de moitié à lui.
    alpha_deduit: bool,
    /// L'alpha est une moitié de bloc à part, devant la couleur.
    alpha_a_part: bool,
    /// Deux moitiés de couleur (normales, BC7) : elles suivent le chemin de
    /// l'alpha puis celui de la couleur.
    deux_moities: bool,
    bits_par_pixel: usize,
}

fn disposition(format: u32) -> Option<Disposition> {
    let d =
        |couleur, alpha, alpha_deduit, alpha_a_part, deux_moities, bits_par_pixel| Disposition {
            couleur,
            alpha,
            alpha_deduit,
            alpha_a_part,
            deux_moities,
            bits_par_pixel,
        };
    Some(match format {
        DXT1 => d(true, true, true, false, false, 4),
        DXT2 | DXT3 | DXT4 | DXT5 => d(true, true, false, true, false, 8),
        DXTA => d(false, true, false, true, false, 4),
        DXTN | DCX3 => d(false, false, false, false, true, 8),
        _ => return None,
    })
}

const DRAPEAU_BLANC: u32 = 0x01;
const DRAPEAU_ALPHA_4_BITS: u32 = 0x02;
const DRAPEAU_ALPHA_8_BITS: u32 = 0x04;
const DRAPEAU_COULEUR_UNIE: u32 = 0x08;

/// Le lecteur de bits de la compression des blocs : des mots de 32 bits
/// petit-boutistes, bit de poids fort d'abord, un mot sur 16 384 sauté. Il
/// tient au plus deux mots, et sait à quel mot il en est : après les suites
/// codées, les blocs restants se lisent mot à mot depuis là.
struct Bits<'a> {
    octets: &'a [u8],
    /// Le prochain mot à charger.
    mot: usize,
    tete: u32,
    reserve: u32,
    disponibles: u32,
    /// Un mot au-delà de la fin a déjà été rendu en zéros : le suivant manque.
    epuise: bool,
}

impl<'a> Bits<'a> {
    fn new(octets: &'a [u8]) -> Self {
        Self {
            octets,
            mot: 0,
            tete: 0,
            reserve: 0,
            disponibles: 0,
            epuise: false,
        }
    }

    fn mot_brut(&self, i: usize) -> Option<u32> {
        let o = self.octets.get(i * 4..i * 4 + 4)?;
        Some(u32::from_le_bytes([o[0], o[1], o[2], o[3]]))
    }

    fn charger(&mut self) -> Result<(), ErreurTexture> {
        if (self.mot + 1).is_multiple_of(0x4000) {
            self.mot += 1;
        }
        // Un mot de zéros au-delà de la fin, pas deux : la fin du flux peut
        // tomber au milieu d'un code qu'on ne fait que regarder.
        let valeur = match self.mot_brut(self.mot) {
            Some(valeur) => valeur,
            None if !self.epuise => {
                self.epuise = true;
                0
            }
            None => return Err(ErreurTexture::Tronquee),
        };
        if self.disponibles == 0 {
            self.tete = valeur;
            self.reserve = 0;
        } else {
            self.tete |= valeur >> self.disponibles;
            self.reserve = valeur << (32 - self.disponibles);
        }
        self.disponibles += 32;
        self.mot += 1;
        Ok(())
    }

    fn assurer(&mut self, n: u32) -> Result<(), ErreurTexture> {
        if self.disponibles < n {
            self.charger()?;
        }
        Ok(())
    }

    fn regarder(&self, n: u32) -> u32 {
        self.tete >> (32 - n)
    }

    fn jeter(&mut self, n: u32) -> Result<(), ErreurTexture> {
        if n > self.disponibles {
            return Err(ErreurTexture::Tronquee);
        }
        if n == 32 {
            self.tete = self.reserve;
            self.reserve = 0;
        } else {
            self.tete = (self.tete << n) | (self.reserve >> (32 - n));
            self.reserve <<= n;
        }
        self.disponibles -= n;
        Ok(())
    }

    fn lire(&mut self, n: u32) -> Result<u32, ErreurTexture> {
        self.assurer(n)?;
        let valeur = self.regarder(n);
        self.jeter(n)?;
        Ok(valeur)
    }

    /// La longueur d'une suite, par un arbre de Huffman fixe : « 1 » vaut un,
    /// « 01 » dix-huit, et « 00 » suivi de quatre bits `v` vaut 17 - `v`.
    fn longueur(&mut self) -> Result<usize, ErreurTexture> {
        self.assurer(32)?;
        if self.regarder(1) == 1 {
            self.jeter(1)?;
            return Ok(1);
        }
        if self.regarder(2) == 1 {
            self.jeter(2)?;
            return Ok(18);
        }
        let v = self.regarder(6);
        self.jeter(6)?;
        Ok(17 - v as usize)
    }
}

/// Ce que la décompression connaît d'un niveau.
struct Blocs {
    d: Disposition,
    nombre: usize,
    par_bloc: usize,
    /// La taille d'une moitié (ou du bloc, s'il n'en a qu'une).
    par_moitie: usize,
    deux: bool,
    sortie: Vec<u8>,
    alpha_fait: Vec<bool>,
    couleur_faite: Vec<bool>,
}

impl Blocs {
    fn ecrire(&mut self, bloc: usize, decalage: usize, valeur: u64, n: usize) {
        let debut = bloc * self.par_bloc + decalage;
        self.sortie[debut..debut + n].copy_from_slice(&valeur.to_le_bytes()[..n]);
    }

    /// Parcourt les suites : chacune couvre `longueur` blocs pas encore faits
    /// (au sens de `faits`), et `appliquer` dit s'il faut les remplir.
    fn suites(
        &mut self,
        bits: &mut Bits<'_>,
        alpha: bool,
        mut lire_drapeau: impl FnMut(&mut Bits<'_>) -> Result<Option<u64>, ErreurTexture>,
        mut remplir: impl FnMut(&mut Self, usize, u64),
    ) -> Result<(), ErreurTexture> {
        let mut bloc = 0;
        while bloc < self.nombre {
            let mut restant = bits.longueur()?;
            let valeur = lire_drapeau(bits)?;
            while restant > 0 && bloc < self.nombre {
                let fait = if alpha {
                    self.alpha_fait[bloc]
                } else {
                    self.couleur_faite[bloc]
                };
                if !fait {
                    if let Some(valeur) = valeur {
                        remplir(self, bloc, valeur);
                    }
                    restant -= 1;
                }
                bloc += 1;
            }
            while bloc < self.nombre
                && if alpha {
                    self.alpha_fait[bloc]
                } else {
                    self.couleur_faite[bloc]
                }
            {
                bloc += 1;
            }
        }
        Ok(())
    }
}

/// Décompresse les blocs DXT d'un niveau.
fn decompresser_blocs(format: u32, niveau: Niveau<'_>) -> Result<Vec<u8>, ErreurTexture> {
    let d =
        disposition(format).ok_or_else(|| ErreurTexture::FormatInconnu(nom_du_format(format)))?;
    let nombre = usize::from(niveau.largeur).div_ceil(4) * usize::from(niveau.hauteur).div_ceil(4);
    let par_bloc = d.bits_par_pixel * 16 / 8;
    let deux = (d.couleur && d.alpha_a_part) || d.deux_moities;
    let par_moitie = if deux { par_bloc / 2 } else { par_bloc };
    let mut b = Blocs {
        d,
        nombre,
        par_bloc,
        par_moitie,
        deux,
        sortie: vec![0; nombre * par_bloc],
        alpha_fait: vec![false; nombre],
        couleur_faite: vec![false; nombre],
    };

    let mut bits = Bits::new(niveau.octets);
    let _taille = bits.lire(32)?;
    let drapeaux = bits.lire(32)?;

    if drapeaux & DRAPEAU_BLANC != 0 {
        b.suites(
            &mut bits,
            false,
            |bits| Ok((bits.lire(1)? == 1).then_some(0)),
            |b, bloc, _| {
                // Un bloc entier, couleur et alpha : deux couleurs extrêmes et
                // des index qui désignent la plus haute.
                let debut = bloc * b.par_bloc;
                b.sortie[debut..debut + 8].copy_from_slice(&0xFFFF_FFFF_FFFF_FFFEu64.to_le_bytes());
                b.alpha_fait[bloc] = true;
                b.couleur_faite[bloc] = true;
            },
        )?;
    }

    for (drapeau, bits_alpha) in [(DRAPEAU_ALPHA_4_BITS, 4), (DRAPEAU_ALPHA_8_BITS, 8)] {
        if drapeaux & drapeau == 0 {
            continue;
        }
        let v = u64::from(bits.lire(bits_alpha)?);
        let constant = if bits_alpha == 4 {
            // Seize pixels de quatre bits, tous à `v`.
            let octet = v | (v << 4);
            let mot = octet | (octet << 8);
            let double = mot | (mot << 16);
            double | (double << 32)
        } else {
            // Les deux alphas extrêmes à `v`, et tous les index à zéro.
            v | (v << 8)
        };
        b.suites(
            &mut bits,
            true,
            |bits| {
                bits.assurer(2)?;
                let applique = bits.regarder(1) == 1;
                bits.jeter(1)?;
                let non_nul = bits.regarder(1) == 1;
                if applique {
                    bits.jeter(1)?;
                }
                Ok(applique.then_some(if non_nul { constant } else { 0 }))
            },
            |b, bloc, valeur| {
                let n = b.par_moitie;
                b.ecrire(bloc, 0, valeur, n);
                b.alpha_fait[bloc] = true;
            },
        )?;
    }

    if drapeaux & DRAPEAU_COULEUR_UNIE != 0 {
        let bleu = bits.lire(8)?;
        let vert = bits.lire(8)?;
        let rouge = bits.lire(8)?;
        let valeur = bloc_de_couleur_unie(rouge, vert, bleu, d.alpha_deduit);
        b.suites(
            &mut bits,
            false,
            |bits| Ok((bits.lire(1)? == 1).then_some(valeur)),
            |b, bloc, valeur| {
                let decalage = if b.deux { b.par_moitie } else { 0 };
                let n = b.par_moitie;
                b.ecrire(bloc, decalage, valeur, n);
                b.couleur_faite[bloc] = true;
            },
        )?;
    }

    // Les blocs restants suivent tels quels, mot à mot, depuis le premier mot
    // que les suites n'ont pas entamé.
    let mut mot = if bits.disponibles >= 32 {
        bits.mot - 1
    } else {
        bits.mot
    };
    let mut suivant = || {
        let valeur = bits.mot_brut(mot);
        mot += 1;
        valeur
    };

    let Blocs {
        d,
        nombre,
        par_bloc,
        par_moitie,
        deux,
        mut sortie,
        alpha_fait,
        couleur_faite,
    } = b;
    let poser = |sortie: &mut Vec<u8>, debut: usize, valeur: u32| {
        sortie[debut..debut + 4].copy_from_slice(&valeur.to_le_bytes());
    };

    if (d.alpha && !d.alpha_deduit) || d.deux_moities {
        'alpha: for bloc in (0..nombre).filter(|&i| !alpha_fait[i]) {
            for decalage in (0..par_moitie.min(8)).step_by(4) {
                let Some(valeur) = suivant() else {
                    break 'alpha;
                };
                poser(&mut sortie, bloc * par_bloc + decalage, valeur);
            }
        }
    }
    if d.couleur || d.deux_moities {
        let decalage = if deux { par_moitie } else { 0 };
        // Le premier mot de chaque bloc, puis le second de chacun.
        'couleur: for moitie in (0..par_moitie.min(8)).step_by(4) {
            for bloc in (0..nombre).filter(|&i| !couleur_faite[i]) {
                let Some(valeur) = suivant() else {
                    break 'couleur;
                };
                poser(&mut sortie, bloc * par_bloc + decalage + moitie, valeur);
            }
        }
    }
    Ok(sortie)
}

/// Le bloc de couleur DXT qui rend au mieux une couleur unie : deux couleurs
/// 5-6-5 qui l'encadrent, et l'index qui tombe le plus près d'elle. Le calcul
/// est celui du jeu, arrondis compris.
fn bloc_de_couleur_unie(rouge: u32, vert: u32, bleu: u32, alpha_deduit: bool) -> u64 {
    let (r, g, b) = (rouge as i32, vert as i32, bleu as i32);
    let r1 = (r - (r >> 5)) >> 3;
    let b1 = (b - (b >> 5)) >> 3;
    let g1 = (g - (g >> 6)) >> 2;
    let r2 = (r1 << 3) + (r1 >> 2);
    let b2 = (b1 << 3) + (b1 >> 2);
    let g2 = (g1 << 2) + (g1 >> 4);

    let ecart = |valeur: i32, approche: i32, base: i32, masque: i32| -> u32 {
        (12 * (valeur - approche) / (8 - i32::from(base & masque == masque))) as u32
    };
    let er = ecart(r, r2, r1, 0x11);
    let eb = ecart(b, b2, b1, 0x11);
    let eg = ecart(g, g2, g1, 0x1111);

    // Les deux valeurs de chaque composante, selon l'écart.
    let paire = |base: i32, ecart: u32| -> (u32, u32) {
        let base = base as u32;
        match ecart {
            0..=1 => (base, base),
            2..=5 => (base, base + 1),
            6..=9 => (base + 1, base),
            _ => (base + 1, base + 1),
        }
    };
    let (vr1, vr2) = paire(r1, er);
    let (vb1, vb2) = paire(b1, eb);
    let (vg1, vg2) = paire(g1, eg);

    let mut couleur1 = vr1 | ((vg1 | (vb1 << 6)) << 5);
    let mut couleur2 = vr2 | ((vg2 | (vb2 << 6)) << 5);

    let mut somme: u32 = 0;
    let mut differentes: u32 = 0;
    for (v1, v2, base, ecart) in [(vr1, vr2, r1, er), (vb1, vb2, b1, eb), (vg1, vg2, g1, eg)] {
        if v1 != v2 {
            somme = somme.wrapping_add(if v1 == base as u32 {
                ecart
            } else {
                12u32.wrapping_sub(ecart)
            });
            differentes += 1;
        }
    }
    if let Some(moyenne) = (somme + differentes / 2).checked_div(differentes) {
        somme = moyenne;
    }

    let cas_dxt1 = alpha_deduit && (somme == 5 || somme == 6 || differentes != 0);
    if differentes > 0 && !cas_dxt1 {
        if couleur2 == 0xFFFF {
            somme = 12;
            couleur1 = couleur1.wrapping_sub(1);
        } else {
            somme = 0;
            couleur2 += 1;
        }
    }
    if couleur2 >= couleur1 {
        std::mem::swap(&mut couleur1, &mut couleur2);
        somme = 12u32.wrapping_sub(somme);
    }

    let index: u64 = if cas_dxt1 {
        2
    } else {
        match somme {
            0..=1 => 0,
            2..=5 => 2,
            6..=9 => 3,
            _ => 1,
        }
    };
    let mut index = index | (index << 2) | ((index | (index << 2)) << 4);
    index |= index << 8;
    index |= index << 16;
    u64::from(couleur1) | (u64::from(couleur2) << 16) | (index << 32)
}

/* --- Des blocs aux pixels ------------------------------------------------------- */

/// Le plus grand côté qu'on décode : celui des plus grandes textures du jeu.
const COTE_MAX: u16 = 4096;

/// L'alpha sous lequel un pixel compte pour transparent.
const SEUIL_TRANSPARENT: u8 = 16;

fn u16_le(o: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([o[i], o[i + 1]])
}

fn u32_le(o: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([o[i], o[i + 1], o[i + 2], o[i + 3]])
}

/// Une couleur 5-6-5, étalée sur huit bits par composante.
fn rgb565(c: u16) -> [u8; 3] {
    let r = (c >> 11) & 0x1F;
    let g = (c >> 5) & 0x3F;
    let b = c & 0x1F;
    [
        ((r << 3) | (r >> 2)) as u8,
        ((g << 2) | (g >> 4)) as u8,
        ((b << 3) | (b >> 2)) as u8,
    ]
}

/// Les seize pixels d'un bloc de couleur DXT. `quatre_couleurs` : DXT3 et
/// DXT5 n'ont jamais le mode à trois couleurs et un transparent de DXT1.
fn bloc_couleur(o: &[u8], quatre_couleurs: bool) -> [[u8; 4]; 16] {
    let c0 = u16_le(o, 0);
    let c1 = u16_le(o, 2);
    let (a, b) = (rgb565(c0), rgb565(c1));
    let melange = |pa: u32, pb: u32, total: u32| -> [u8; 4] {
        let m = |i: usize| ((u32::from(a[i]) * pa + u32::from(b[i]) * pb) / total) as u8;
        [m(0), m(1), m(2), 255]
    };
    let palette = if c0 > c1 || quatre_couleurs {
        [
            [a[0], a[1], a[2], 255],
            [b[0], b[1], b[2], 255],
            melange(2, 1, 3),
            melange(1, 2, 3),
        ]
    } else {
        [
            [a[0], a[1], a[2], 255],
            [b[0], b[1], b[2], 255],
            melange(1, 1, 2),
            [0, 0, 0, 0],
        ]
    };
    let index = u32_le(o, 4);
    std::array::from_fn(|i| palette[((index >> (2 * i)) & 3) as usize])
}

/// Les seize alphas d'un bloc DXT5 : deux extrêmes et des index de trois bits.
fn bloc_alpha_interpole(o: &[u8]) -> [u8; 16] {
    let a0 = u32::from(o[0]);
    let a1 = u32::from(o[1]);
    let mut palette = [0u8; 8];
    palette[0] = a0 as u8;
    palette[1] = a1 as u8;
    if a0 > a1 {
        for i in 1..7 {
            palette[i + 1] = (((7 - i as u32) * a0 + i as u32 * a1) / 7) as u8;
        }
    } else {
        for i in 1..5 {
            palette[i + 1] = (((5 - i as u32) * a0 + i as u32 * a1) / 5) as u8;
        }
        palette[6] = 0;
        palette[7] = 255;
    }
    let mut index = 0u64;
    for (i, octet) in o[2..8].iter().enumerate() {
        index |= u64::from(*octet) << (8 * i);
    }
    std::array::from_fn(|i| palette[((index >> (3 * i)) & 7) as usize])
}

/// Les seize alphas d'un bloc DXT3 : quatre bits chacun, tels quels.
fn bloc_alpha_explicite(o: &[u8]) -> [u8; 16] {
    std::array::from_fn(|i| {
        let quatre = (o[i / 2] >> (4 * (i % 2))) & 0xF;
        quatre | (quatre << 4)
    })
}

fn decoder_niveau(format: u32, niveau: Niveau<'_>) -> Result<Image, ErreurTexture> {
    // Les blocs DXTL sont des blocs DXT5, dont l'alpha module la couleur ; les
    // blocs BC7 se décompressent comme deux moitiés de huit octets, à la
    // manière des normales.
    let format_des_blocs = match format {
        DXTL => DXT5,
        BC7X => DCX3,
        _ => format,
    };
    if !matches!(format, DXT1 | DXT2 | DXT3 | DXT4 | DXT5 | DXTL | BC7X) {
        return Err(ErreurTexture::FormatInconnu(nom_du_format(format)));
    }
    // Rien ne s'alloue sur la foi d'un en-tête : un côté abîmé réclamerait
    // des gigaoctets.
    if niveau.largeur.max(niveau.hauteur) > COTE_MAX {
        return Err(ErreurTexture::Demesuree(niveau.largeur, niveau.hauteur));
    }
    let blocs = decompresser_blocs(format_des_blocs, niveau)?;

    let largeur = usize::from(niveau.largeur);
    let hauteur = usize::from(niveau.hauteur);
    let par_ligne = largeur.div_ceil(4);
    let par_bloc = if format_des_blocs == DXT1 { 8 } else { 16 };
    let mut rgba = vec![0u8; largeur * hauteur * 4];

    for (n, bloc) in blocs.chunks_exact(par_bloc).enumerate() {
        let (bx, by) = ((n % par_ligne) * 4, (n / par_ligne) * 4);
        let pixels = match format_des_blocs {
            DXT1 => bloc_couleur(bloc, false),
            DXT2 | DXT3 => {
                let mut p = bloc_couleur(&bloc[8..], true);
                for (pixel, a) in p.iter_mut().zip(bloc_alpha_explicite(bloc)) {
                    pixel[3] = a;
                }
                p
            }
            DCX3 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(bloc);
                bc7::decoder_bloc(&octets)
            }
            _ => {
                let mut p = bloc_couleur(&bloc[8..], true);
                for (pixel, a) in p.iter_mut().zip(bloc_alpha_interpole(bloc)) {
                    pixel[3] = a;
                }
                p
            }
        };
        for (i, pixel) in pixels.iter().enumerate() {
            let (x, y) = (bx + i % 4, by + i / 4);
            if x < largeur && y < hauteur {
                let debut = (y * largeur + x) * 4;
                rgba[debut..debut + 4].copy_from_slice(pixel);
            }
        }
    }

    if format == DXTL {
        for pixel in rgba.chunks_exact_mut(4) {
            let a = u32::from(pixel[3]);
            for c in &mut pixel[..3] {
                *c = (u32::from(*c) * a / 255) as u8;
            }
            pixel[3] = 255;
        }
    }

    Ok(Image {
        largeur: largeur as u32,
        hauteur: hauteur as u32,
        decoupee: decoupee(&rgba),
        rgba,
    })
}

/// L'alpha d'une texture de couleur ne dit pas toujours la transparence : la
/// pierre et l'écorce y rangent un reflet, jamais nul, là où un feuillage y
/// découpe ses feuilles. Une image est découpée quand une part sensible de
/// ses pixels est transparente — un vingtième, et non un seul pixel.
fn decoupee(rgba: &[u8]) -> bool {
    let pixels = rgba.len() / 4;
    let transparents = rgba
        .chunks_exact(4)
        .filter(|p| p[3] < SEUIL_TRANSPARENT)
        .count();
    pixels > 0 && transparents * 20 >= pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_longueur_des_suites_se_lit() {
        // « 1 », « 01 », « 00 1111 », « 00 0000 » : 1, 18, 2, 17.
        let mot: u32 = (1 << 31) | (0b01 << 29) | (0b00_1111 << 23);
        let octets = [mot.to_le_bytes(), [0; 4]].concat();
        let mut bits = Bits::new(&octets);
        assert_eq!(bits.longueur().unwrap(), 1);
        assert_eq!(bits.longueur().unwrap(), 18);
        assert_eq!(bits.longueur().unwrap(), 2);
        assert_eq!(bits.longueur().unwrap(), 17);
    }

    #[test]
    fn un_bloc_dxt1_se_decode() {
        // Rouge pur et bleu pur, tous les pixels sur l'index 0, puis 1.
        let mut bloc = [0u8; 8];
        bloc[0..2].copy_from_slice(&0xF800u16.to_le_bytes());
        bloc[2..4].copy_from_slice(&0x001Fu16.to_le_bytes());
        bloc[4..8].copy_from_slice(&0x5555_5555u32.to_le_bytes());
        let pixels = bloc_couleur(&bloc, false);
        assert!(pixels.iter().all(|p| *p == [0, 0, 255, 255]));
    }

    #[test]
    fn un_alpha_dxt5_s_interpole() {
        let mut bloc = [0u8; 8];
        bloc[0] = 255;
        bloc[1] = 0;
        // Pixel 0 sur l'index 1, les autres sur 0.
        bloc[2] = 1;
        let alphas = bloc_alpha_interpole(&bloc);
        assert_eq!(alphas[0], 0);
        assert!(alphas[1..].iter().all(|a| *a == 255));
    }

    /// Un niveau entièrement codé « tels quels » : sans drapeau, les blocs
    /// suivent en clair après la taille et les drapeaux.
    #[test]
    fn un_niveau_sans_suites_rend_ses_blocs() {
        let mut octets = Vec::new();
        octets.extend(16u32.to_le_bytes()); // taille
        octets.extend(0u32.to_le_bytes()); // drapeaux
        octets.extend(0xF800_F800u32.to_le_bytes()); // deux rouges
        octets.extend(0u32.to_le_bytes()); // index à zéro
        let niveau = Niveau {
            largeur: 4,
            hauteur: 4,
            octets: &octets,
        };
        let image = decoder_niveau(DXT1, niveau).unwrap();
        assert!(image.rgba.chunks_exact(4).all(|p| p == [255, 0, 0, 255]));
        assert!(!image.decoupee);
    }

    #[test]
    fn un_format_inconnu_se_dit() {
        let octets = [0u8; 16];
        let niveau = Niveau {
            largeur: 4,
            hauteur: 4,
            octets: &octets,
        };
        assert!(matches!(
            decoder_niveau(DXTN, niveau),
            Err(ErreurTexture::FormatInconnu(_))
        ));
    }
}
