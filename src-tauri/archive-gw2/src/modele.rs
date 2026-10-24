//! Les modèles : les fichiers PF de type `MODL`, leur bloc de géométrie
//! (`GEOM`) et leur bloc de matériaux (`MODL`).
//!
//! Un modèle est une liste de maillages. Chacun porte ses sommets dans un
//! format que décrit un mot de drapeaux (`fvf`) — position, normales, poids,
//! coordonnées de texture… —, ses triangles en index de 16 bits, et l'index de
//! son matériau. On en garde la forme — positions et triangles —, la première
//! paire de coordonnées de texture, et la texture de couleur du matériau. Les
//! positions sont dans le repère du jeu, en pouces, z vers le bas.

use crate::pf::{Curseur, ErreurPf, FichierPf};

/// Ce que chaque drapeau du format de sommet ajoute au sommet, en octets, dans
/// l'ordre où le sommet les range. Les coordonnées de texture viennent entre
/// les deux moitiés : `FVF_UV32` et `FVF_UV16`, une paire par bit.
const FVF_AVANT_UV: [(u32, usize); 8] = [
    (FVF_POSITION, 12),
    (0x0000_0002, 4),  // poids
    (0x0000_0004, 4),  // groupe d'os
    (0x0000_0008, 12), // normale
    (0x0000_0010, 4),  // couleur
    (0x0000_0020, 12), // tangente
    (0x0000_0040, 12), // bitangente
    (0x0000_0080, 12), // repère tangent
];
const FVF_APRES_UV: [(u32, usize); 6] = [
    (0x0100_0000, 48),
    (0x0200_0000, 4),
    (0x0400_0000, 4),
    (0x0800_0000, 16),
    (FVF_POSITION_COMPRESSEE, 6),
    (0x2000_0000, 12),
];
/// Position en trois flottants de 32 bits.
const FVF_POSITION: u32 = 0x0000_0001;
/// Position en trois flottants de 16 bits.
const FVF_POSITION_COMPRESSEE: u32 = 0x1000_0000;
/// Coordonnées de texture en flottants de 32 bits, une paire par bit.
const FVF_UV32: u32 = 0x0000_FF00;
/// Coordonnées de texture en flottants de 16 bits, une paire par bit.
const FVF_UV16: u32 = 0x00FF_0000;

/// Les versions du bloc de matériaux dont la disposition est connue : de la
/// 65 à la 70, le début d'un matériau ne change pas.
const VERSIONS_MATERIAUX: std::ops::RangeInclusive<u16> = 65..=70;
/// Le jeton de la texture de couleur d'un matériau, sur ses 32 bits bas.
const JETON_COULEUR: u32 = 0x6753_1924;

#[derive(Debug, Clone, Default)]
pub struct Maillage {
    /// x, y, z à la suite.
    pub positions: Vec<f32>,
    /// u, v à la suite, un couple par sommet ; vide si le maillage n'en a
    /// pas.
    pub uv: Vec<f32>,
    /// Trois index par triangle.
    pub triangles: Vec<u32>,
    pub materiau: u32,
    /// Le fichier de la texture de couleur de son matériau, s'il en a une et
    /// que les coordonnées de texture sont là pour la poser.
    pub texture: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct Modele {
    pub maillages: Vec<Maillage>,
}

/// Où se trouvent, dans un sommet, sa position et sa première paire de
/// coordonnées de texture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Disposition {
    taille: usize,
    position: usize,
    compressee: bool,
    uv: Option<(usize, bool)>,
}

/// La disposition d'un sommet, ou `None` s'il n'a pas de position.
fn disposition(fvf: u32) -> Option<Disposition> {
    let mut taille = 0;
    let mut position = None;
    for (drapeau, octets) in FVF_AVANT_UV {
        if fvf & drapeau != 0 {
            if drapeau == FVF_POSITION {
                position = Some((taille, false));
            }
            taille += octets;
        }
    }
    let uv32 = (fvf & FVF_UV32).count_ones() as usize;
    let uv16 = (fvf & FVF_UV16).count_ones() as usize;
    let uv = (uv32 + uv16 > 0).then_some((taille, uv32 > 0));
    taille += uv32 * 8 + uv16 * 4;
    for (drapeau, octets) in FVF_APRES_UV {
        if fvf & drapeau != 0 {
            if drapeau == FVF_POSITION_COMPRESSEE && position.is_none() {
                position = Some((taille, true));
            }
            taille += octets;
        }
    }
    let (position, compressee) = position?;
    Some(Disposition {
        taille,
        position,
        compressee,
        uv,
    })
}

