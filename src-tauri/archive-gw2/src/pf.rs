//! Les fichiers « PF » : le conteneur de presque tout ce que l'archive range
//! — modèles, matériaux, contenu de jeu. Un en-tête, puis une suite de blocs
//! nommés de quatre lettres, chacun avec sa version.
//!
//! Dans un bloc, les structures se relient par des décalages relatifs à
//! l'endroit où ils sont écrits, sur 32 ou 64 bits selon l'en-tête du fichier.

use std::fmt;

const TAILLE_ENTETE: usize = 12;
const TAILLE_ENTETE_BLOC: usize = 16;
/// Le bit de l'en-tête qui passe les décalages sur 64 bits.
const DRAPEAU_64_BITS: u16 = 0x4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErreurPf {
    PasUnPf,
    HorsLimites(&'static str),
}

impl fmt::Display for ErreurPf {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PasUnPf => write!(f, "pas un fichier PF"),
            Self::HorsLimites(quoi) => write!(f, "{quoi} hors du fichier"),
        }
    }
}

impl std::error::Error for ErreurPf {}

#[derive(Debug, Clone)]
pub struct Bloc {
    pub nom: [u8; 4],
    pub version: u16,
    /// Où commencent les données du bloc, en octets depuis le début du fichier.
    pub debut: usize,
    pub fin: usize,
}

impl Bloc {
    pub fn nom(&self) -> String {
        String::from_utf8_lossy(&self.nom)
            .trim_end_matches('\0')
            .to_string()
    }
}

#[derive(Debug, Clone)]
pub struct FichierPf<'a> {
    pub octets: &'a [u8],
    pub type_: [u8; 4],
    pub larges: bool,
    pub blocs: Vec<Bloc>,
}

/// Le type d'un fichier PF, lu sur ses douze premiers octets.
pub fn type_pf(octets: &[u8]) -> Option<[u8; 4]> {
    if octets.len() < TAILLE_ENTETE || &octets[0..2] != b"PF" {
        return None;
    }
    Some([octets[8], octets[9], octets[10], octets[11]])
}

impl<'a> FichierPf<'a> {
    pub fn lire(octets: &'a [u8]) -> Result<Self, ErreurPf> {
        let type_ = type_pf(octets).ok_or(ErreurPf::PasUnPf)?;
        let drapeaux = u16::from_le_bytes([octets[2], octets[3]]);

        let mut blocs = Vec::new();
        let mut position = TAILLE_ENTETE;
        while position + TAILLE_ENTETE_BLOC <= octets.len() {
            let o = &octets[position..];
            let nom = [o[0], o[1], o[2], o[3]];
            let taille = u32::from_le_bytes([o[4], o[5], o[6], o[7]]) as usize;
            let version = u16::from_le_bytes([o[8], o[9]]);
            let taille_entete = u16::from_le_bytes([o[10], o[11]]) as usize;
            // La taille d'un bloc se compte après ses huit premiers octets.
            let fin = position + 8 + taille;
            if fin > octets.len() {
                return Err(ErreurPf::HorsLimites("bloc"));
            }
            blocs.push(Bloc {
                nom,
                version,
                debut: position + taille_entete,
                fin,
            });
            position = fin;
        }

        Ok(Self {
            octets,
            type_,
            larges: drapeaux & DRAPEAU_64_BITS != 0,
            blocs,
        })
    }

    pub fn type_(&self) -> String {
        String::from_utf8_lossy(&self.type_)
            .trim_end_matches('\0')
            .to_string()
    }

    pub fn bloc(&self, nom: &str) -> Option<&Bloc> {
        self.blocs
            .iter()
            .find(|b| b.nom().eq_ignore_ascii_case(nom))
    }

    pub fn curseur(&self, position: usize) -> Curseur<'a> {
        Curseur {
            octets: self.octets,
            position,
            larges: self.larges,
        }
    }
}

/// Lit des champs à la suite, et suit les décalages.
#[derive(Debug, Clone, Copy)]
pub struct Curseur<'a> {
    pub octets: &'a [u8],
    pub position: usize,
    pub larges: bool,
}

impl<'a> Curseur<'a> {
    pub fn taille_pointeur(&self) -> usize {
        if self.larges {
            8
        } else {
            4
        }
    }

