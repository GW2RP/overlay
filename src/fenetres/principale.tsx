import { useEffect, useState, type FormEvent } from "react";

import { NexusMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Slider } from "@/components/ui/field";
import { PROFESSION_LABELS, RACE_MUMBLE_LABELS } from "@/lib/domaine";
import { formatOctets, pourcentage, useMiseAJour, type Progression } from "@/lib/mises-a-jour";
import { connecter, deconnecter, ErreurHub } from "@/lib/nexus";
import {
  basculerEdition,
  cacherOverlay,
  ELEMENTS,
  montrerOverlay,
  RACCOURCI_EDITION,
  useEdition,
  useVisibilites,
} from "@/lib/overlays";
import { usePosition } from "@/lib/position";
import {
  ecrireElementsOuverts,
  ecrireOpacite,
  ecrireUrlHub,
  lireElementsOuverts,
  lireUrlHub,
  OPACITE_MAXIMALE,
  OPACITE_MINIMALE,
  URL_HUB_PAR_DEFAUT,
  URLS_HUB_AUTORISEES,
  useOpacite,
} from "@/lib/reglages";
import { useSession } from "@/lib/session";
import type { Utilisateur } from "@/lib/types";

/**
 * La fenêtre principale : la connexion au hub, puis le tableau de bord — le
 * jeu détecté, les éléments à poser sur l'écran, le mode d'édition.
 *
 * C'est la seule fenêtre à chrome : les autres sont des éléments posés sur le
 * jeu. La fermer la range derrière l'icône de la zone de notification ; les
 * éléments restent à l'écran.
 */
export function FenetrePrincipale() {
  const { session, rafraichir } = useSession();

  return (
    <div className="mx-auto flex min-h-dvh max-w-[560px] flex-col gap-6 px-5 py-6">
      <header className="flex items-center gap-3 border-b-2 border-rule pb-4">
        <NexusMark size={32} className="text-gold" />
        <div>
          <p className="eyebrow text-gold-eyebrow">GW2RP NEXUS</p>
          <h1 className="card-title text-ink">Overlay de jeu</h1>
        </div>
      </header>

      {session.etat === "chargement" ? (
        <p className="meta text-ink-muted">Session…</p>
      ) : session.etat === "connecte" ? (
        <TableauDeBord utilisateur={session.utilisateur} onDeconnexion={rafraichir} />
      ) : (
        <Connexion
          message={session.etat === "injoignable" ? session.message : null}
          onConnexion={rafraichir}
        />
      )}

      <MiseAJour />
    </div>
  );
}

/* --- La mise à jour --------------------------------------------------------- */

/**
 * La version installée, et la release plus récente s'il y en a une. Posée
 * sous la session, connecté ou non : une mise à jour ne dépend pas du compte.
 * Rien ne s'installe sans le bouton.
 */
function MiseAJour() {
  const { version, etat, verifier, installer } = useMiseAJour();
  const miseAJour =
    etat.etat === "disponible" || etat.etat === "installation" || etat.etat === "en-panne"
      ? etat.miseAJour
      : null;

  return (
    <section className="mt-auto flex flex-col gap-3 border-t-2 border-rule pt-4">
      <div className="flex items-center justify-between gap-4">
        <p className="caption text-ink-muted">
          {version ? `Version ${version}` : "Version"}
          {etat.etat === "a-jour" ? " · à jour" : ""}
        </p>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={etat.etat === "recherche" || etat.etat === "installation"}
          onClick={() => void verifier()}
        >
          {etat.etat === "recherche" ? "RECHERCHE…" : "VÉRIFIER"}
        </Button>
      </div>

      {miseAJour ? (
        <div className="framed flex flex-col gap-3 p-5">
          <p className="body-compact text-ink">
            Version {miseAJour.version}
            <span className="caption block text-ink-muted">
              installée : {miseAJour.currentVersion}
            </span>
          </p>
          {miseAJour.body ? (
            <p className="caption max-h-40 overflow-y-auto whitespace-pre-line text-ink-body">
              {miseAJour.body}
            </p>
          ) : null}
          {etat.etat === "installation" ? (
            <Telechargement progression={etat.progression} />
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => void installer()}>
              INSTALLER ET REDÉMARRER
            </Button>
          )}
        </div>
      ) : null}

      {etat.etat === "en-panne" ? (
        <p role="alert" className="border border-crimson-edge bg-surface-inset px-4 py-3 body-compact text-crimson-ink">
          {etat.message}
        </p>
      ) : null}
    </section>
  );
}

