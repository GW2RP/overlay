import { useEffect, useState, type ReactNode } from "react";

import { BoutonVerrou } from "@/components/bouton-verrou";
import { ReglageStatut } from "@/components/reglage-statut";
import { StatutLieu } from "@/components/statut-lieu";
import { EnCours, EnPanne, EtatSansPosition } from "@/components/etat-element";
import { CloseIcon, GroupIcon, RumorIcon, SearchIcon, UserIcon } from "@/components/icons";
import { EventGlyph, PlaceGlyph } from "@/components/type-glyph";
import { activiteA, type Activite } from "@/lib/activite";
import { centreDeGrille, direction, distance, formatUnites, type Point } from "@/lib/carte";
import { caseDeDate, formatHeure, formatJour } from "@/lib/dates";
import { libelle, PLACE_TYPE_LABELS, raceLabel, REGION_LABELS } from "@/lib/domaine";
import { useLecturePeriodique, type Lecture } from "@/lib/lecture";
import { useLieuxGeres, type LieuxGeres } from "@/lib/lieux-geres";
import { alentours, rechercher } from "@/lib/nexus";
import { ouvrirFiche, useVerrou, type Element } from "@/lib/overlays";
import type { Position } from "@/lib/position";
import type { Alentours, Evenement, Recherche, Rumeur } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ouvrirSurLeHub } from "@/lib/liens";

/**
 * Ce qu'il y a autour du personnage : les lieux du registre, les scènes qui
 * s'y tiennent ou vont s'y tenir, les rumeurs de la région. Et une barre de
 * recherche à travers tout le hub.
 *
 * Les trois listes viennent d'une seule lecture (`/api/alentours`), depuis une
 * **ancre** posée au centre d'une case de grille, et se redemandent quand le
 * personnage s'en est assez éloigné pour qu'elles puissent changer — pas à
 * chaque pas — ou toutes les cinq minutes, fenêtre visible seulement. Deux
 * personnages dans la même case demandent la même adresse, que le hub ressert
 * sans la recalculer. Entre deux appels, distances et directions se
 * recalculent sur place depuis la position courante : des soustractions, pas
 * des requêtes. Le relevé d'avant reste affiché pendant que le suivant arrive.
 *
 * Un lieu s'ouvre dans sa fiche, une fenêtre à part ; un personnage, un groupe
 * ou une scène s'ouvrent sur le hub, dans le navigateur : l'overlay n'a pas
 * de fiche pour eux.
 */

/** Le déplacement, en pixels de continent, au-delà duquel les listes se redemandent. */
const SEUIL_DEPLACEMENT = 400;
const RAFRAICHISSEMENT_MS = 5 * 60 * 1000;
/** Ce qui compte comme « à proximité » à l'écran. */
const RAYON = 2_500;
/** La grille sur laquelle l'ancre se pose. Un point est toujours à moins de
 *  362 px du centre de sa case, sous le seuil : l'ancre ne bouge qu'une fois
 *  la case quittée, sans battement à la frontière. */
const GRILLE_ANCRE = 512;
/** Le rayon demandé au hub : le personnage peut être à `SEUIL_DEPLACEMENT` de
 *  son ancre avant qu'elle bouge, donc le hub cherche d'autant plus loin, et
 *  l'écran ne garde que ce qui est à moins de `RAYON` du personnage. */
const RAYON_DEMANDE = RAYON + SEUIL_DEPLACEMENT;
const LIMITE = 6;
const RUMEURS = 3;
/** Le délai entre la dernière frappe et la recherche. */
const DELAI_RECHERCHE_MS = 300;
const LONGUEUR_MINIMALE = 2;

const lireAlentours = (ancre: Point) => alentours(ancre.x, ancre.y, RAYON_DEMANDE, LIMITE, RUMEURS);

