//! Les modèles : les fichiers PF de type `MODL`, et leur bloc de géométrie
//! (`GEOM`).
//!
//! Un modèle est une liste de maillages. Chacun porte ses sommets dans un
//! format que décrit un mot de drapeaux (`fvf`) — position, normales, poids,
//! coordonnées de texture… —, ses triangles en index de 16 bits, et l'index de
//! son matériau. On n'en garde que la forme : positions et triangles. Les
//! positions sont dans le repère du jeu, en pouces, z vers le bas.

use crate::pf::{Curseur, ErreurPf, FichierPf};

/// Position en trois flottants de 32 bits.
const FVF_POSITION: u32 = 0x0000_0001;
/// Position en trois flottants de 16 bits.
const FVF_POSITION_COMPRESSEE: u32 = 0x1000_0000;

#[derive(Debug, Clone, Default)]
pub struct Maillage {
    /// x, y, z à la suite.
    pub positions: Vec<f32>,
    /// Trois index par triangle.
    pub triangles: Vec<u32>,
    pub materiau: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Modele {
    pub maillages: Vec<Maillage>,
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

/// Lit la géométrie d'un fichier de modèle. Un maillage dont la position n'est
/// pas en tête de sommet — un format qu'on ne connaît pas — est laissé de côté
/// plutôt que lu de travers.
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
        if let Some(maillage) = lire_maillage(fichier.curseur(position))? {
            maillages.push(maillage);
        }
    }
    Ok(Some(Modele { maillages }))
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
    let complete = fvf & FVF_POSITION != 0;
    let compressee = fvf & FVF_POSITION_COMPRESSEE != 0;
    if !complete && !compressee {
        return Ok(None);
    }
    // Un sommet porte au moins sa position : un pas plus court annonce plus
    // de sommets que le tableau n'en contient.
    if pas < if complete { 12 } else { 6 } {
        return Ok(None);
    }

    let mut positions = Vec::with_capacity(nombre_sommets * 3);
    for i in 0..nombre_sommets {
        let mut s = Curseur {
            position: debut_sommets + i * pas,
            ..c
        };
        if complete {
            positions.extend([s.f32()?, s.f32()?, s.f32()?]);
        } else {
            positions.extend([demi(s.u16()?), demi(s.u16()?), demi(s.u16()?)]);
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
        triangles,
        materiau,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_demi_flottant_se_lit() {
        assert_eq!(demi(0x3C00), 1.0);
        assert_eq!(demi(0xC000), -2.0);
        assert_eq!(demi(0x0000), 0.0);
        assert_eq!(demi(0x3800), 0.5);
    }
}
