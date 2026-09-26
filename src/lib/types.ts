import type { Phenomene, PlaceType, Region, Terrain, WeatherCondition } from "@/lib/domaine";

/** Les formes que le hub renvoie, telles que ses routes les écrivent
 *  (`src/server/types.ts` côté hub). */

export type Utilisateur = {
  id: string;
  name: string;
  email: string;
  role: string;
};

/** `GET /api/meteo/point` */
export type ReleveMeteo = {
  x: number;
  y: number;
  region: Region | null;
  terrain: Terrain;
  condition: WeatherCondition;
  phenomenes: Phenomene[];
  temperature: number;
  humidite: number;
  pression: number;
  vent: number;
  visibilite: number;
  precipitation: number;
  stepIndex: number;
};

/** Une ligne de `GET /api/lieux/proximite` : un lieu du registre, et sa
 *  distance au point demandé en pixels de continent. */
export type LieuProche = {
  id: string;
  slug: string;
  name: string;
  type: PlaceType;
  region: Region;
  district: string | null;
  summary: string | null;
  coordinates: { x: number; y: number };
  upcomingEventCount: number;
  distance: number;
};

export type LieuxProches = {
  x: number;
  y: number;
  rayon: number;
  lieux: LieuProche[];
};
