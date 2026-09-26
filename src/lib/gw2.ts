import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { useEffect, useState } from "react";

import { ecrireCarte, lireCartes } from "@/lib/reglages";

/**
 * L'API publique du jeu, pour la seule chose que le lien Mumble ne dit pas :
 * **où la carte se pose sur le continent**. Le lien donne la position dans le
 * repère de la carte (`map_rect`) ; l'API donne le rectangle que cette carte
 * occupe sur le continent (`continent_rect`), en pixels de continent — les
 * mêmes que ceux du hub.
 */

const API_GW2 = "https://api.guildwars2.com/v2";

/** Un rectangle de l'API : `[[x1, y1], [x2, y2]]`. */
export type Rectangle = [[number, number], [number, number]];

export type CarteGw2 = {
  id: number;
  name: string;
  continent_id: number;
  continent_name: string;
  region_id: number;
  region_name: string;
  map_rect: Rectangle;
  continent_rect: Rectangle;
};

const enMemoire = new Map<number, CarteGw2>();
const enCours = new Map<number, Promise<CarteGw2>>();

function garder(carte: CarteGw2): CarteGw2 {
  return {
    id: carte.id,
    name: carte.name,
    continent_id: carte.continent_id,
    continent_name: carte.continent_name,
    region_id: carte.region_id,
    region_name: carte.region_name,
    map_rect: carte.map_rect,
    continent_rect: carte.continent_rect,
  };
}

/** La description d'une carte, depuis la mémoire, le magasin, ou l'API. */
export function lireCarte(id: number): Promise<CarteGw2> {
  const connue = enMemoire.get(id);
  if (connue) return Promise.resolve(connue);

  const attendue = enCours.get(id);
  if (attendue) return attendue;

  const promesse = (async () => {
    const rangees = await lireCartes<CarteGw2>();
    const rangee = rangees[String(id)];
    if (rangee) {
      enMemoire.set(id, rangee);
      return rangee;
    }

    const reponse = await tauriFetch(`${API_GW2}/maps/${id}?lang=fr`, {
      headers: { Accept: "application/json" },
    });
    if (!reponse.ok) {
      throw new Error(`L'API du jeu ne décrit pas la carte ${id} (HTTP ${reponse.status}).`);
    }
    const carte = garder((await reponse.json()) as CarteGw2);
    enMemoire.set(id, carte);
    await ecrireCarte(id, carte);
    return carte;
  })().finally(() => enCours.delete(id));

  enCours.set(id, promesse);
  return promesse;
}

/** La carte d'un identifiant, ou `undefined` en attendant, ou `null` si l'API
 *  ne la décrit pas. Un identifiant à zéro — l'écran de sélection du
 *  personnage — n'est pas une carte. */
export function useCarte(id: number | null): CarteGw2 | null | undefined {
  // Ce que ce composant a déjà obtenu, par identifiant : `null` pour une carte
  // que l'API ne décrit pas. Le résultat se lit dans cette table, jamais posé
  // dans l'effet lui-même.
  const [connues, setConnues] = useState<Record<number, CarteGw2 | null>>({});

  useEffect(() => {
    if (!id || id in connues) return;
    let parti = false;
    lireCarte(id)
      .then((trouvee) => {
        if (!parti) setConnues((courantes) => ({ ...courantes, [id]: trouvee }));
      })
      .catch((erreur) => {
        console.error(erreur);
        if (!parti) setConnues((courantes) => ({ ...courantes, [id]: null }));
      });
    return () => {
      parti = true;
    };
  }, [id, connues]);

  if (!id) return null;
  return connues[id] ?? enMemoire.get(id);
}