/// Un flottant de 16 bits (IEEE 754 demi-précision).
fn demi(bits: u16) -> f32 {
    let signe = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exposant = i32::from((bits >> 10) & 0x1F);
    let mantisse = f32::from(bits & 0x3FF);
    match exposant {
        0 => signe * mantisse * 2f32.powi(-24),
        31 => {
            if mantisse == 0.0 {
                signe * f32::INFINITY
            } else {
                f32::NAN
            }
        }
        _ => signe * (1.0 + mantisse / 1024.0) * 2f32.powi(exposant - 15),
    }
}

/// Lit la géométrie d'un fichier de modèle, et la texture de chaque maillage.
/// Un maillage dont on ne sait pas situer la position dans le sommet — un
/// format qu'on ne connaît pas — est laissé de côté plutôt que lu de travers.
pub fn lire_modele(octets: &[u8]) -> Result<Option<Modele>, ErreurPf> {
    let fichier = FichierPf::lire(octets)?;
    if fichier.type_() != "MODL" {
        return Ok(None);
    }
    let Some(bloc) = fichier.bloc("GEOM") else {
        return Ok(Some(Modele::default()));
    };
    if bloc.version > 1 {
        return Ok(None);
    }
    // Des matériaux illisibles ne coûtent que les textures : la forme reste.
    let textures = lire_textures(&fichier).unwrap_or_default();

    // La racine : un tableau de pointeurs vers les maillages.
    let mut racine = fichier.curseur(bloc.debut);
    let taille_pointeur = racine.taille_pointeur();
    let (debut, nombre) = racine.tableau_de(taille_pointeur)?;

    let mut maillages = Vec::with_capacity(nombre);
    for i in 0..nombre {
        let mut pointeur = fichier.curseur(debut + i * taille_pointeur);
        let Some(position) = pointeur.pointeur()? else {
            continue;
        };
        if let Some(mut maillage) = lire_maillage(fichier.curseur(position))? {
            if !maillage.uv.is_empty() {
                maillage.texture = textures.get(maillage.materiau as usize).copied().flatten();
            }
            maillages.push(maillage);
        }
    }
    Ok(Some(Modele { maillages }))
}

/// La texture de couleur de chaque matériau, dans l'ordre où les maillages
/// les désignent : ceux de la première permutation, la forme de base du
/// modèle. Une version du bloc qu'on ne connaît pas ne donne aucune texture.
pub fn lire_textures(fichier: &FichierPf<'_>) -> Result<Vec<Option<u32>>, ErreurPf> {
    let Some(bloc) = fichier
        .blocs
        .iter()
        .find(|b| &b.nom == b"MODL" && VERSIONS_MATERIAUX.contains(&b.version))
    else {
        return Ok(Vec::new());
    };
    let mut racine = fichier.curseur(bloc.debut);
    let p = racine.taille_pointeur();
    // Une permutation : un jeton, puis le tableau de ses matériaux.
    let (permutations, nombre) = racine.tableau_de(8 + 4 + p)?;
    if nombre == 0 {
        return Ok(Vec::new());
    }
    let mut permutation = fichier.curseur(permutations);
    permutation.sauter(8)?;
    let (debut, nombre) = permutation.tableau_de(p)?;

    let mut textures = Vec::with_capacity(nombre);
    for i in 0..nombre {
        let mut pointeur = fichier.curseur(debut + i * p);
        let Some(materiau) = pointeur.pointeur()? else {
            textures.push(None);
            continue;
        };
        let mut m = fichier.curseur(materiau);
        m.sauter(8 + 4)?; // jeton, identifiant
        m.pointeur()?; // fichier du matériau
        m.sauter(4 + 4)?; // drapeaux, ordre de tri
                          // Une texture : son fichier, ses drapeaux, son jeton, puis de quoi
                          // l'animer.
        let taille_texture = p + 4 + 8 + 8 + 4 + 1;
        let (debut_textures, n) = m.tableau_de(taille_texture)?;
        let mut couleur = None;
        for t in 0..n {
            let mut texture = fichier.curseur(debut_textures + t * taille_texture);
            let fichier_texture = texture.reference_fichier()?;
            texture.sauter(4)?;
            if texture.u32()? == JETON_COULEUR && fichier_texture.is_some() {
                couleur = fichier_texture;
                break;
            }
        }
        textures.push(couleur);
    }
    Ok(textures)
}

