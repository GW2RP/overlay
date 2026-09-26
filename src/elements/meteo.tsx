import { EnCours, EnPanne, EtatSansPosition } from "@/components/etat-element";
import { PhenomeneGlyph, WeatherGlyph } from "@/components/type-glyph";
import { centreCellule, type Point } from "@/lib/carte";
import {
  libelle,
  PHENOMENE_LABELS,
  REGION_LABELS,
  TERRAIN_LABELS,
  WEATHER_LABELS,
} from "@/lib/domaine";
import { useLecturePeriodique } from "@/lib/lecture";
import { releverMeteo } from "@/lib/nexus";
import type { Position } from "@/lib/position";
import type { ReleveMeteo } from "@/lib/types";

/**
 * Le temps qu'il fait là où le personnage se tient.
 *
 * Le relevé vient de `/api/meteo/point` du hub, et ne se redemande que quand il
 * peut changer : quand le personnage change de **cellule** de simulation —
 * 256 px de continent —, ou quand un pas a pu être joué depuis. Le suivre à
 * chaque lecture du lien ferait quatre requêtes par seconde pour le même ciel.
 * Et seulement fenêtre visible : cachée, elle ne demande rien.
 *
 * La requête porte le **centre de la cellule**, pas le point : le relevé est
 * le même par construction, et deux personnages sous le même ciel demandent
 * la même adresse, que le hub ressert sans la recalculer.
 */

/** Un pas de simulation dure deux heures ; cinq minutes de filet suffisent
 *  pour ne jamais afficher un ciel de plus d'un pas de retard. */
const RAFRAICHISSEMENT_MS = 5 * 60 * 1000;

const lireReleve = (centre: Point) => releverMeteo(centre.x, centre.y);

export function Meteo({ position, actif }: { position: Position; actif: boolean }) {
  const point = position.etat === "pret" ? position.point : null;
  const lecture = useLecturePeriodique(
    point ? centreCellule(point) : null,
    actif,
    RAFRAICHISSEMENT_MS,
    lireReleve,
  );

  if (position.etat !== "pret") return <EtatSansPosition position={position} />;

  return (
    <div className="flex h-full flex-col gap-1 px-4 py-3">
      <p className="eyebrow text-gold-eyebrow">MÉTÉO</p>
      <div aria-live="polite" className="min-h-0 flex-1">
        {lecture.etat === "en-panne" ? (
          <EnPanne libelle="Le relevé n'a pas abouti." />
        ) : lecture.etat === "en-cours" ? (
          <EnCours libelle="Relevé…" />
        ) : !lecture.valeur ? (
          <EnCours libelle="Aucun pas de simulation" />
        ) : (
          <Releve releve={lecture.valeur} carte={position.carte.name} />
        )}
      </div>
    </div>
  );
}

/** Le nom de la carte va avec le terrain, pas dans le surtitre : en capitales
 *  espacées, « La Vallée de la reine » prenait deux lignes à la largeur d'un
 *  élément. */
function Releve({ releve, carte }: { releve: ReleveMeteo; carte: string }) {
  return (
    <>
      <p className="flex items-center gap-2 body-compact text-ink">
        <WeatherGlyph condition={releve.condition} size={20} className="text-rain" />
        {libelle(WEATHER_LABELS, releve.condition)}
        <span className="text-ink-muted">
          {" · "}
          {releve.region ? libelle(REGION_LABELS, releve.region) : "hors région"}
        </span>
      </p>
      <p className="caption text-ink-muted">
        {carte} · {libelle(TERRAIN_LABELS, releve.terrain)} · {releve.temperature} °C · {releve.humidite} %
        {" · "}
        {releve.vent} km/h · {releve.pression} hPa
      </p>
      {releve.phenomenes.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {releve.phenomenes.map((phenomene) => (
            <li key={phenomene} className="flex items-center gap-1 caption text-ink-body">
              <PhenomeneGlyph phenomene={phenomene} size={14} className="text-gold-ink" />
              {libelle(PHENOMENE_LABELS, phenomene)}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
