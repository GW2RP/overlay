//! Le lien Mumble de Guild Wars 2.
//!
//! Le jeu écrit, à chaque image, un bloc de mémoire partagée nommé
//! `MumbleLink` — le protocole du logiciel de voix Mumble, que Guild Wars 2
//! reprend et complète d'un contexte à lui. On y lit la position du
//! personnage, la carte où il se tient, son nom, sa profession. Rien n'est
//! injecté dans le jeu, rien n'est lu dans sa mémoire à lui : c'est un bloc
//! que le jeu publie pour qui veut le lire.
//!
//! Le bloc n'existe que sous Windows, comme le jeu. Ailleurs, `lire` rend
//! `None` : l'application se développe alors sans lien, et l'écran le dit.
//!
//! La disposition du bloc est celle du protocole Mumble, en petit-boutiste, et
//! **elle ne se réordonne pas** : le jeu écrit à ces décalages-là.
//!
//! ```text
//!    0  uiVersion         u32
//!    4  uiTick            u32        avance à chaque image du jeu
//!    8  fAvatarPosition   3 × f32    mètres, axes x / hauteur / y
//!   20  fAvatarFront      3 × f32
//!   32  fAvatarTop        3 × f32
//!   44  name              256 × u16  « Guild Wars 2 »
//!  556  fCameraPosition   3 × f32
//!  568  fCameraFront      3 × f32
//!  580  fCameraTop        3 × f32
//!  592  identity          256 × u16  JSON : nom, profession, race, carte…
//! 1104  context_len       u32
//! 1108  context           256 × u8   le contexte propre au jeu, ci-dessous
//! 1364  description       2048 × u16
//! 5460  fin
//! ```
//!
//! Le contexte du jeu, dans les 256 octets de `context` :
//!
//! ```text
//!    0  serverAddress     28 × u8    sockaddr_in
//!   28  mapId             u32
//!   32  mapType           u32
//!   36  shardId           u32
//!   40  instance          u32
//!   44  buildId           u32
//!   48  uiState           u32        bits : carte ouverte, boussole en haut à
//!                                    droite, rotation de la boussole, jeu au
//!                                    premier plan, mode compétitif, champ de
//!                                    texte actif, en combat
//!   52  compassWidth      u16
//!   54  compassHeight     u16
//!   56  compassRotation   f32
//!   60  playerX           f32        pixels de continent
//!   64  playerY           f32
//!   68  mapCenterX        f32        pixels de continent
//!   72  mapCenterY        f32
//!   76  mapScale          f32
//!   80  processId         u32
//!   84  mountIndex        u8
//! ```
//!
//! `playerX` / `playerY` sont **en pixels de continent** — le repère de la
//! carte du jeu, et celui du hub —, pas en mètres comme `fAvatarPosition` :
//! le jeu les a déjà projetés pour sa carte, et le front les lit tels quels
//! (`src/lib/carte.ts`). Les reprojeter par `map_rect` / `continent_rect`
//! donnerait un point crédible et faux.

use serde::{Deserialize, Serialize};

/// La taille du bloc, et ce qu'il faut lire : trop court, on lirait des zéros
/// crédibles à la place de la position.
pub const TAILLE: usize = 5460;

const DECALAGE_VERSION: usize = 0;
const DECALAGE_TICK: usize = 4;
const DECALAGE_AVATAR_POSITION: usize = 8;
const DECALAGE_AVATAR_FRONT: usize = 20;
const DECALAGE_NOM: usize = 44;
const DECALAGE_IDENTITE: usize = 592;
const DECALAGE_CONTEXTE: usize = 1108;
const LONGUEUR_NOM: usize = 256;
const LONGUEUR_IDENTITE: usize = 256;

const CONTEXTE_MAP_ID: usize = 28;
const CONTEXTE_MAP_TYPE: usize = 32;
const CONTEXTE_SHARD_ID: usize = 36;
const CONTEXTE_BUILD_ID: usize = 44;
const CONTEXTE_UI_STATE: usize = 48;
const CONTEXTE_PLAYER_X: usize = 60;
const CONTEXTE_PLAYER_Y: usize = 64;
const CONTEXTE_MAP_CENTER_X: usize = 68;
const CONTEXTE_MAP_CENTER_Y: usize = 72;
const CONTEXTE_MAP_SCALE: usize = 76;
const CONTEXTE_MOUNT_INDEX: usize = 84;