export function Proximite({
  element,
  position,
  actif,
}: {
  element: Element;
  position: Position;
  actif: boolean;
}) {
  const verrouille = useVerrou(element.label);
  const [requete, setRequete] = useState("");
  const geres = useLieuxGeres(actif);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 py-2 pl-4 pr-2">
        <p className="eyebrow flex-1 text-gold-eyebrow">À PROXIMITÉ</p>
        <BoutonVerrou label={element.label} verrouille={verrouille} />
      </div>

      <div className="px-4 pb-2">
        <label htmlFor="recherche" className="sr-only">
          Rechercher sur le hub
        </label>
        <div
          className={cn(
            "flex min-h-tap items-center gap-2 border bg-surface-inset px-3",
            requete ? "border-gold" : "border-rule",
          )}
        >
          <SearchIcon size={16} className={requete ? "text-gold-ink" : "text-ink-subtle"} />
          <input
            id="recherche"
            type="search"
            value={requete}
            onChange={(evenement) => setRequete(evenement.target.value)}
            placeholder="Lieux, personnages, groupes, scènes…"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent body-compact text-ink outline-none placeholder:text-ink-subtle [&::-webkit-search-cancel-button]:appearance-none"
          />
          {requete ? (
            <button
              type="button"
              onClick={() => setRequete("")}
              aria-label="Effacer la recherche"
              className="-mr-3 flex size-tap items-center justify-center text-ink-muted hover:text-ink"
            >
              <CloseIcon size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {requete.trim().length >= LONGUEUR_MINIMALE ? (
          <Resultats requete={requete.trim()} position={position} geres={geres} />
        ) : (
          <Alentours position={position} actif={actif} geres={geres} verrouille={verrouille} />
        )}
      </div>
    </div>
  );
}

/* --- Les alentours -------------------------------------------------------------- */

function Alentours({
  position,
  actif,
  geres,
  verrouille,
}: {
  position: Position;
  actif: boolean;
  geres: LieuxGeres;
  verrouille: boolean;
}) {
  const point = position.etat === "pret" ? position.point : null;

  // La requête part d'une ancre — le centre de la case de grille où l'on se
  // tient —, et seulement quand on s'en éloigne. L'ancre se déduit du rendu
  // précédent, pendant le rendu : c'est le schéma de React pour un état qui
  // dépend de ce qu'il était. Sans jeu, plus d'ancre : la minuterie ne doit
  // pas survivre au jeu.
  const [ancre, setAncre] = useState<Point | null>(null);
  if (!point) {
    if (ancre) setAncre(null);
  } else if (!ancre || distance(ancre, point) > SEUIL_DEPLACEMENT) {
    setAncre(centreDeGrille(point, GRILLE_ANCRE));
  }

  const lecture = useLecturePeriodique(ancre, actif, RAFRAICHISSEMENT_MS, lireAlentours);

  if (position.etat !== "pret") return <EtatSansPosition position={position} />;
  if (lecture.etat === "en-panne") return <EnPanne libelle="Les alentours n'ont pas abouti." />;
  if (lecture.etat === "en-cours") return <EnCours libelle="Recherche…" />;

  // Le hub a cherché autour de l'ancre, un peu plus loin que `RAYON` ; l'écran
  // mesure depuis le personnage et ne garde que ce qui est vraiment à portée.
  const { point: ici, unitesParPixel } = position;
  const lieux = lecture.valeur.lieux
    .map((lieu) => ({ ...lieu, distance: distance(ici, lieu.coordinates) }))
    .filter((lieu) => lieu.distance <= RAYON)
    .sort((a, b) => a.distance - b.distance);
  const evenements = lecture.valeur.evenements.filter(
    (evenement) => evenement.coordinates && distance(ici, evenement.coordinates) <= RAYON,
  );

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <Section titre="LIEUX">
        {lieux.length === 0 ? (
          <Vide libelle="Aucun lieu à proximité" />
        ) : (
          lieux.map((lieu) => {
            // Le statut d'un lieu qu'on tient vient de sa lecture à lui, que
            // le CDN ne ressert pas : il est plus frais que celui des alentours.
            const gere = geres.parId.get(lieu.id);
            const activite = activiteA(gere ? gere.activity : lieu.activity);
            return (
              <div key={lieu.id} className="flex flex-col border-b border-hairline last:border-b-0">
                <Ligne onClick={() => void ouvrirFiche(lieu.slug)} className="border-b-0">
                  <PlaceGlyph type={lieu.type} size={18} className="mt-1 text-gold-ink" />
                  <Corps
                    titre={lieu.name}
                    sousTitre={`${libelle(PLACE_TYPE_LABELS, lieu.type)} · ${lieu.district ?? libelle(REGION_LABELS, lieu.region)}`}
                    statut={activite}
                  />
                  <span className="shrink-0 pt-0.5 text-right caption text-ink-body">
                    {formatUnites(lieu.distance, unitesParPixel)} · {direction(ici, lieu.coordinates)}
                  </span>
                </Ligne>
                {/* Cadenas fermé, les clics passent au jeu : l'interrupteur
                    ne recevrait pas le sien. */}
                {gere && !verrouille ? (
                  <ReglageStatut lieu={gere} activite={activite} onEcrit={geres.ecrit} />
                ) : null}
              </div>
            );
          })
        )}
      </Section>

      <Section titre="SCÈNES À VENIR">
        {evenements.length === 0 ? (
          <Vide libelle="Aucune scène à proximité" />
        ) : (
          evenements.map((evenement) => (
            <LigneScene key={evenement.id} evenement={evenement} />
          ))
        )}
      </Section>

      <Section
        titre={
          lecture.valeur.region
            ? `RUMEURS · ${libelle(REGION_LABELS, lecture.valeur.region).toLocaleUpperCase("fr-FR")}`
            : "RUMEURS"
        }
      >
        {lecture.valeur.rumeurs.length === 0 ? (
          <Vide libelle={lecture.valeur.region ? "Aucune rumeur dans la région" : "Hors région"} />
        ) : (
          lecture.valeur.rumeurs.map((rumeur) => <LigneRumeur key={rumeur.id} rumeur={rumeur} />)
        )}
      </Section>
    </div>
  );
}