/** Pas de barre quand la taille n'a pas été annoncée : pleine, elle dirait
 *  « fini », vide, « bloqué ». Les octets reçus en disent plus. */
function Telechargement({ progression }: { progression: Progression }) {
  const pourcent = pourcentage(progression);
  return (
    <div className="flex flex-col gap-2">
      {pourcent !== null ? (
        <div className="h-1 w-full bg-surface-inset" role="progressbar" aria-valuenow={pourcent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-gold" style={{ width: `${pourcent}%` }} />
        </div>
      ) : null}
      <p className="caption text-ink-muted">
        Téléchargement… {pourcent !== null ? `${pourcent} %` : formatOctets(progression.recus)}.
        L'application redémarrera pour terminer.
      </p>
    </div>
  );
}

/* --- La connexion ------------------------------------------------------------- */

function Connexion({
  message,
  onConnexion,
}: {
  message: string | null;
  onConnexion: () => Promise<void>;
}) {
  const [erreur, setErreur] = useState<string | null>(message);
  const [enCours, setEnCours] = useState(false);
  const [urlHub, setUrlHub] = useState(URL_HUB_PAR_DEFAUT);

  useEffect(() => {
    void lireUrlHub().then(setUrlHub);
  }, []);

  async function soumettre(evenement: FormEvent<HTMLFormElement>) {
    evenement.preventDefault();
    setErreur(null);
    setEnCours(true);
    const donnees = new FormData(evenement.currentTarget);
    try {
      await ecrireUrlHub(urlHub);
      await connecter(String(donnees.get("email") ?? ""), String(donnees.get("motDePasse") ?? ""));
      await onConnexion();
    } catch (cause) {
      setErreur(cause instanceof ErreurHub ? cause.message : "La connexion n'a pas abouti.");
    } finally {
      setEnCours(false);
    }
  }

  return (
    <form onSubmit={soumettre} className="framed flex flex-col gap-4 p-6">
      <h2 className="section-title text-ink">Se connecter</h2>

      <Field label="Adresse électronique" htmlFor="email" required>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="vous@exemple.fr"
        />
      </Field>

      <Field label="Mot de passe" htmlFor="motDePasse" required>
        <Input
          id="motDePasse"
          name="motDePasse"
          type="password"
          autoComplete="current-password"
          required
          minLength={10}
        />
      </Field>

      <Field label="Hub" htmlFor="urlHub">
        <Select id="urlHub" value={urlHub} onChange={(e) => setUrlHub(e.target.value)}>
          {URLS_HUB_AUTORISEES.map((url) => (
            <option key={url} value={url}>
              {url}
            </option>
          ))}
        </Select>
      </Field>

      {erreur ? (
        <p role="alert" className="border border-crimson-edge bg-surface-inset px-4 py-3 body-compact text-crimson-ink">
          {erreur}
        </p>
      ) : null}

      <Button type="submit" size="lead" disabled={enCours}>
        {enCours ? "CONNEXION…" : "SE CONNECTER"}
      </Button>
    </form>
  );
}

/* --- Le tableau de bord ------------------------------------------------------- */

function TableauDeBord({
  utilisateur,
  onDeconnexion,
}: {
  utilisateur: Utilisateur;
  onDeconnexion: () => Promise<void>;
}) {
  const edition = useEdition();
  const visibilites = useVisibilites();
  const position = usePosition();
  const [erreur, setErreur] = useState<string | null>(null);

  // Les éléments laissés ouverts à la fermeture précédente reviennent : c'est
  // la fenêtre principale qui les rouvre, une fois la session confirmée.
  useEffect(() => {
    void lireElementsOuverts()
      .then((labels) => Promise.all(labels.map((label) => montrerOverlay(label))))
      .catch((cause) => console.error("les éléments ne se rouvrent pas", cause));
  }, []);

  async function basculerElement(label: string) {
    setErreur(null);
    try {
      const visible = visibilites[label] ?? false;
      if (visible) await cacherOverlay(label);
      else await montrerOverlay(label);
      const ouverts = ELEMENTS.map((element) => element.label).filter((candidat) =>
        candidat === label ? !visible : (visibilites[candidat] ?? false),
      );
      await ecrireElementsOuverts(ouverts);
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : "L'élément n'a pas répondu.");
    }
  }

  async function seDeconnecter() {
    setErreur(null);
    try {
      await Promise.all(ELEMENTS.map((element) => cacherOverlay(element.label)));
      await deconnecter();
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : "La déconnexion n'a pas abouti.");
    } finally {
      await onDeconnexion();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-center justify-between gap-4">
        <p className="body-compact text-ink">
          {utilisateur.name}
          <span className="block caption text-ink-muted">{utilisateur.email}</span>
        </p>
        <Button type="button" variant="quiet" size="sm" onClick={() => void seDeconnecter()}>
          SE DÉCONNECTER
        </Button>
      </section>

      <section className="framed flex flex-col gap-2 p-5">
        <h2 className="panel-title text-ink">JEU</h2>
        <EtatDuJeu position={position} />
      </section>

      <section className="framed flex flex-col gap-3 p-5">
        <h2 className="panel-title text-ink">ÉLÉMENTS</h2>
        <ul className="flex flex-col">
          {ELEMENTS.map((element) => {
            const visible = visibilites[element.label] ?? false;
            return (
              <li
                key={element.id}
                className="flex items-center justify-between gap-4 border-t border-hairline py-2 first:border-t-0"
              >
                <span className="body-compact text-ink">{element.titre}</span>
                <Button
                  type="button"
                  variant={visible ? "outline" : "quiet"}
                  size="sm"
                  aria-pressed={visible}
                  onClick={() => void basculerElement(element.label)}
                >
                  {visible ? "AFFICHÉ" : "MASQUÉ"}
                </Button>
              </li>
            );
          })}
        </ul>
      </section>

      <Affichage />

      <section className="framed flex flex-col gap-3 p-5">
        <h2 className="panel-title text-ink">ÉDITION</h2>
        <div className="flex items-center justify-between gap-4">
          <p className="caption text-ink-muted">
            {edition
              ? "Les éléments se déplacent et se redimensionnent."
              : "Les clics traversent les éléments jusqu'au jeu."}
            <span className="block">{RACCOURCI_EDITION}</span>
          </p>
          <Button
            type="button"
            variant={edition ? "outline" : "quiet"}
            size="sm"
            aria-pressed={edition}
            onClick={() =>
              void basculerEdition().catch((cause) =>
                setErreur(cause instanceof Error ? cause.message : "Le mode n'a pas basculé."),
              )
            }
          >
            {edition ? "ÉDITION ACTIVE" : "ÉDITER"}
          </Button>
        </div>
      </section>

      {erreur ? (
        <p role="alert" className="border border-crimson-edge bg-surface-inset px-4 py-3 body-compact text-crimson-ink">
          {erreur}
        </p>
      ) : null}
    </div>
  );
}

