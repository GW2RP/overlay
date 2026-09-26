/** Le vocabulaire du hub, tel que l'API le renvoie et tel qu'on l'affiche.
 *
 *  Les valeurs sont celles de `src/lib/domain.ts` du hub, et les libellés les
 *  mêmes : l'overlay ne renomme rien. Une valeur inconnue — le hub a ajouté un
 *  type que cette version ne connaît pas — s'affiche telle quelle plutôt que
 *  de faire tomber l'élément. */

export const REGIONS = ["kryte", "ascalon", "maguuma", "shiverpeaks", "orr", "desert"] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Record<Region, string> = {
  kryte: "Kryte",
  ascalon: "Ascalon",
  maguuma: "Maguuma",
  shiverpeaks: "Pics Glacés",
  orr: "Orr",
  desert: "Désert de Cristal",
};

export const WEATHER_CONDITIONS = [
  "degage",
  "nuages",
  "pluie-fine",
  "orage",
  "brume",
  "neige",
] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

export const WEATHER_LABELS: Record<WeatherCondition, string> = {
  degage: "Dégagé",
  nuages: "Nuages",
  "pluie-fine": "Pluie fine",
  orage: "Orage",
  brume: "Brume",
  neige: "Neige",
};

export const PHENOMENES = ["orage", "neige", "pluie", "brume", "vent", "chaleur"] as const;
export type Phenomene = (typeof PHENOMENES)[number];

export const PHENOMENE_LABELS: Record<Phenomene, string> = {
  orage: "Orage",
  neige: "Neige",
  pluie: "Pluie",
  brume: "Brume",
  vent: "Vent fort",
  chaleur: "Forte chaleur",
};

export const TERRAINS = [
  "mer",
  "marais",
  "relief",
  "foret",
  "aride",
  "plaine",
  "riviere",
  "lac",
  "volcan",
  "ville",
] as const;
export type Terrain = (typeof TERRAINS)[number];

export const TERRAIN_LABELS: Record<Terrain, string> = {
  mer: "Mer",
  marais: "Marais",
  relief: "Relief",
  foret: "Forêt",
  aride: "Terres arides",
  plaine: "Plaine",
  riviere: "Rivière",
  lac: "Lac",
  volcan: "Volcan",
  ville: "Ville",
};

export const PLACE_TYPES = [
  "taverne",
  "guilde",
  "ruine",
  "commerce",
  "domaine",
  "maison",
  "campement",
] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];

export const PLACE_TYPE_LABELS: Record<PlaceType, string> = {
  taverne: "Taverne",
  guilde: "Siège de guilde",
  ruine: "Ruine",
  commerce: "Commerce",
  domaine: "Domaine",
  maison: "Maison",
  campement: "Campement",
};

/** Le libellé d'une valeur, ou la valeur elle-même si cette version ne la
 *  connaît pas. */
export function libelle<T extends string>(table: Record<T, string>, valeur: string): string {
  return (table as Record<string, string>)[valeur] ?? valeur;
}

/* --- Le vocabulaire du jeu, tel que le lien Mumble le numérote ------------ */

/** Les professions, par l'identifiant que l'API du jeu leur donne. */
export const PROFESSION_LABELS: Record<number, string> = {
  1: "Gardien",
  2: "Guerrier",
  3: "Ingénieur",
  4: "Rôdeur",
  5: "Voleur",
  6: "Élémentaliste",
  7: "Envoûteur",
  8: "Nécromant",
  9: "Revenant",
};

/** Les races, par l'identifiant du lien Mumble — qui n'est pas celui de l'API. */
export const RACE_MUMBLE_LABELS: Record<number, string> = {
  0: "Asura",
  1: "Charr",
  2: "Humain",
  3: "Norn",
  4: "Sylvari",
};
