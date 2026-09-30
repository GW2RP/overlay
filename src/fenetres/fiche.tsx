import { useEffect, useState, type ReactNode } from "react";

import { EnCours, EnPanne } from "@/components/etat-element";
import { CloseIcon, UserIcon } from "@/components/icons";
import { Markdown } from "@/components/markdown";
import { StatutLieu } from "@/components/statut-lieu";
import { EventGlyph, PlaceGlyph } from "@/components/type-glyph";
import { Button } from "@/components/ui/button";
import { activiteA } from "@/lib/activite";
import { direction, distance, formatUnites } from "@/lib/carte";
import { caseDeDate, formatHeure, formatJour } from "@/lib/dates";
import { libelle, PLACE_TYPE_LABELS, REGION_LABELS } from "@/lib/domaine";
import { estImageDuMagasin } from "@/lib/images";
import { ouvrirSurLeHub } from "@/lib/liens";
import { evenementsDuLieu, lireLieu } from "@/lib/nexus";
import { cacherOverlay, FENETRE_FICHE, useEdition, useFicheCourante } from "@/lib/overlays";
import { usePosition } from "@/lib/position";
import type { Evenement, Lieu, Plan } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * La fiche d'un lieu, dans sa propre fenêtre.
 *
 * Elle s'ouvre depuis « À proximité », au milieu de l'écran du jeu et à sa
 * taille par défaut — Rust la pose —, et prend toujours les clics : elle
 * n'existe que pour être lue, feuilletée et fermée. Son en-tête la déplace, en
 * édition ou non ; sa croix la range. Ouverte, elle garde la place et la
 * taille qu'on lui donne : un seul lieu à la fois, en choisir un autre
 * remplace le contenu sans la bouger. Elle ne range pas son cadre : une
 * fenêtre de lecture se rouvre au milieu, pas là où on l'avait laissée. Et
 * elle ne suit pas le réglage d'opacité : ouverte, elle est là pour être lue,
 * donc son fond reste plein quoi qu'on ait réglé pour les éléments.
 *
 * Trois onglets, ceux de la fiche du hub : ce qu'on y lit, ses plans, les
 * scènes qui s'y tiennent. Le reste — la modifier, s'inscrire, signaler —
 * reste sur le hub, d'un bouton.
 */

type Onglet = "fiche" | "plans" | "scenes";

type Lecture =
  | { etat: "aucune" }
  | { etat: "en-cours"; slug: string }
  | { etat: "en-panne"; slug: string }
  | { etat: "introuvable"; slug: string }
  | { etat: "lue"; slug: string; lieu: Lieu; evenements: Evenement[] };

