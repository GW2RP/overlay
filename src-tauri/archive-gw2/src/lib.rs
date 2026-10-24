//! Lecture de l'archive `Gw2.dat` de Guild Wars 2.
//!
//! L'overlay y lit les modèles des décorations du pavillon, sur la machine où
//! le jeu est installé : rien n'en est extrait ni redistribué. Le crate ne
//! connaît que le format — l'archive, la décompression, les fichiers PF et le
//! contenu de jeu — et rien de l'interface.

pub mod archive;
pub mod contenu;
pub mod decompression;
pub mod decorations;
pub mod modele;
pub mod pf;

pub use archive::{Archive, ErreurArchive, Fichier};