/// Ce que le jeu range dans `identity`, tel qu'il l'écrit : les noms de champs
/// sont les siens, en anglais, et ne se traduisent pas ici.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Identite {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub profession: u32,
    #[serde(default)]
    pub spec: u32,
    #[serde(default)]
    pub race: u32,
    #[serde(default)]
    pub map_id: u32,
    #[serde(default)]
    pub world_id: u64,
    #[serde(default)]
    pub team_color_id: u32,
    #[serde(default)]
    pub commander: bool,
    #[serde(default)]
    pub fov: f32,
    #[serde(default)]
    pub uisz: u32,
}

/// Les bits de `uiState`, nommés.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct EtatInterface {
    pub carte_ouverte: bool,
    pub jeu_au_premier_plan: bool,
    pub mode_competitif: bool,
    pub champ_de_texte_actif: bool,
    pub en_combat: bool,
}

impl EtatInterface {
    fn depuis(bits: u32) -> Self {
        Self {
            carte_ouverte: bits & 0b0000_0001 != 0,
            jeu_au_premier_plan: bits & 0b0000_1000 != 0,
            mode_competitif: bits & 0b0001_0000 != 0,
            champ_de_texte_actif: bits & 0b0010_0000 != 0,
            en_combat: bits & 0b0100_0000 != 0,
        }
    }
}

/// Une lecture du lien, telle qu'elle part au front.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Lien {
    /// Le compteur d'images du jeu. S'il ne bouge plus d'une lecture à
    /// l'autre, le jeu est fermé, ou figé sur un écran de chargement.
    pub tick: u32,
    /// Vrai si `tick` a avancé depuis la lecture précédente.
    pub actif: bool,
    /// Position du personnage en mètres, dans le repère du jeu.
    pub avatar_position: [f32; 3],
    /// Direction du regard du personnage, vecteur unitaire.
    pub avatar_front: [f32; 3],
    pub identite: Option<Identite>,
    pub map_id: u32,
    pub map_type: u32,
    pub shard_id: u32,
    pub build_id: u32,
    pub etat: EtatInterface,
    /// La position en pixels de continent, celle de la carte du jeu.
    pub player_x: f32,
    pub player_y: f32,
    pub map_center_x: f32,
    pub map_center_y: f32,
    pub map_scale: f32,
    pub mount_index: u8,
}

fn u32_a(bloc: &[u8], decalage: usize) -> u32 {
    u32::from_le_bytes([
        bloc[decalage],
        bloc[decalage + 1],
        bloc[decalage + 2],
        bloc[decalage + 3],
    ])
}

fn f32_a(bloc: &[u8], decalage: usize) -> f32 {
    f32::from_le_bytes([
        bloc[decalage],
        bloc[decalage + 1],
        bloc[decalage + 2],
        bloc[decalage + 3],
    ])
}

fn vecteur_a(bloc: &[u8], decalage: usize) -> [f32; 3] {
    [
        f32_a(bloc, decalage),
        f32_a(bloc, decalage + 4),
        f32_a(bloc, decalage + 8),
    ]
}

/// Une chaîne UTF-16 terminée par un zéro, ou par la fin du champ.
fn utf16_a(bloc: &[u8], decalage: usize, longueur: usize) -> String {
    let mut unites = Vec::with_capacity(longueur);
    for i in 0..longueur {
        let unite = u16::from_le_bytes([bloc[decalage + 2 * i], bloc[decalage + 2 * i + 1]]);
        if unite == 0 {
            break;
        }
        unites.push(unite);
    }
    String::from_utf16_lossy(&unites)
}

/// Lit le bloc tel que le jeu l'a écrit.
///
/// `tick_precedent` sert à dire si le jeu tourne : le compteur d'images avance
/// à chaque image, donc un compteur immobile entre deux lectures à un quart de
/// seconde d'écart veut dire que rien n'écrit plus le bloc.
///
/// Rend `None` quand le bloc est vide — `uiVersion` à zéro — ou trop court, ou
/// quand il n'est pas celui de Guild Wars 2 : un autre jeu parlant Mumble
/// remplirait les mêmes champs avec un contexte qui n'a pas ce sens.
pub fn decoder(bloc: &[u8], tick_precedent: Option<u32>) -> Option<Lien> {
    if bloc.len() < TAILLE {
        return None;
    }
    if u32_a(bloc, DECALAGE_VERSION) == 0 {
        return None;
    }
    if utf16_a(bloc, DECALAGE_NOM, LONGUEUR_NOM) != "Guild Wars 2" {
        return None;
    }

    let tick = u32_a(bloc, DECALAGE_TICK);
    let contexte = &bloc[DECALAGE_CONTEXTE..DECALAGE_CONTEXTE + 256];
    let identite_brute = utf16_a(bloc, DECALAGE_IDENTITE, LONGUEUR_IDENTITE);
    // Une identité illisible n'invalide pas la position : le jeu l'écrit
    // parfois à moitié pendant un changement de carte.
    let identite = serde_json::from_str::<Identite>(&identite_brute).ok();

    Some(Lien {
        tick,
        actif: tick_precedent.is_some_and(|precedent| precedent != tick),
        avatar_position: vecteur_a(bloc, DECALAGE_AVATAR_POSITION),
        avatar_front: vecteur_a(bloc, DECALAGE_AVATAR_FRONT),
        identite,
        map_id: u32_a(contexte, CONTEXTE_MAP_ID),
        map_type: u32_a(contexte, CONTEXTE_MAP_TYPE),
        shard_id: u32_a(contexte, CONTEXTE_SHARD_ID),
        build_id: u32_a(contexte, CONTEXTE_BUILD_ID),
        etat: EtatInterface::depuis(u32_a(contexte, CONTEXTE_UI_STATE)),
        player_x: f32_a(contexte, CONTEXTE_PLAYER_X),
        player_y: f32_a(contexte, CONTEXTE_PLAYER_Y),
        map_center_x: f32_a(contexte, CONTEXTE_MAP_CENTER_X),
        map_center_y: f32_a(contexte, CONTEXTE_MAP_CENTER_Y),
        map_scale: f32_a(contexte, CONTEXTE_MAP_SCALE),
        mount_index: contexte[CONTEXTE_MOUNT_INDEX],
    })
}