/**
 * L'opacité du fond des éléments. Le curseur écrit dans les réglages à chaque
 * cran, et chaque élément à l'écran suit : on règle en regardant le jeu au
 * travers, pas à l'aveugle. Le texte, lui, reste entier quelle que soit la
 * valeur.
 */
function Affichage() {
  const opacite = useOpacite();

  return (
    <section className="framed flex flex-col gap-3 p-5">
      <h2 className="panel-title text-ink">AFFICHAGE</h2>
      <Field label={`Opacité du fond des éléments : ${opacite} %`} htmlFor="opacite">
        <Slider
          id="opacite"
          min={OPACITE_MINIMALE}
          max={OPACITE_MAXIMALE}
          step={5}
          value={opacite}
          onChange={(evenement) =>
            void ecrireOpacite(Number(evenement.target.value)).catch((cause) =>
              console.error("l'opacité ne s'enregistre pas", cause),
            )
          }
        />
      </Field>
    </section>
  );
}

function EtatDuJeu({ position }: { position: ReturnType<typeof usePosition> }) {
  if (position.etat === "sans-jeu") return <p className="meta text-ink-muted">Jeu non détecté</p>;
  if (position.etat === "sans-carte") {
    return <p className="meta text-ink-muted">Aucune carte chargée</p>;
  }
  if (position.etat === "carte-inconnue") {
    return <p className="meta text-ink-muted">Carte en cours de lecture</p>;
  }

  const identite = position.lien.identite;
  const traits = identite
    ? [RACE_MUMBLE_LABELS[identite.race], PROFESSION_LABELS[identite.profession]]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <>
      <p className="body-compact text-ink">
        {identite?.name ?? "Nom non transmis"}
        {traits ? <span className="text-ink-muted"> · {traits}</span> : null}
      </p>
      <p className="caption text-ink-muted">
        {position.carte.name}
        {position.etat === "hors-tyrie"
          ? ` · ${position.carte.continent_name}`
          : ` · x ${position.point.x.toLocaleString("fr-FR")} · y ${position.point.y.toLocaleString("fr-FR")}`}
      </p>
    </>
  );
}