/* --- La recherche --------------------------------------------------------------- */

function Resultats({
  requete,
  position,
  geres,
}: {
  requete: string;
  position: Position;
  geres: LieuxGeres;
}) {
  const [lecture, setLecture] = useState<Lecture<Recherche>>({ etat: "en-cours" });

  useEffect(() => {
    let parti = false;
    const minuterie = setTimeout(async () => {
      try {
        const resultat = await rechercher(requete, 5);
        if (!parti) setLecture({ etat: "lu", valeur: resultat });
      } catch {
        if (!parti) setLecture({ etat: "en-panne" });
      }
    }, DELAI_RECHERCHE_MS);
    return () => {
      parti = true;
      clearTimeout(minuterie);
    };
  }, [requete]);

  if (lecture.etat === "en-panne") return <EnPanne libelle="La recherche n'a pas abouti." />;
  if (lecture.etat === "en-cours") return <EnCours libelle="Recherche…" />;

  // Les résultats d'avant restent affichés pendant que les suivants arrivent ;
  // le surlignage suit donc la requête qui les a produits, celle que le hub
  // renvoie, et non celle qu'on est en train de taper.
  const { q: motif, lieux, personnages, groupes, evenements } = lecture.valeur;
  const ici = position.etat === "pret" ? position : null;
  const total = lieux.total + personnages.total + groupes.total + evenements.total;
  if (total === 0) return <Vide libelle="Aucun résultat" />;

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {lieux.items.length > 0 ? (
        <Section titre={`LIEUX · ${lieux.total}`}>
          {lieux.items.map((lieu) => (
            <Ligne key={lieu.id} onClick={() => void ouvrirFiche(lieu.slug)}>
              <PlaceGlyph type={lieu.type} size={18} className="mt-1 text-gold-ink" />
              <Corps
                titre={<Surligne texte={lieu.name} motif={motif} />}
                sousTitre={`${libelle(PLACE_TYPE_LABELS, lieu.type)} · ${lieu.district ?? libelle(REGION_LABELS, lieu.region)}`}
                statut={activiteA(geres.parId.get(lieu.id)?.activity ?? lieu.activity)}
              />
              {ici && lieu.coordinates ? (
                <span className="shrink-0 pt-0.5 text-right caption text-ink-body">
                  {formatUnites(distance(ici.point, lieu.coordinates), ici.unitesParPixel)} ·{" "}
                  {direction(ici.point, lieu.coordinates)}
                </span>
              ) : null}
            </Ligne>
          ))}
        </Section>
      ) : null}

      {personnages.items.length > 0 ? (
        <Section titre={`PERSONNAGES · ${personnages.total}`}>
          {personnages.items.map((personnage) => (
            <Ligne key={personnage.id} onClick={() => void ouvrirSurLeHub(`/personnages/${personnage.slug}`)}>
              <UserIcon size={18} className="mt-1 text-gold-ink" />
              <Corps
                titre={<Surligne texte={personnage.name} motif={motif} />}
                sousTitre={[raceLabel(personnage.race, personnage.gender), personnage.title]
                  .filter(Boolean)
                  .join(" · ")}
              />
            </Ligne>
          ))}
        </Section>
      ) : null}

      {groupes.items.length > 0 ? (
        <Section titre={`GROUPES · ${groupes.total}`}>
          {groupes.items.map((groupe) => (
            <Ligne key={groupe.id} onClick={() => void ouvrirSurLeHub(`/groupes/${groupe.slug}`)}>
              <GroupIcon size={18} className="mt-1 text-gold-ink" />
              <Corps
                titre={<Surligne texte={groupe.name} motif={motif} />}
                sousTitre={`${groupe.memberCount} membre${groupe.memberCount > 1 ? "s" : ""}`}
              />
            </Ligne>
          ))}
        </Section>
      ) : null}

      {evenements.items.length > 0 ? (
        <Section titre={`SCÈNES · ${evenements.total}`}>
          {evenements.items.map((evenement) => (
            <LigneScene key={evenement.id} evenement={evenement} motif={motif} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

/* --- Les pièces ----------------------------------------------------------------- */

function Section({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="eyebrow border-b border-rule py-1.5 text-ink-subtle">{titre}</h2>
      {children}
    </section>
  );
}

function Vide({ libelle }: { libelle: string }) {
  return <p className="py-2 meta text-ink-muted">{libelle}</p>;
}

function Ligne({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 border-b border-hairline py-2 text-left last:border-b-0 hover:bg-surface-selected",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Corps({
  titre,
  sousTitre,
  statut = null,
}: {
  titre: ReactNode;
  sousTitre: string;
  /** Le statut d'un lieu, déjà jugé. */
  statut?: Activite | null;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate body-compact text-ink">{titre}</span>
      <span className="caption text-ink-muted">{sousTitre}</span>
      <StatutLieu activite={statut} className="mt-1" />
    </span>
  );
}

/** Le terme cherché, en or dans le nom : on voit pourquoi la ligne est là. */
function Surligne({ texte, motif }: { texte: string; motif: string }) {
  const debut = texte.toLocaleLowerCase("fr-FR").indexOf(motif.toLocaleLowerCase("fr-FR"));
  if (debut < 0) return <>{texte}</>;
  const fin = debut + motif.length;
  return (
    <>
      {texte.slice(0, debut)}
      <mark className="bg-transparent text-gold-ink">{texte.slice(debut, fin)}</mark>
      {texte.slice(fin)}
    </>
  );
}

function LigneScene({ evenement, motif }: { evenement: Evenement; motif?: string }) {
  const date = caseDeDate(evenement.startsAt);
  return (
    <Ligne onClick={() => void ouvrirSurLeHub(`/evenements/${evenement.slug}`)}>
      <span className="flex w-10 shrink-0 flex-col items-center border border-rule py-1">
        <span className="numeral text-ink">{date.quantieme}</span>
        <span className="chip-label mt-1 text-ink-muted">{date.mois}</span>
      </span>
      <Corps
        titre={motif ? <Surligne texte={evenement.title} motif={motif} /> : evenement.title}
        sousTitre={`${formatJour(evenement.startsAt)} · ${formatHeure(evenement.startsAt)} · ${evenement.locationLabel}`}
      />
      <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        {evenement.liveStatus === "en-cours" ? (
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
    </Ligne>
  );
}

function LigneRumeur({ rumeur }: { rumeur: Rumeur }) {
  return (
    <Ligne onClick={() => void ouvrirSurLeHub(`/rumeurs#rumeur-${rumeur.id}`)}>
      <RumorIcon size={18} className="mt-1 text-ink-subtle" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2 body-compact italic text-ink-body">« {rumeur.body} »</span>
        <span className="caption text-ink-muted">
          {[rumeur.character?.name, rumeur.place?.name ?? rumeur.heardAtLabel, formatJour(rumeur.createdAt)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </Ligne>
  );
}
