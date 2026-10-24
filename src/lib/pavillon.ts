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
  /** Son identité dans l'éditeur, donnée à la lecture ou à l'ajout et jamais
   *  reprise : deux décorations identiques posées au même endroit restent
   *  deux, et l'ordre du fichier peut changer sans qu'elles se confondent. */
  cle: number;
  id: number;
  nom: string;
  position: [number, number, number];
  rotation: [number, number, number];
  echelle: number;
};

export type Disposition = {
  /** `null` quand le fichier ne la nomme pas : on ne lui en invente pas. */
  carteId: number | null;
  carteNom: string;
  /** Les attributs de l'en-tête tels qu'écrits, réécrits tels quels à
   *  l'export : ce que l'éditeur ne comprend pas, il ne le change pas. */
  entete: { version: string; mapId: string; mapName: string; type: string };
  decorations: Decoration[];
};

/** Les clés se donnent à la suite, pour toute la session : une décoration
 *  ajoutée ne reprend jamais la clé d'une autre, retirée ou non. */
let derniereCle = 0;
export function nouvelleCle(): number {
  derniereCle += 1;
  return derniereCle;
}

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

  const decorations = Array.from(racine.getElementsByTagName("prop")).map((prop, index): Decoration => {
    const id = Number(prop.getAttribute("id"));
    if (!Number.isInteger(id) || id <= 0) {
      throw new ErreurDisposition(`La décoration n° ${index + 1} n'a pas d'identifiant.`);
    }
    const echelle = Number(prop.getAttribute("scl") ?? "1");
    return {
      cle: nouvelleCle(),
      id,
      nom: prop.getAttribute("name") ?? "",
      position: triplet(prop.getAttribute("pos"), "position", index),
      rotation: triplet(prop.getAttribute("rot"), "rotation", index),
      echelle: Number.isFinite(echelle) && echelle > 0 ? echelle : 1,
    };
  });

  return {
    carteId: Number(racine.getAttribute("mapId")) || null,
    carteNom: racine.getAttribute("mapName") ?? "",
    entete: {
      version: racine.getAttribute("version") ?? "1",
      mapId: racine.getAttribute("mapId") ?? "",
      mapName: racine.getAttribute("mapName") ?? "",
      type: racine.getAttribute("type") ?? "0",
    },
    decorations,
  };
}

/* --- L'écriture ---------------------------------------------------------------- */

/** Le jeu échelonne par 252e : chaque échelle de ses exports en est un
 *  multiple entier (0,214286 = 54/252, 2,003968 = 505/252). */
export const PAS_ECHELLE = 1 / 252;

export function arrondirEchelle(echelle: number): number {
  return Math.max(1, Math.round(echelle / PAS_ECHELLE)) * PAS_ECHELLE;
}

const TOUR = 2 * Math.PI;

/** Un angle ramené dans [0, 2π), comme le jeu les écrit. Ce qui s'écrirait
 *  6,283185 à six décimales est un tour complet, donc zéro. */
export function normaliserAngle(angle: number): number {
  const ramene = ((angle % TOUR) + TOUR) % TOUR;
  return ramene >= TOUR - 5e-7 ? 0 : ramene;
}

function attribut(valeur: string): string {
  return valeur
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Six décimales, comme le jeu, et jamais « -0.000000 ». */
function nombre(valeur: number): string {
  const texte = valeur.toFixed(6);
  return texte === "-0.000000" ? "0.000000" : texte;
}

/** La disposition au gabarit du jeu : en-tête XML, quatre espaces, six
 *  décimales, fin de ligne Unix. Un fichier lu puis réécrit sans retouche
 *  ressort à l'octet près. */
export function ecrireDisposition(disposition: Disposition): string {
  const { version, mapId, mapName, type } = disposition.entete;
  const lignes = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Decorations version="${attribut(version)}" mapId="${attribut(mapId)}" mapName="${attribut(mapName)}" type="${attribut(type)}">`,
    ...disposition.decorations.map(
      (d) =>
        `    <prop id="${d.id}" name="${attribut(d.nom)}" pos="${d.position.map(nombre).join(" ")}" rot="${d.rotation.map(nombre).join(" ")}" scl="${nombre(d.echelle)}"/>`,
    ),
    `</Decorations>`,
  ];
  return `${lignes.join("\n")}\n`;
}

/** Les décorations d'une disposition, une ligne par sorte, les plus nombreuses
 *  d'abord. */
export type Sorte = { id: number; nom: string; nombre: number };

export function sortesDe(decorations: Decoration[]): Sorte[] {
  const parId = new Map<number, Sorte>();
  for (const decoration of decorations) {
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

/** Toutes les décorations que l'API connaît, pour le catalogue : la liste
 *  des identifiants, puis leurs fiches par lots. */
/** Toutes les décorations de l'API. `complet` est faux si un lot de fiches
 *  n'a pas répondu : le catalogue se montre, mais ne se garde pas. */
export async function lireCatalogue(): Promise<{ fiches: FicheDecoration[]; complet: boolean }> {
  const reponse = await tauriFetch(`${API_GW2}/homestead/decorations`, {
    headers: { Accept: "application/json" },
  });
  if (!reponse.ok) {
    throw new Error(`L'API du jeu ne liste pas les décorations (HTTP ${reponse.status}).`);
  }
  const ids = (await reponse.json()) as number[];
  const lues = await lireFiches(ids);
  return { fiches: [...lues.values()], complet: ids.every((id) => lues.has(id)) };
}

