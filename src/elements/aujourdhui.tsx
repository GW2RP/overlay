import { useEffect, useState } from "react";

import { BoutonVerrou } from "@/components/bouton-verrou";
import { EnCours, EnPanne } from "@/components/etat-element";
import { CalendarIcon, UserIcon } from "@/components/icons";
import { EventGlyph } from "@/components/type-glyph";
import { formatDelai, formatHeure, formatJourCivil } from "@/lib/dates";
import { useLecturePeriodique } from "@/lib/lecture";
import { ouvrirSurLeHub } from "@/lib/liens";
import { scenesDuJour } from "@/lib/nexus";
import { useVerrou, type Element } from "@/lib/overlays";
import { useSessionCourante } from "@/lib/session-courante";
import type { Evenement } from "@/lib/types";

/**
 * Les scènes du jour, où que soit le personnage : celles qui se tiennent en ce
 * moment, puis celles qui commencent avant minuit — trois au plus —, et le
 * chemin vers l'agenda complet du hub.
 *
 * Elles ne dépendent pas de la position, donc pas du jeu non plus : la lecture
 * part dès que la fenêtre est à l'écran, et se refait toutes les cinq minutes.
 * Sans session, tous les joueurs demandent la même adresse, que le CDN du hub
 * ressert ; connecté, l'agenda du compte, scènes privées comprises — et une
 * connexion ou une déconnexion relit tout de suite. Entre deux lectures,
 * l'horloge avance sur place : une scène commencée passe « en cours », une
 * scène finie disparaît, sans requête.
 */

const LIMITE = 3;
const RAFRAICHISSEMENT_MS = 5 * 60 * 1000;
/** L'horloge qui fait avancer « dans 20 min » sans relire le hub. */
const HORLOGE_MS = 30 * 1000;

/** Le numéro de session ne sert qu'à relancer la lecture : le jeton, lui, est
 *  relu par la requête. */
const lireScenes = ({ limite }: { limite: number; session: number | null }) =>
  scenesDuJour(limite);

export function Aujourdhui({ element, actif }: { element: Element; actif: boolean }) {
  const session = useSessionCourante();
  // Un changement de compte repart de « Lecture de l'agenda… » : la lecture
  // d'avant porte les scènes privées de l'ancien compte, et « on voit ce qu'on
  // quitte » les laisserait au suivant — fenêtre cachée, jusqu'à sa
  // réouverture.
  return (
    <AgendaDuJour key={session ?? "anonyme"} element={element} actif={actif} session={session} />
  );
}

