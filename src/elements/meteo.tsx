import { useEffect, useRef, useState } from "react";

import { EnCours, EnPanne, EtatSansPosition } from "@/components/etat-element";
import { PhenomeneGlyph, WeatherGlyph } from "@/components/type-glyph";
import { cellule } from "@/lib/carte";
import {
  libelle,
  PHENOMENE_LABELS,
  REGION_LABELS,
  TERRAIN_LABELS,
  WEATHER_LABELS,
} from "@/lib/domaine";
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
 */

/** Un pas de simulation dure deux heures ; cinq minutes de filet suffisent
 *  pour ne jamais afficher un ciel de plus d'un pas de retard. */
const RAFRAICHISSEMENT_MS = 5 * 60 * 1000;

type Lecture =
  | { etat: "en-cours" }
  | { etat: "en-panne" }
  | { etat: "lu"; releve: ReleveMeteo | null };

export function Meteo({ position }: { position: Position }) {
  const point = position.etat === "pret" ? position.point : null;
  const cle = point ? cellule(point) : null;
  const [lecture, setLecture] = useState<Lecture>({ etat: "en-cours" });
  const derniere = useRef<string | null>(null);

  useEffect(() => {
    if (!point || !cle) return;
    let parti = false;

    const relever = async () => {
      // Le relevé d'avant reste affiché pendant que le suivant arrive : on
      // voit ce qu'on quitte, pas un panneau vide.
      if (derniere.current !== cle) setLecture({ etat: "en-cours" });
      try {
        const releve = await releverMeteo(point.x, point.y);
        if (!parti) {
          derniere.current = cle;
          setLecture({ etat: "lu", releve });
        }
      } catch {
        if (!parti) setLecture({ etat: "en-panne" });
      }
    };

    void relever();
    const minuterie = setInterval(relever, RAFRAICHISSEMENT_MS);
    return () => {
      parti = true;
      clearInterval(minuterie);
    };
    // Le point exact bouge à chaque pas du personnage ; seule la cellule compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cle]);

  if (position.etat !== "pret") return <EtatSansPosition position={position} />;

  return (
    <div className="flex h-full flex-col gap-1 px-4 py-3">
      <p className="eyebrow text-gold-eyebrow">MÉTÉO</p>
      <div aria-live="polite" className="min-h-0 flex-1">
        {lecture.etat === "en-panne" ? (
          <EnPanne libelle="Le relevé n'a pas abouti." />
        ) : lecture.etat === "en-cours" ? (
          <EnCours libelle="Relevé…" />
        ) : !lecture.releve ? (
          <EnCours libelle="Aucun pas de simulation" />
        ) : (
          <Releve releve={lecture.releve} carte={position.carte.name} />
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
