import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/**
 * Le lien Mumble du jeu, tel que Rust l'émet (`src-tauri/src/mumble.rs`).
 *
 * Un seul lecteur, côté Rust, lit la mémoire partagée quatre fois par seconde
 * et l'envoie à toutes les fenêtres sur l'évènement `mumble`. Les noms de
 * champs sont ceux de la structure Rust, en `snake_case`.
 */

export const EVENEMENT_MUMBLE = "mumble";

export type IdentiteMumble = {
  name: string;
  profession: number;
  spec: number;
  race: number;
  map_id: number;
  world_id: number;
  team_color_id: number;
  commander: boolean;
  fov: number;
  uisz: number;
};

export type LienMumble = {
  tick: number;
  /** Vrai si le compteur d'images du jeu a avancé depuis la lecture d'avant. */
  actif: boolean;
  avatar_position: [number, number, number];
  avatar_front: [number, number, number];
  identite: IdentiteMumble | null;
  map_id: number;
  map_type: number;
  shard_id: number;
  build_id: number;
  etat: {
    carte_ouverte: boolean;
    jeu_au_premier_plan: boolean;
    mode_competitif: boolean;
    champ_de_texte_actif: boolean;
    en_combat: boolean;
  };
  /** La position dans le repère de `map_rect` de l'API du jeu. */
  player_x: number;
  player_y: number;
  map_center_x: number;
  map_center_y: number;
  map_scale: number;
  mount_index: number;
};

/** `undefined` tant que rien n'est arrivé, `null` quand le jeu n'écrit pas. */
export function useMumble(): LienMumble | null | undefined {
  const [lien, setLien] = useState<LienMumble | null | undefined>(undefined);

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;

    // Une lecture tout de suite : la fenêtre qui s'ouvre n'attend pas le
    // prochain quart de seconde.
    void invoke<LienMumble | null>("lire_mumble")
      .then((initial) => {
        if (!parti) setLien((courant) => (courant === undefined ? initial : courant));
      })
      .catch((erreur) => console.error("le lien Mumble ne se lit pas", erreur));

    void listen<LienMumble | null>(EVENEMENT_MUMBLE, (evenement) => setLien(evenement.payload))
      .then((stop) => {
        if (parti) stop();
        else arreter = stop;
      })
      .catch((erreur) => console.error("le lien Mumble ne s'écoute pas", erreur));

    return () => {
      parti = true;
      arreter?.();
    };
  }, []);

  return lien;
}