function AgendaDuJour({
  element,
  actif,
  session,
}: {
  element: Element;
  actif: boolean;
  session: number | null;
}) {
  const verrouille = useVerrou(element.label);
  const lecture = useLecturePeriodique(
    { limite: LIMITE, session },
    actif,
    RAFRAICHISSEMENT_MS,
    lireScenes,
  );
  const maintenant = useMaintenant(actif);

  const jour = lecture.etat === "lu" ? lecture.valeur.jour : null;
  // Une scène dont l'heure de fin annoncée est passée n'est plus du jour ; sans
  // heure de fin, c'est le hub qui en décide, à la lecture suivante.
  const scenes =
    lecture.etat === "lu"
      ? lecture.valeur.evenements.filter(
          (evenement) => !evenement.endsAt || Date.parse(evenement.endsAt) >= maintenant,
        )
      : [];
  const total = lecture.etat === "lu" ? lecture.valeur.total : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 py-2 pl-4 pr-2">
        <p className="eyebrow flex-1 text-gold-eyebrow">
          {jour ? `AUJOURD'HUI · ${formatJourCivil(jour).toLocaleUpperCase("fr-FR")}` : "AUJOURD'HUI"}
        </p>
        <BoutonVerrou label={element.label} verrouille={verrouille} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <h2 className="eyebrow border-b border-rule py-1.5 text-ink-subtle">EN COURS ET À VENIR</h2>
        <div aria-live="polite">
          {lecture.etat === "en-panne" ? (
            <div className="py-2">
              <EnPanne libelle="L'agenda n'a pas abouti." />
            </div>
          ) : lecture.etat === "en-cours" ? (
            <div className="py-2">
              <EnCours libelle="Lecture de l'agenda…" />
            </div>
          ) : scenes.length === 0 ? (
            <p className="py-2 meta text-ink-muted">Aucune scène aujourd'hui</p>
          ) : (
            scenes.map((evenement) => (
              <LigneDuJour key={evenement.id} evenement={evenement} maintenant={maintenant} />
            ))
          )}
        </div>
      </div>

      <div className="flex min-h-tap items-center gap-3 border-t border-rule py-2 pl-4 pr-2">
        <span className="flex-1 caption text-ink-muted">
          {scenes.length > 0 && total > scenes.length ? `${scenes.length} sur ${total} aujourd'hui` : ""}
        </span>
        {/* Cadenas fermé, le bouton ne recevrait pas le clic : il passerait au
            jeu. Il ne s'affiche donc pas. */}
        {verrouille ? null : (
          <button
            type="button"
            onClick={() => void ouvrirSurLeHub("/evenements")}
            className="button-label flex min-h-tap items-center gap-2 border border-gold px-3.5 text-gold-ink hover:bg-surface-selected"
          >
            TOUT L'AGENDA
            <CalendarIcon size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function LigneDuJour({ evenement, maintenant }: { evenement: Evenement; maintenant: number }) {
  const debut = Date.parse(evenement.startsAt);
  const enCours = debut <= maintenant;

  return (
    <button
      type="button"
      onClick={() => void ouvrirSurLeHub(`/evenements/${evenement.slug}`)}
      className="flex w-full items-start gap-3 border-b border-hairline py-2 text-left last:border-b-0 hover:bg-surface-selected"
    >
      <span
        className={
          enCours
            ? "flex w-13 shrink-0 flex-col items-center gap-1 border border-crimson-edge py-1.5"
            : "flex w-13 shrink-0 flex-col items-center gap-1 border border-rule py-1.5"
        }
      >
        <span className="panel-title text-ink">{formatHeure(evenement.startsAt)}</span>
        <span className="chip-label text-ink-muted">
          {enCours
            ? evenement.endsAt
              ? formatHeure(evenement.endsAt)
              : ""
            : formatDelai(debut - maintenant).toLocaleUpperCase("fr-FR")}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate body-compact text-ink">{evenement.title}</span>
        <span className="truncate caption text-ink-muted">
          {/* Le navigateur n'a pas le jeton de l'overlay : une scène privée ne
              s'y ouvre que connecté au même compte. Autant le dire. */}
          {evenement.visibility === "privee"
            ? `Privée · ${evenement.locationLabel}`
            : evenement.locationLabel}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        {enCours ? (
          <span className="chip-label border border-crimson-edge bg-crimson px-2 py-1 text-on-crimson">
            EN COURS
          </span>
        ) : (
          <EventGlyph type={evenement.type} size={16} className="text-gold-ink" />
        )}
        <span className="flex items-center gap-1 caption text-ink-muted">
          <UserIcon size={12} />
          {evenement.registeredCount}
          {evenement.capacity ? `/${evenement.capacity}` : ""}
        </span>
      </span>
    </button>
  );
}

/** L'heure qu'il est, relue toutes les trente secondes tant que la fenêtre est
 *  à l'écran : de quoi faire avancer les délais sans relire le hub. */
function useMaintenant(actif: boolean): number {
  const [maintenant, setMaintenant] = useState(() => Date.now());

  useEffect(() => {
    if (!actif) return;
    // Remontrée, la fenêtre se remet à l'heure tout de suite, pas trente
    // secondes plus tard.
    const tic = () => setMaintenant(Date.now());
    const aussitot = setTimeout(tic, 0);
    const minuterie = setInterval(tic, HORLOGE_MS);
    return () => {
      clearTimeout(aussitot);
      clearInterval(minuterie);
    };
  }, [actif]);

  return maintenant;
}