export type Categorie = { id: number; name: string };

let categories: Categorie[] | null = null;

export async function lireCategories(): Promise<Categorie[]> {
  if (categories) return categories;
  const reponse = await tauriFetch(`${API_GW2}/homestead/decorations/categories?ids=all&lang=fr`, {
    headers: { Accept: "application/json" },
  });
  if (!reponse.ok) {
    throw new Error(`L'API du jeu ne décrit pas les catégories (HTTP ${reponse.status}).`);
  }
  categories = ((await reponse.json()) as Categorie[]).map(({ id, name }) => ({ id, name }));
  return categories;
}

export type FicheDecoration = {
  id: number;
  name: string;
  icon: string;
  categories: number[];
};

const fiches = new Map<number, FicheDecoration>();

/** Les fiches de l'API pour ces décorations, depuis la mémoire ou l'API. Une
 *  décoration que l'API ne connaît pas — ajoutée depuis — n'a simplement pas
 *  de fiche, et un lot qui échoue n'emporte pas les autres. */
export async function lireFiches(ids: number[]): Promise<Map<number, FicheDecoration>> {
  const manquants = [...new Set(ids)].filter((id) => !fiches.has(id));
  for (let i = 0; i < manquants.length; i += PAR_REQUETE) {
    const lot = manquants.slice(i, i + PAR_REQUETE);
    try {
      await lireLot(lot);
    } catch (cause) {
      console.error("un lot de fiches de décorations ne se lit pas", cause);
    }
  }
  return new Map(ids.flatMap((id) => (fiches.has(id) ? [[id, fiches.get(id)!]] : [])));
}

async function lireLot(lot: number[]): Promise<void> {
  const reponse = await tauriFetch(
    `${API_GW2}/homestead/decorations?ids=${lot.join(",")}&lang=fr`,
    { headers: { Accept: "application/json" } },
  );
  // 206 : une partie des identifiants est inconnue, le reste est rendu.
  // 404 : tous le sont — un lot vide, pas une panne.
  if (reponse.status === 404) return;
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

/* --- L'archive du jeu ---------------------------------------------------------- */

/** Où le lanceur installe le jeu quand on ne lui dit rien. */
export const CHEMIN_ARCHIVE_PAR_DEFAUT = "C:\\Program Files\\Guild Wars 2\\Gw2.dat";

export type EtatArchive = { chemin: string; paquet: number; decorations: number };

/** Ouvre l'archive et indexe les modèles des décorations : quelques secondes
 *  la première fois, immédiat ensuite. */
export function ouvrirArchive(chemin: string, indice: number | null): Promise<EtatArchive> {
  return invoke<EtatArchive>("ouvrir_archive", { chemin, indice });
}

/** Un maillage, dans le repère du jeu : x, y, z à la suite, z vers le bas.
 *  `texture` est le fichier de sa texture de couleur, à demander à
 *  `lireTexture`, et `uv` ses coordonnées ; sans texture, ni l'un ni
 *  l'autre. */
export type Maillage = {
  positions: Float32Array;
  triangles: Uint32Array;
  texture: number | null;
  uv: Float32Array | null;
};

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
  // Copiés : le tampon reçu n'est pas forcément aligné sur quatre octets.
  const flottants = (n: number) => {
    const valeurs = new Float32Array(tampon.slice(curseur, curseur + n * 4));
    curseur += n * 4;
    return valeurs;
  };

  const maillages: Maillage[] = [];
  const nombre = u32();
  for (let i = 0; i < nombre; i++) {
    const sommets = u32();
    const index = u32();
    const texture = u32() || null;
    const positions = flottants(sommets * 3);
    const uv = texture ? flottants(sommets * 2) : null;
    const triangles = new Uint32Array(tampon.slice(curseur, curseur + index * 4));
    curseur += index * 4;
    maillages.push({ positions, triangles, texture, uv });
  }
  return maillages;
}

/** Une texture décodée : RGBA, ligne du haut d'abord. `decoupee` : son alpha
 *  découpe sa forme (un feuillage), et le rendu doit l'en laisser faire. */
export type TextureLue = {
  largeur: number;
  hauteur: number;
  decoupee: boolean;
  pixels: Uint8Array;
};

/** Une texture de l'archive. Voir `texture_decoration` pour le format. */
export async function lireTexture(fichier: number): Promise<TextureLue> {
  const tampon = await invoke<ArrayBuffer>("texture_decoration", { fichier });
  const vue = new DataView(tampon);
  return {
    largeur: vue.getUint32(0, true),
    hauteur: vue.getUint32(4, true),
    decoupee: vue.getUint32(8, true) !== 0,
    pixels: new Uint8Array(tampon, 12),
  };
}
