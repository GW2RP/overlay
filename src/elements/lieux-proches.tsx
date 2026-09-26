import { useEffect, useState } from "react";

import { EnCours, EnPanne, EtatSansPosition } from "@/components/etat-element";
import { CalendarIcon } from "@/components/icons";
import { PlaceGlyph } from "@/components/type-glyph";
import { direction, distance, formatUnites, type Point } from "@/lib/carte";
import { libelle, PLACE_TYPE_LABELS, REGION_LABELS } from "@/lib/domaine";
import { lieuxProches } from "@/lib/nexus";
import type { Position } from "@/lib/position";
import type { LieuProche } from "@/lib/types";

/**
 * Les lieux du registre autour du personnage, du plus proche au plus éloigné.
 *
 * La liste vient de `/api/lieux/proximite` du hub, et se redemande quand le
 * personnage s'est **assez** déplacé pour qu'elle puisse changer d'ordre — pas
 * à chaque pas. Entre deux appels, distances et directions se recalculent sur
 * place à partir de la position courante : ce sont des soustractions, pas des
 * requêtes, et elles suivent le personnage en direct.
 */

/** Le déplacement, en pixels de continent, au-delà duquel la liste se redemande. */
const SEUIL_DEPLACEMENT = 400;
const RAFRAICHISSEMENT_MS = 2 * 60 * 1000;
const RAYON = 2_500;
const LIMITE = 8;

type Lecture =
  | { etat: "en-cours" }
  | { etat: "en-panne" }
  | { etat: "lu"; lieux: LieuProche[] };

export function LieuxProches({ position }: { position: Position }) {
  const point = position.etat === "pret" ? position.point : null;
  const [lecture, setLecture] = useState<Lecture>({ etat: "en-cours" });

  // La requête part d'un point d'ancrage, et seulement quand on s'en éloigne.
  // L'ancre se déduit du rendu précédent, pendant le rendu : c'est le schéma
  // de React pour un état qui dépend de ce qu'il était.
  const [ancre, setAncre] = useState<Point | null>(null);
  if (point && (!ancre || distance(ancre, point) > SEUIL_DEPLACEMENT)) {
    setAncre(point);
  }

  useEffect(() => {
    if (!ancre) return;
    let parti = false;

    const lire = async () => {
      try {
        const reponse = await lieuxProches(ancre.x, ancre.y, RAYON, LIMITE);
        if (!parti) setLecture({ etat: "lu", lieux: reponse.lieux });
      } catch {
        if (!parti) setLecture({ etat: "en-panne" });
      }
    };

    void lire();
    const minuterie = setInterval(lire, RAFRAICHISSEMENT_MS);
    return () => {
      parti = true;
      clearInterval(minuterie);
    };
  }, [ancre]);

  if (position.etat !== "pret") return <EtatSansPosition position={position} />;

  // Distances et directions se lisent depuis là où l'on est, pas depuis l'ancre.
  const lieux =
    lecture.etat === "lu"
      ? [...lecture.lieux]
          .map((lieu) => ({
            ...lieu,
            distance: distance(position.point, lieu.coordinates),
            direction: direction(position.point, lieu.coordinates),
          }))
          .sort((a, b) => a.distance - b.distance)
      : [];

  return (
    <div className="flex h-full flex-col gap-1 px-4 py-3">
      <p className="eyebrow text-gold-eyebrow">LIEUX À PROXIMITÉ</p>
      <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto">
        {lecture.etat === "en-panne" ? (
          <EnPanne libelle="La liste n'a pas abouti." />
        ) : lecture.etat === "en-cours" ? (
          <EnCours libelle="Recherche…" />
        ) : lieux.length === 0 ? (
          <EnCours libelle="Aucun lieu à proximité" />
        ) : (
          <ul className="flex flex-col">
            {lieux.map((lieu) => (
              <li
                key={lieu.id}
                className="flex items-start gap-3 border-t border-hairline py-2 first:border-t-0"
              >
                <PlaceGlyph type={lieu.type} size={18} className="mt-1 text-gold-ink" />
                <div className="min-w-0 flex-1">
                  <p className="truncate body-compact text-ink">{lieu.name}</p>
                  <p className="caption text-ink-muted">
                    {libelle(PLACE_TYPE_LABELS, lieu.type)}
                    {" · "}
                    {lieu.district ?? libelle(REGION_LABELS, lieu.region)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="caption text-ink-body">
                    {formatUnites(lieu.distance, position.unitesParPixel)} · {lieu.direction}
                  </p>
                  {lieu.upcomingEventCount > 0 ? (
                    <p className="flex items-center justify-end gap-1 caption text-crimson-ink">
                      <CalendarIcon size={12} />
                      {lieu.upcomingEventCount}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
