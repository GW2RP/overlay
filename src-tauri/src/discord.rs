//! La présence Discord : ce que les amis du joueur voient sous son nom —
//! le personnage joué, ce qu'il fait en jeu de rôle, et où, s'il le partage.
//!
//! Le protocole et le fil qui tient la présence vivent dans le crate
//! `presence-discord`. Le front compose l'activité — il connaît le nom des
//! cartes, la fiche du personnage et ce que le joueur a choisi de partager —,
//! et Rust la pose : une seule connexion au client Discord pour toute
//! l'application, comme un seul lecteur du lien Mumble.

use presence_discord::{ouvrir_canal, Activite, Presence};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

/// L'application Discord du hub, celle de l'activité : son nom s'affiche dans
/// « Joue à … », et son image `gw2rp` à côté. L'identifiant est public — il
/// figure dans chaque lien d'invitation —, mais il vient de la construction :
/// une version construite sans lui n'a pas de présence, et le dit.
const ID_APPLICATION: Option<&str> = option_env!("GW2RP_DISCORD_ID");

pub struct Discord(Option<Presence>);

impl Default for Discord {
    fn default() -> Self {
        Discord(
            ID_APPLICATION
                .filter(|id| !id.is_empty())
                .map(|id| Presence::demarrer(id.to_string(), std::process::id(), ouvrir_canal)),
        )
    }
}

#[derive(Serialize)]
pub struct EtatPresence {
    /// Faux pour une version construite sans application Discord.
    disponible: bool,
    posee: bool,
    erreur: Option<String>,
}

/// Pose l'activité composée par le front, ou l'efface (`null`). Ne bloque
/// jamais : le fil de présence l'enverra quand Discord sera là.
#[tauri::command]
pub fn regler_presence(discord: State<Discord>, activite: Option<Value>) -> Result<(), String> {
    let Some(presence) = &discord.0 else {
        return Ok(());
    };
    let activite = activite.as_ref().map(Activite::depuis_json).transpose()?;
    presence.regler(activite);
    Ok(())
}

#[tauri::command]
pub fn etat_presence(discord: State<Discord>) -> EtatPresence {
    match &discord.0 {
        None => EtatPresence {
            disponible: false,
            posee: false,
            erreur: None,
        },
        Some(presence) => {
            let etat = presence.etat();
            EtatPresence {
                disponible: true,
                posee: etat.posee,
                erreur: etat.erreur,
            }
        }
    }
}