/// Le bloc de mémoire partagée, ouvert une fois et relu à chaque pas.
pub struct Lecteur {
    #[cfg(windows)]
    vue: fenetre::Vue,
    tick_precedent: Option<u32>,
}

impl Lecteur {
    /// Ouvre le bloc — ou le crée, s'il n'existe pas encore : c'est la façon
    /// convenue de le lire avant que le jeu ne soit lancé. Le jeu, en
    /// démarrant, ouvre celui qui existe et y écrit.
    pub fn ouvrir() -> Result<Self, String> {
        Ok(Self {
            #[cfg(windows)]
            vue: fenetre::Vue::ouvrir()?,
            tick_precedent: None,
        })
    }

    /// La lecture du moment, ou `None` si rien n'écrit le bloc.
    pub fn lire(&mut self) -> Option<Lien> {
        let bloc = self.bloc()?;
        let lien = decoder(&bloc, self.tick_precedent);
        self.tick_precedent = lien.as_ref().map(|lien| lien.tick);
        lien
    }

    #[cfg(windows)]
    fn bloc(&self) -> Option<Vec<u8>> {
        Some(self.vue.copier())
    }

    #[cfg(not(windows))]
    fn bloc(&self) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(windows)]
mod fenetre {
    //! La mémoire partagée de Windows, et rien d'autre : `CreateFileMappingW`
    //! sur un objet nommé, sans fichier derrière, puis une vue en lecture.

    use windows::core::w;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::System::Memory::{
        CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_READ,
        MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
    };

    use super::TAILLE;

    pub struct Vue {
        handle: HANDLE,
        adresse: MEMORY_MAPPED_VIEW_ADDRESS,
    }

    // La vue ne porte qu'une adresse et un handle, lus depuis un seul fil :
    // le fil de lecture les possède, et rien d'autre n'y touche.
    unsafe impl Send for Vue {}

    impl Vue {
        pub fn ouvrir() -> Result<Self, String> {
            // SAFETY : les arguments sont ceux du protocole — un objet nommé,
            // sans fichier, à la taille du bloc — et le handle rendu est
            // refermé par `Drop`.
            let handle = unsafe {
                CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    None,
                    PAGE_READWRITE,
                    0,
                    TAILLE as u32,
                    w!("MumbleLink"),
                )
            }
            .map_err(|erreur| {
                format!("la mémoire partagée MumbleLink ne s'ouvre pas : {erreur}")
            })?;