export function FenetreFiche() {
  const slug = useFicheCourante();
  const edition = useEdition();
  const position = usePosition();

  const [lecture, setLecture] = useState<Lecture>({ etat: "aucune" });
  const [onglet, setOnglet] = useState<Onglet>("fiche");
  const [dernierSlug, setDernierSlug] = useState(slug);

  // Un autre lieu s'ouvre : l'onglet revient au premier — on ouvre une autre
  // fiche, pas la même page — et le lieu d'avant reste affiché pendant que le
  // suivant arrive. Réglé pendant le rendu, pas dans un effet : rien à peindre
  // entre les deux états.
  if (slug !== dernierSlug) {
    setDernierSlug(slug);
    setOnglet("fiche");
    if (slug && lecture.etat !== "lue") setLecture({ etat: "en-cours", slug });
  }

  useEffect(() => {
    if (!slug) return;
    let parti = false;
    void Promise.all([lireLieu(slug), evenementsDuLieu(slug, 12)])
      .then(([lieu, evenements]) => {
        if (parti) return;
        setLecture(lieu ? { etat: "lue", slug, lieu, evenements } : { etat: "introuvable", slug });
      })
      .catch(() => {
        if (!parti) setLecture({ etat: "en-panne", slug });
      });
    return () => {
      parti = true;
    };
  }, [slug]);

  const lieu = lecture.etat === "lue" ? lecture.lieu : null;
  const ou =
    lieu && position.etat === "pret" && lieu.coordinates
      ? `${formatUnites(distance(position.point, lieu.coordinates), position.unitesParPixel)} · ${direction(position.point, lieu.coordinates)}`
      : null;

  return (
    <div
      className={cn(
        "panneau-overlay flex h-dvh w-dvw flex-col overflow-hidden border-2 text-ink",
        edition && "border-gold",
      )}
    >
      <div data-tauri-drag-region className="flex cursor-move items-start gap-2 py-3 pl-4 pr-2">
        <div data-tauri-drag-region className="flex min-w-0 flex-1 flex-col gap-1">
          {lieu ? (
            <>
              <span className="chip-label flex items-center gap-2 self-start border border-chip-edge bg-chip px-2 py-1.5 text-gold-ink">
                <PlaceGlyph type={lieu.type} size={12} />
                {libelle(PLACE_TYPE_LABELS, lieu.type).toLocaleUpperCase("fr-FR")}
              </span>
              <h1 data-tauri-drag-region className="card-title truncate text-ink">
                {lieu.name}
              </h1>
              <span className="meta text-ink-muted">
                {[lieu.district ?? libelle(REGION_LABELS, lieu.region), ou].filter(Boolean).join(" · ")}
              </span>
              <StatutLieu activite={activiteA(lieu.activity)} className="mt-1" />
            </>
          ) : (
            <span data-tauri-drag-region className="eyebrow text-gold-eyebrow">
              FICHE DU LIEU
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() =>
            void cacherOverlay(FENETRE_FICHE.label).catch((erreur) =>
              console.error("la fiche ne se range pas", erreur),
            )
          }
          aria-label="Fermer la fiche"
          className="flex size-tap shrink-0 items-center justify-center border border-rule text-ink-muted hover:bg-surface-inset hover:text-ink"
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {lecture.etat === "aucune" ? (
        <div className="px-4 py-3">
          <EnCours libelle="Aucun lieu choisi" />
        </div>
      ) : lecture.etat === "en-cours" ? (
        <div className="px-4 py-3">
          <EnCours libelle="Lecture…" />
        </div>
      ) : lecture.etat === "en-panne" ? (
        <div className="px-4 py-3">
          <EnPanne libelle="La fiche n'a pas abouti." />
        </div>
      ) : lecture.etat === "introuvable" ? (
        <div className="px-4 py-3">
          <EnCours libelle="Lieu introuvable" />
        </div>
      ) : (
        <>
          <nav aria-label="Sections de la fiche" className="mx-4 flex border-b border-rule">
            <OngletBouton actif={onglet === "fiche"} onClick={() => setOnglet("fiche")}>
              FICHE
            </OngletBouton>
            <OngletBouton actif={onglet === "plans"} onClick={() => setOnglet("plans")}>
              PLANS{lecture.lieu.floorPlans.length > 0 ? ` · ${lecture.lieu.floorPlans.length}` : ""}
            </OngletBouton>
            <OngletBouton actif={onglet === "scenes"} onClick={() => setOnglet("scenes")}>
              SCÈNES{lecture.evenements.length > 0 ? ` · ${lecture.evenements.length}` : ""}
            </OngletBouton>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {onglet === "fiche" ? (
              <Fiche lieu={lecture.lieu} />
            ) : onglet === "plans" ? (
              <Plans plans={lecture.lieu.floorPlans} />
            ) : (
              <Scenes evenements={lecture.evenements} />
            )}
          </div>

          <div className="flex justify-end border-t border-rule px-4 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void ouvrirSurLeHub(`/lieux/${lecture.lieu.slug}`)
              }
            >
              OUVRIR SUR LE HUB
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function OngletBouton({
  actif,
  onClick,
  children,
}: {
  actif: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={actif ? "page" : undefined}
      className={cn(
        "button-label -mb-px flex-1 border-b-2 py-3 text-center",
        actif ? "border-crimson text-gold-ink" : "border-transparent text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/* --- Les onglets ---------------------------------------------------------------- */

function Fiche({ lieu }: { lieu: Lieu }) {
  return (
    <div className="flex flex-col gap-4">
      {estImageDuMagasin(lieu.bannerUrl) ? (
        <img
          src={lieu.bannerUrl}
          alt={lieu.bannerAlt ?? ""}
          className="max-h-40 w-full border-2 border-rule object-cover"
        />
      ) : null}

      {lieu.summary ? <p className="body text-ink-body">{lieu.summary}</p> : null}

      {lieu.description ? (
        <Rubrique titre="DESCRIPTION">
          <Markdown texte={lieu.description} />
        </Rubrique>
      ) : null}

      {lieu.access ? (
        <Rubrique titre="ACCÈS">
          <Markdown texte={lieu.access} />
        </Rubrique>
      ) : null}

      {lieu.keepers.length > 0 ? (
        <Rubrique titre="TENANCIERS">
          <ul className="flex flex-wrap gap-2">
            {lieu.keepers.map((tenancier) => (
              <li key={tenancier.id}>
                <button
                  type="button"
                  onClick={() => void ouvrirSurLeHub(`/personnages/${tenancier.slug}`)}
                  className="flex min-h-tap items-center gap-2 border border-chip-edge bg-chip px-3 meta text-ink hover:bg-surface-selected"
                >
                  <UserIcon size={14} className="text-gold-ink" />
                  {tenancier.name}
                </button>
              </li>
            ))}
          </ul>
        </Rubrique>
      ) : null}
    </div>
  );
}

function Plans({ plans }: { plans: Plan[] }) {
  const [courant, setCourant] = useState(0);
  const plan = plans[Math.min(courant, plans.length - 1)];
  if (!plan) return <EnCours libelle="Aucun plan" />;

  return (
    <div className="flex flex-col gap-3">
      {plans.length > 1 ? (
        <div role="tablist" aria-label="Plans du lieu" className="flex flex-wrap gap-2">
          {plans.map((candidat, index) => (
            <button
              key={`${candidat.title}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === courant}
              onClick={() => setCourant(index)}
              className={cn(
                "chip-label min-h-tap border px-3",
                index === courant
                  ? "border-gold bg-surface-selected text-gold-ink"
                  : "border-chip-edge text-ink-muted hover:text-ink",
              )}
            >
              {candidat.title.toLocaleUpperCase("fr-FR")}
            </button>
          ))}
        </div>
      ) : (
        <p className="eyebrow text-gold-eyebrow">{plan.title.toLocaleUpperCase("fr-FR")}</p>
      )}

      {/* Le plan garde sa proportion d'origine, et chaque point se pose en
          pourcentage de l'image : un pixel du fichier ne désigne rien à
          l'écran. Sans image, les points gardent leurs légendes sur la hachure. */}
      <div
        className="relative w-full border-2 border-rule"
        style={
          plan.imageUrl && estImageDuMagasin(plan.imageUrl)
            ? undefined
            : { aspectRatio: plan.width && plan.height ? `${plan.width} / ${plan.height}` : "4 / 3" }
        }
      >
        {plan.imageUrl && estImageDuMagasin(plan.imageUrl) ? (
          <img src={plan.imageUrl} alt={plan.imageAlt ?? plan.title} className="block w-full" />
        ) : (
          <div className="hatch absolute inset-0 flex items-center justify-center eyebrow text-gold-eyebrow">
            [ IMAGE DU PLAN ]
          </div>
        )}
        {plan.points.map((point) => (
          <span
            key={point.number}
            className="absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-round border-2 border-crimson-edge bg-crimson button-label text-on-crimson"
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            aria-hidden="true"
          >
            {point.number}
          </span>
        ))}
      </div>

      {plan.points.length > 0 ? (
        <ol className="flex flex-col">
          {plan.points.map((point) => (
            <li
              key={point.number}
              className="flex items-start gap-3 border-b border-hairline py-2 last:border-b-0"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-round border-2 border-crimson-edge bg-crimson button-label text-on-crimson">
                {point.number}
              </span>
              <span className="flex flex-col">
                <span className="body-compact text-ink">{point.label}</span>
                {point.description ? (
                  <span className="caption text-ink-muted">{point.description}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Scenes({ evenements }: { evenements: Evenement[] }) {
  if (evenements.length === 0) return <EnCours libelle="Aucune scène annoncée" />;
  return (
    <ol className="flex flex-col">
      {evenements.map((evenement) => {
        const date = caseDeDate(evenement.startsAt);
        return (
          <li key={evenement.id}>
            <button
              type="button"
              onClick={() =>
                void ouvrirSurLeHub(`/evenements/${evenement.slug}`)
              }
              className="flex w-full items-start gap-3 border-b border-hairline py-3 text-left hover:bg-surface-selected"
            >
              <span className="flex w-12 shrink-0 flex-col items-center border border-rule py-1.5">
                <span className="numeral text-ink">{date.quantieme}</span>
                <span className="chip-label mt-1 text-ink-muted">{date.mois}</span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="body-compact text-ink">{evenement.title}</span>
                <span className="caption text-ink-muted">
                  {formatJour(evenement.startsAt)} · {formatHeure(evenement.startsAt)} heure du serveur
                </span>
                <span className="flex items-center gap-1 caption text-ink-muted">
                  <EventGlyph type={evenement.type} size={12} className="text-gold-ink" />
                  {evenement.registeredCount}
                  {evenement.capacity ? `/${evenement.capacity}` : ""} inscrit
                  {evenement.registeredCount > 1 ? "s" : ""}
                </span>
              </span>
              {evenement.liveStatus === "en-cours" ? (
                <span className="chip-label self-center border border-crimson-edge bg-crimson px-2 py-1 text-on-crimson">
                  EN COURS
                </span>
              ) : evenement.capacity && evenement.registeredCount >= evenement.capacity ? (
                <span className="chip-label self-center border border-chip-edge bg-neutral-badge px-2 py-1 text-ink">
                  COMPLET
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Rubrique({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="panel-title border-b-2 border-rule pb-1.5 text-ink">{titre}</h2>
      {children}
    </section>
  );
}