    fn prendre(&mut self, n: usize) -> Result<&'a [u8], ErreurPf> {
        let tranche = self
            .octets
            .get(self.position..self.position + n)
            .ok_or(ErreurPf::HorsLimites("champ"))?;
        self.position += n;
        Ok(tranche)
    }

    pub fn u8(&mut self) -> Result<u8, ErreurPf> {
        Ok(self.prendre(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, ErreurPf> {
        let o = self.prendre(2)?;
        Ok(u16::from_le_bytes([o[0], o[1]]))
    }

    pub fn u32(&mut self) -> Result<u32, ErreurPf> {
        let o = self.prendre(4)?;
        Ok(u32::from_le_bytes([o[0], o[1], o[2], o[3]]))
    }

    pub fn f32(&mut self) -> Result<f32, ErreurPf> {
        Ok(f32::from_bits(self.u32()?))
    }

    pub fn sauter(&mut self, n: usize) -> Result<(), ErreurPf> {
        self.prendre(n).map(|_| ())
    }

    /// Un décalage relatif à sa propre position ; `None` s'il est nul.
    pub fn pointeur(&mut self) -> Result<Option<usize>, ErreurPf> {
        let ici = self.position;
        let decalage: i64 = if self.larges {
            let o = self.prendre(8)?;
            i64::from_le_bytes([o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7]])
        } else {
            i64::from(self.u32()? as i32)
        };
        if decalage == 0 {
            return Ok(None);
        }
        let cible = ici as i64 + decalage;
        if cible < 0 || cible as usize >= self.octets.len() {
            return Err(ErreurPf::HorsLimites("pointeur"));
        }
        Ok(Some(cible as usize))
    }

    /// Un tableau : son compte, puis un décalage vers son premier élément.
    /// Rend la position du premier élément et le compte.
    pub fn tableau(&mut self) -> Result<(usize, usize), ErreurPf> {
        let nombre = self.u32()? as usize;
        let debut = self.pointeur()?;
        Ok(match debut {
            Some(debut) => (debut, nombre),
            None => (0, 0),
        })
    }

    /// Un nom de fichier : un pointeur vers deux mots de 16 bits qui encodent
    /// le numéro du fichier visé.
    pub fn reference_fichier(&mut self) -> Result<Option<u32>, ErreurPf> {
        let Some(cible) = self.pointeur()? else {
            return Ok(None);
        };
        let mut c = Curseur {
            position: cible,
            ..*self
        };
        Ok(decoder_nom_de_fichier(c.u16()?, c.u16()?))
    }

    /// Une chaîne UTF-16 terminée par un zéro, derrière un pointeur.
    pub fn chaine16(&mut self) -> Result<Option<String>, ErreurPf> {
        let Some(cible) = self.pointeur()? else {
            return Ok(None);
        };
        let mut c = Curseur {
            position: cible,
            ..*self
        };
        let mut unites = Vec::new();
        loop {
            let unite = c.u16()?;
            if unite == 0 {
                break;
            }
            unites.push(unite);
        }
        Ok(Some(String::from_utf16_lossy(&unites)))
    }
}

/// Les deux mots d'un nom de fichier, chacun décalé de 0x100 pour ne jamais
/// valoir zéro, comptent en base 0xFF00.
pub fn decoder_nom_de_fichier(bas: u16, haut: u16) -> Option<u32> {
    if bas < 0x100 || haut < 0x100 {
        return None;
    }
    let numero = 0xFF00 * (u32::from(haut) - 0x100) + (u32::from(bas) - 0x100) + 1;
    Some(numero)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_nom_de_fichier_se_decode() {
        assert_eq!(decoder_nom_de_fichier(0x100, 0x100), Some(1));
        assert_eq!(decoder_nom_de_fichier(0x101, 0x101), Some(0xFF00 + 2));
        assert_eq!(decoder_nom_de_fichier(0, 0x100), None);
    }

    #[test]
    fn un_pointeur_negatif_remonte() {
        let mut octets = vec![0u8; 16];
        octets[8..12].copy_from_slice(&(-8i32).to_le_bytes());
        let mut c = Curseur {
            octets: &octets,
            position: 8,
            larges: false,
        };
        assert_eq!(c.pointeur().unwrap(), Some(0));
    }
}