fn lire_maillage(mut c: Curseur<'_>) -> Result<Option<Maillage>, ErreurPf> {
    // Les deux versions du bloc ont la même disposition jusqu'à la géométrie.
    c.sauter(8)?; // os de visibilité
    c.tableau()?; // cibles de morphose
    c.u32()?; // drapeaux
    c.tableau()?; // sommets de couture
    c.sauter(8)?; // nom
    c.sauter(12 + 12)?; // boîte englobante
    c.tableau()?; // volumes englobants
    let materiau = c.u32()?;
    c.pointeur()?; // nom du matériau
    c.tableau()?; // os
    let Some(geometrie) = c.pointeur()? else {
        return Ok(None);
    };

    let mut g = Curseur {
        position: geometrie,
        ..c
    };
    let nombre_sommets = g.u32()? as usize;
    let fvf = g.u32()?;
    let (debut_sommets, taille_sommets) = g.tableau_de(1)?;
    let (debut_index, nombre_index) = g.tableau_de(2)?;

    if nombre_sommets == 0 || taille_sommets == 0 || nombre_index < 3 {
        return Ok(None);
    }
    let pas = taille_sommets / nombre_sommets;
    let Some(sommet) = disposition(fvf) else {
        return Ok(None);
    };
    // Un sommet qui ne pèse pas ce que ses drapeaux annoncent porte un champ
    // qu'on ne connaît pas : rien après lui n'est à sa place. Seule une
    // position en tête se lit encore, sans coordonnées de texture.
    let sommet = if sommet.taille == pas {
        sommet
    } else if !sommet.compressee && sommet.position == 0 && pas >= 12 {
        Disposition { uv: None, ..sommet }
    } else {
        return Ok(None);
    };

    let lire = |i: usize, decalage: usize| Curseur {
        position: debut_sommets + i * pas + decalage,
        ..c
    };
    let mut positions = Vec::with_capacity(nombre_sommets * 3);
    let mut uv = Vec::with_capacity(if sommet.uv.is_some() {
        nombre_sommets * 2
    } else {
        0
    });
    for i in 0..nombre_sommets {
        let mut s = lire(i, sommet.position);
        if sommet.compressee {
            positions.extend([demi(s.u16()?), demi(s.u16()?), demi(s.u16()?)]);
        } else {
            positions.extend([s.f32()?, s.f32()?, s.f32()?]);
        }
        if let Some((decalage, complets)) = sommet.uv {
            let mut s = lire(i, decalage);
            if complets {
                uv.extend([s.f32()?, s.f32()?]);
            } else {
                uv.extend([demi(s.u16()?), demi(s.u16()?)]);
            }
        }
    }

    let mut triangles = Vec::with_capacity(nombre_index - nombre_index % 3);
    let mut t = Curseur {
        position: debut_index,
        ..c
    };
    for _ in 0..nombre_index - nombre_index % 3 {
        let index = u32::from(t.u16()?);
        if index as usize >= nombre_sommets {
            return Ok(None);
        }
        triangles.push(index);
    }

    Ok(Some(Maillage {
        positions,
        uv,
        triangles,
        materiau,
        texture: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_disposition_d_un_sommet_se_calcule() {
        // Position, normale, une paire de coordonnées en demi-flottants.
        let d = disposition(0x0001_0009).unwrap();
        assert_eq!(d.taille, 12 + 12 + 4);
        assert_eq!(d.uv, Some((24, false)));
        // La position compressée vient après les coordonnées de texture.
        let d = disposition(0x1000_0100).unwrap();
        assert_eq!((d.position, d.compressee, d.taille), (8, true, 14));
        assert_eq!(disposition(0x0000_0008), None);
    }

    #[test]
    fn un_demi_flottant_se_lit() {
        assert_eq!(demi(0x3C00), 1.0);
        assert_eq!(demi(0xC000), -2.0);
        assert_eq!(demi(0x0000), 0.0);
        assert_eq!(demi(0x3800), 0.5);
    }
}
