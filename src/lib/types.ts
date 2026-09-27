import type {
  EventType,
  Phenomene,
  PlaceType,
  Race,
  Region,
  Terrain,
  WeatherCondition,
} from "@/lib/domaine";

/** Les formes que le hub renvoie, telles que ses routes les écrivent
 *  (`src/server/api-overlay.ts` côté hub). */

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

/** Une ligne de `GET /api/lieux/proximite` : de quoi nommer un lieu, le
 *  situer et dire s'il s'y passe quelque chose, avec sa distance au point
 *  demandé en pixels de continent. La fiche garde le reste. */
export type LieuProche = {
  id: string;
  slug: string;
  name: string;
  type: PlaceType;
  region: Region;
  district: string | null;
  coordinates: { x: number; y: number };
  upcomingEventCount: number;
  distance: number;
};

/** `GET /api/alentours` : tout ce qu'il y a autour d'un point, en une lecture.
 *  `region` vaut `null` hors de toute région, et les rumeurs sont alors vides. */
export type Alentours = {
  x: number;
  y: number;
  rayon: number;
  lieux: LieuProche[];
  evenements: EvenementProche[];
  region: Region | null;
  rumeurs: Rumeur[];
};

/** Un lieu tel que le registre le résume — une ligne de recherche. */
export type LieuResume = {
  id: string;
  slug: string;
  name: string;
  type: PlaceType;
  region: Region;
  district: string | null;
  summary: string | null;
  bannerUrl: string | null;
  bannerAlt: string | null;
  coordinates: { x: number; y: number } | null;
  upcomingEventCount: number;
};

export type PointDePlan = {
  number: number;
  label: string;
  description: string | null;
  /** En pourcentage de l'image, jamais en pixels du fichier. */
  x: number;
  y: number;
};

export type Plan = {
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
  width: number | null;
  height: number | null;
  points: PointDePlan[];
};

/** `GET /api/lieux/[slug]` */
export type Lieu = LieuResume & {
  description: string | null;
  access: string | null;
  floorPlans: Plan[];
  keepers: { id: string; slug: string; name: string }[];
  updatedAt: string;
};

/** Une scène, sans l'état du lecteur. */
export type Evenement = {
  id: string;
  slug: string;
  title: string;
  type: EventType;
  summary: string | null;
  startsAt: string;
  endsAt: string | null;
  region: Region | null;
  locationLabel: string;
  place: { id: string; slug: string; name: string } | null;
  coordinates: { x: number; y: number } | null;
  capacity: number | null;
  registeredCount: number;
  liveStatus: "annonce" | "en-cours" | "passe";
};

export type EvenementProche = Evenement & { distance: number };

/** Les scènes du jour : `jour` est la date civile du serveur de jeu
 *  (« 2026-09-27 »), `total` le compte du jour entier. */
export type ScenesDuJour = { jour: string; total: number; evenements: Evenement[] };

export type Rumeur = {
  id: string;
  body: string;
  character: { id: string; slug: string; name: string } | null;
  place: { id: string; slug: string; name: string } | null;
  heardAtLabel: string | null;
  region: Region | null;
  echoCount: number;
  createdAt: string;
};

export type Personnage = {
  id: string;
  slug: string;
  name: string;
  race: Race;
  gender: "feminin" | "masculin" | "neutre";
  title: string | null;
  homePlaceLabel: string | null;
  portraitUrl: string | null;
  portraitAlt: string | null;
};

export type Groupe = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  memberCount: number;
  upcomingEventCount: number;
};

/** `GET /api/recherche` */
export type Recherche = {
  q: string;
  lieux: { total: number; items: LieuResume[] };
  personnages: { total: number; items: Personnage[] };
  groupes: { total: number; items: Groupe[] };
  evenements: { total: number; items: Evenement[] };
};
