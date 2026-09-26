import type { CarteGw2 } from "@/lib/gw2";
import type { LienMumble } from "@/lib/mumble";

/**
 * Du repère du jeu à celui du hub.
 *
 * Le hub range ses lieux en **pixels de continent**, ceux du continent 1 (la
 * Tyrie) à l'échelle de `continent_dims` — 81 920 × 114 688. Le lien Mumble
 * donne la position du personnage (`playerX` / `playerY`) **dans ce même
 * repère** : le jeu la projette lui-même pour sa carte, et il n'y a rien à
 * reprojeter. Une seconde règle de trois par `map_rect` / `continent_rect`
 * rendait un point crédible et faux — dans la même carte, à quelques cellules
 * de là, et parfois hors de son rectangle. Mesuré au Marais de Lumillule : le
 * point reprojeté tombait en « plaine, hors région » là où le personnage
 * nageait en mer, sous l'orage que la carte du hub montrait.
 *
 * L'API du jeu (`/v2/maps/{id}`) sert encore : elle dit le continent — les
 * Brumes n'ont pas de météo — et l'échelle des distances.
 */

export const CONTINENT_TYRIE = 1;
export const CONTINENT_WIDTH = 81_920;
export const CONTINENT_HEIGHT = 114_688;

/** La maille de la simulation météo du hub : un relevé ne change pas tant
 *  qu'on reste dans la même cellule. */
export const CELL_SIZE = 256;

export type Point = { x: number; y: number };

export function enTyrie(carte: CarteGw2): boolean {
  return carte.continent_id === CONTINENT_TYRIE;
}

/** La position du personnage en pixels de continent, bornée au continent :
 *  celle que le lien écrit, arrondie au pixel. */
export function positionContinent(lien: LienMumble): Point {
  return {
    x: Math.min(Math.max(Math.round(lien.player_x), 0), CONTINENT_WIDTH),
    y: Math.min(Math.max(Math.round(lien.player_y), 0), CONTINENT_HEIGHT),
  };
}

/** Combien d'unités du jeu — les pouces des portées de compétence — tient un
 *  pixel de continent sur cette carte. Vingt-quatre, sur toutes les cartes du
 *  jeu de base ; on le lit plutôt que de l'écrire. */
export function unitesParPixel(carte: CarteGw2): number {
  const [[mx1], [mx2]] = carte.map_rect;
  const [[cx1], [cx2]] = carte.continent_rect;
  return (mx2 - mx1) / (cx2 - cx1);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** La cellule de simulation qui contient un point : même cellule, même relevé. */
export function cellule(point: Point): string {
  return `${Math.floor(point.x / CELL_SIZE)}:${Math.floor(point.y / CELL_SIZE)}`;
}

/** Les huit directions, en français. */
export const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** La direction de `vers` vue de `depuis`, sur la carte : le nord est en haut,
 *  donc vers les ordonnées décroissantes. */
export function direction(depuis: Point, vers: Point): Direction {
  const angle = Math.atan2(vers.x - depuis.x, depuis.y - vers.y);
  const secteur = Math.round(angle / (Math.PI / 4));
  return DIRECTIONS[(secteur + 8) % 8];
}

/** Une distance en unités du jeu, arrondie à la centaine : la position du lien
 *  n'est pas plus précise, et « 1 237 u » prétendrait le contraire. */
export function formatUnites(pixels: number, unitesParPx: number): string {
  const unites = Math.round((pixels * unitesParPx) / 100) * 100;
  return `${unites.toLocaleString("fr-FR")} u`;
}