            // SAFETY : le handle vient d'être ouvert et n'est pas encore
            // partagé ; la vue est refermée avec lui par `Drop`.
            let adresse = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, TAILLE) };
            if adresse.Value.is_null() {
                // SAFETY : le handle est valide et ne sera plus utilisé.
                let _ = unsafe { CloseHandle(handle) };
                return Err("la vue sur MumbleLink n'a pas pu être posée".to_string());
            }

            Ok(Self { handle, adresse })
        }

        /// Une copie du bloc : on ne lit jamais dedans deux fois, le jeu
        /// l'écrit pendant qu'on le lit.
        pub fn copier(&self) -> Vec<u8> {
            let mut bloc = vec![0u8; TAILLE];
            // SAFETY : la vue est posée sur `TAILLE` octets lisibles, et le
            // tampon en fait autant.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    self.adresse.Value as *const u8,
                    bloc.as_mut_ptr(),
                    TAILLE,
                );
            }
            bloc
        }
    }

    impl Drop for Vue {
        fn drop(&mut self) {
            // SAFETY : la vue et le handle ont été ouverts par `ouvrir` et ne
            // sont plus utilisés après ceci.
            unsafe {
                let _ = UnmapViewOfFile(self.adresse);
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bloc_de_test() -> Vec<u8> {
        let mut bloc = vec![0u8; TAILLE];
        bloc[DECALAGE_VERSION..DECALAGE_VERSION + 4].copy_from_slice(&2u32.to_le_bytes());
        bloc[DECALAGE_TICK..DECALAGE_TICK + 4].copy_from_slice(&41u32.to_le_bytes());
        for (i, unite) in "Guild Wars 2".encode_utf16().enumerate() {
            let debut = DECALAGE_NOM + 2 * i;
            bloc[debut..debut + 2].copy_from_slice(&unite.to_le_bytes());
        }
        let identite = r#"{"name":"Aelis","profession":6,"spec":0,"race":2,"map_id":15,"world_id":2008,"team_color_id":0,"commander":false,"fov":0.873,"uisz":1}"#;
        for (i, unite) in identite.encode_utf16().enumerate() {
            let debut = DECALAGE_IDENTITE + 2 * i;
            bloc[debut..debut + 2].copy_from_slice(&unite.to_le_bytes());
        }
        let contexte = DECALAGE_CONTEXTE;
        bloc[contexte + CONTEXTE_MAP_ID..contexte + CONTEXTE_MAP_ID + 4]
            .copy_from_slice(&15u32.to_le_bytes());
        bloc[contexte + CONTEXTE_UI_STATE..contexte + CONTEXTE_UI_STATE + 4]
            .copy_from_slice(&0b0100_1000u32.to_le_bytes());
        bloc[contexte + CONTEXTE_PLAYER_X..contexte + CONTEXTE_PLAYER_X + 4]
            .copy_from_slice(&(-1234.5f32).to_le_bytes());
        bloc[contexte + CONTEXTE_PLAYER_Y..contexte + CONTEXTE_PLAYER_Y + 4]
            .copy_from_slice(&789.25f32.to_le_bytes());
        bloc
    }

    #[test]
    fn decode_un_bloc_du_jeu() {
        let lien = decoder(&bloc_de_test(), Some(40)).expect("un lien");
        assert_eq!(lien.tick, 41);
        assert!(lien.actif);
        assert_eq!(lien.map_id, 15);
        assert_eq!(lien.player_x, -1234.5);
        assert_eq!(lien.player_y, 789.25);
        assert!(lien.etat.jeu_au_premier_plan);
        assert!(lien.etat.en_combat);
        assert!(!lien.etat.carte_ouverte);
        let identite = lien.identite.expect("une identité");
        assert_eq!(identite.name, "Aelis");
        assert_eq!(identite.profession, 6);
        assert_eq!(identite.race, 2);
    }

    #[test]
    fn un_tick_immobile_dit_que_le_jeu_ne_tourne_pas() {
        let lien = decoder(&bloc_de_test(), Some(41)).expect("un lien");
        assert!(!lien.actif);
    }

    #[test]
    fn un_bloc_vide_ne_rend_rien() {
        assert!(decoder(&vec![0u8; TAILLE], None).is_none());
    }

    #[test]
    fn un_autre_jeu_ne_rend_rien() {
        let mut bloc = bloc_de_test();
        for i in 0..LONGUEUR_NOM {
            let debut = DECALAGE_NOM + 2 * i;
            bloc[debut..debut + 2].copy_from_slice(&0u16.to_le_bytes());
        }
        for (i, unite) in "Mumble".encode_utf16().enumerate() {
            let debut = DECALAGE_NOM + 2 * i;
            bloc[debut..debut + 2].copy_from_slice(&unite.to_le_bytes());
        }
        assert!(decoder(&bloc, None).is_none());
    }

    #[test]
    fn une_identite_illisible_garde_la_position() {
        let mut bloc = bloc_de_test();
        for i in 0..LONGUEUR_IDENTITE {
            let debut = DECALAGE_IDENTITE + 2 * i;
            bloc[debut..debut + 2].copy_from_slice(&0u16.to_le_bytes());
        }
        for (i, unite) in "{\"name\":".encode_utf16().enumerate() {
            let debut = DECALAGE_IDENTITE + 2 * i;
            bloc[debut..debut + 2].copy_from_slice(&unite.to_le_bytes());
        }
        let lien = decoder(&bloc, None).expect("un lien");
        assert!(lien.identite.is_none());
        assert_eq!(lien.map_id, 15);
    }
}
