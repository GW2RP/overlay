import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * Le décor d'un pavillon, tel que le jeu l'exporte, et ce que l'API publique
 * dit de chaque décoration.
 *
 * Le jeu écrit une disposition en XML :
 *
 * ```xml
 * <Decorations version="1" mapId="1558" mapName="Lueur de l'âtre" type="0">
 *   <prop id="805" name="Arbre vert" pos="x y z" rot="rx ry rz" scl="1.0"/>
 * </Decorations>
 * ```
 *
 * `pos` est en pouces, dans le repère de la carte (`map_rect`) : x vers l'est,
 * y vers le nord, z vers le **bas** — une altitude négative est au-dessus du
 * sol. `rot` est en radians, `scl` une échelle uniforme.
 */

export type Decoration = {
  /** Sa place dans le fichier : deux décorations identiques posées au même
   *  endroit restent deux. */
  index: number;
  id: number;
  nom: string;
  position: [number, number, number];
  rotation: [number, number, number];
  echelle: number;
};

export type Disposition = {
  carteId: number;
  carteNom: string;
  decorations: Decoration[];
};

export class ErreurDisposition extends Error {}

function triplet(valeur: string | null, quoi: string, index: number): [number, number, number] {
  const nombres = (valeur ?? "").trim().split(/\s+/).map(Number);
  if (nombres.length !== 3 || nombres.some((n) => !Number.isFinite(n))) {
    throw new ErreurDisposition(`La décoration n° ${index + 1} a une ${quoi} illisible.`);
  }
  return [nombres[0], nombres[1], nombres[2]];
}

/** Lit l'export XML du jeu. Une décoration illisible fait refuser le fichier
 *  entier : en sauter une montrerait un pavillon qui n'est pas le sien. */
export function lireDisposition(texte: string): Disposition {
  const document = new DOMParser().parseFromString(texte, "application/xml");
  if (document.querySelector("parsererror")) {
    throw new ErreurDisposition("Ce fichier n'est pas du XML lisible.");
  }
  const racine = document.documentElement;
  if (racine.nodeName !== "Decorations") {
    throw new ErreurDisposition("Ce fichier n'est pas une disposition de pavillon exportée du jeu.");
  }

  const decorations = Array.from(racine.getElementsByTagName("prop")).map((prop, index) => {
    const id = Number(prop.getAttribute("id"));
    if (!Number.isInteger(id) || id <= 0) {
      throw new ErreurDisposition(`La décoration n° ${index + 1} n'a pas d'identifiant.`);
    }
    const echelle = Number(prop.getAttribute("scl") ?? "1");
    return {
      index,
      id,
      nom: prop.getAttribute("name") ?? "",
      position: triplet(prop.getAttribute("pos"), "position", index),
      rotation: triplet(prop.getAttribute("rot"), "rotation", index),
      echelle: Number.isFinite(echelle) && echelle > 0 ? echelle : 1,
    };
  });

  return {
    carteId: Number(racine.getAttribute("mapId")) || 0,
    carteNom: racine.getAttribute("mapName") ?? "",
    decorations,
  };
}

/** Les décorations d'une disposition, une ligne par sorte, les plus nombreuses
 *  d'abord. */
export type Sorte = { id: number; nom: string; nombre: number };

export function sortesDe(disposition: Disposition): Sorte[] {
  const parId = new Map<number, Sorte>();
  for (const decoration of disposition.decorations) {
    const sorte = parId.get(decoration.id);
    if (sorte) sorte.nombre += 1;
    else parId.set(decoration.id, { id: decoration.id, nom: decoration.nom, nombre: 1 });
  }
  return [...parId.values()].sort(
    (a, b) => b.nombre - a.nombre || a.nom.localeCompare(b.nom, "fr-FR"),
  );
}

/* --- L'API publique ----------------------------------------------------------- */

const API_GW2 = "https://api.guildwars2.com/v2";
/** L'API refuse plus de deux cents identifiants par requête. */
const PAR_REQUETE = 200;

export type FicheDecoration = {
  id: number;
  name: string;
  icon: string;
  categories: number[];
};

const fiches = new Map<number, FicheDecoration>();

/** Les fiches de l'API pour ces décorations, depuis la mémoire ou l'API. Une
 *  décoration que l'API ne connaît pas — ajoutée depuis — n'a simplement pas
 *  de fiche. */
export async function lireFiches(ids: number[]): Promise<Map<number, FicheDecoration>> {
  const manquants = [...new Set(ids)].filter((id) => !fiches.has(id));
  for (let i = 0; i < manquants.length; i += PAR_REQUETE) {
    const lot = manquants.slice(i, i + PAR_REQUETE);
    const reponse = await tauriFetch(
      `${API_GW2}/homestead/decorations?ids=${lot.join(",")}&lang=fr`,
      { headers: { Accept: "application/json" } },
    );
    // 206 : une partie des identifiants est inconnue, le reste est rendu.
    if (!reponse.ok && reponse.status !== 206) {
      throw new Error(`L'API du jeu ne décrit pas les décorations (HTTP ${reponse.status}).`);
    }
    for (const fiche of (await reponse.json()) as FicheDecoration[]) {
      fiches.set(fiche.id, {
        id: fiche.id,
        name: fiche.name,
        icon: fiche.icon,
        categories: fiche.categories ?? [],
      });
    }
  }
  return new Map(ids.flatMap((id) => (fiches.has(id) ? [[id, fiches.get(id)!]] : [])));
}

/* --- L'archive du jeu ---------------------------------------------------------- */

/** Où le lanceur installe le jeu quand on ne lui dit rien. */
export const CHEMIN_ARCHIVE_PAR_DEFAUT = "C:\\Program Files\\Guild Wars 2\\Gw2.dat";

export type EtatArchive = { chemin: string; paquet: number; decorations: number };

/** Ouvre l'archive et indexe les modèles des décorations : quelques secondes
 *  la première fois, immédiat ensuite. */
export function ouvrirArchive(chemin: string, indice: number | null): Promise<EtatArchive> {
  return invoke<EtatArchive>("ouvrir_archive", { chemin, indice });
}

/** Un maillage, dans le repère du jeu : x, y, z à la suite, z vers le bas. */
export type Maillage = { positions: Float32Array; triangles: Uint32Array };

/** Le modèle d'une décoration, ou une liste vide si elle n'en a pas que
 *  l'archive sache donner. Voir `modele_decoration` pour le format. */
export async function lireModele(id: number): Promise<Maillage[]> {
  const tampon = await invoke<ArrayBuffer>("modele_decoration", { id });
  const vue = new DataView(tampon);
  let curseur = 0;
  const u32 = () => {
    const valeur = vue.getUint32(curseur, true);
    curseur += 4;
    return valeur;
  };

  const maillages: Maillage[] = [];
  const nombre = u32();
  for (let i = 0; i < nombre; i++) {
    const sommets = u32();
    const index = u32();
    // Copiés : le tampon reçu n'est pas forcément aligné sur quatre octets.
    const positions = new Float32Array(tampon.slice(curseur, curseur + sommets * 12));
    curseur += sommets * 12;
    const triangles = new Uint32Array(tampon.slice(curseur, curseur + index * 4));
    curseur += index * 4;
    maillages.push({ positions, triangles });
  }
  return maillages;
}
