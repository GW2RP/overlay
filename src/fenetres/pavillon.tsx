import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { ScenePavillon } from "@/components/scene-pavillon";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import {
  CHEMIN_ARCHIVE_PAR_DEFAUT,
  ErreurDisposition,
  lireDisposition,
  lireFiches,
  lireModele,
  ouvrirArchive,
  sortesDe,
  type Decoration,
  type Disposition,
  type EtatArchive,
  type FicheDecoration,
  type Maillage,
} from "@/lib/pavillon";
import { ecrireArchive, lireArchive } from "@/lib/reglages";

/**
 * L'éditeur de pavillon : une fenêtre à part, à chrome, qu'on ouvre depuis la
 * principale. On y importe la disposition que le jeu exporte, et on la voit
 * en trois dimensions, la liste de ses décorations à côté.
 *
 * Une décoration choisie dans la liste s'allume dans la scène ; une
 * décoration cliquée dans la scène choisit sa sorte dans la liste.
 */
export function FenetrePavillon() {
  const [disposition, setDisposition] = useState<Disposition | null>(null);
  const [nomFichier, setNomFichier] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [choisie, setChoisie] = useState<number | null>(null);
  const [cliquee, setCliquee] = useState<Decoration | null>(null);
  const champ = useRef<HTMLInputElement>(null);

  const sortes = useMemo(() => (disposition ? sortesDe(disposition) : []), [disposition]);
  const ids = sortes.map((sorte) => sorte.id);
  const fiches = useFiches(ids);
  const archive = useArchive();
  const modeles = useModeles(ids, archive.ouverte);

  async function importer(evenement: ChangeEvent<HTMLInputElement>) {
    const fichier = evenement.target.files?.[0];
    // Le même fichier, réimporté après une modification, doit se relire.
    evenement.target.value = "";
    if (!fichier) return;
    setErreur(null);
    try {
      const lue = lireDisposition(await fichier.text());
      setDisposition(lue);
      setNomFichier(fichier.name);
      setChoisie(null);
      setCliquee(null);
    } catch (cause) {
      setErreur(
        cause instanceof ErreurDisposition ? cause.message : "Ce fichier ne se lit pas.",
      );
    }
  }

  function choisirDansLaScene(decoration: Decoration | null) {
    setCliquee(decoration);
    setChoisie(decoration?.id ?? null);
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-rule px-6 py-4">
        <div>
          <p className="eyebrow text-gold-eyebrow">PAVILLON</p>
          <h1 className="card-title text-ink">
            {titreDe(disposition)}
          </h1>
          {disposition && nomFichier ? (
            <p className="caption text-ink-muted">
              {nomFichier} · {disposition.decorations.length} décorations
            </p>
          ) : null}
        </div>
        <input
          ref={champ}
          type="file"
          accept=".xml,application/xml,text/xml"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => void importer(e)}
        />
        <Button type="button" onClick={() => champ.current?.click()}>
          IMPORTER UNE DISPOSITION
        </Button>
      </header>

      <BarreArchive archive={archive} />

      {erreur ? (
        <p role="alert" className="mx-6 mt-4 border border-crimson-edge bg-surface-inset px-4 py-3 body-compact text-crimson-ink">
          {erreur}
        </p>
      ) : null}

      {disposition ? (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[320px] shrink-0 flex-col border-r border-rule">
            <h2 className="panel-title border-b border-hairline px-5 py-3 text-ink">
              {`${sortes.length} SORTES`}
            </h2>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {sortes.map((sorte) => {
                const fiche = fiches.get(sorte.id);
                const active = sorte.id === choisie;
                return (
                  <li key={sorte.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setChoisie(active ? null : sorte.id);
                        setCliquee(null);
                      }}
                      className={`flex w-full items-center gap-3 border-b border-hairline px-5 py-2 text-left ${
                        active ? "bg-surface-selected" : "hover:bg-surface-selected"
                      }`}
                    >
                      <Icone fiche={fiche} />
                      <span className="min-w-0 flex-1 body-compact text-ink">{fiche?.name ?? sorte.nom}</span>
                      <span className="meta text-ink-muted">{sorte.nombre}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="relative min-w-0 flex-1">
            <ScenePavillon
              decorations={disposition.decorations}
              modeles={modeles}
              choisie={choisie}
              onChoisir={choisirDansLaScene}
            />
            {cliquee ? <Detail decoration={cliquee} fiche={fiches.get(cliquee.id)} /> : null}
          </section>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="panel-title text-ink-muted">AUCUNE DISPOSITION</p>
        </div>
      )}
    </div>
  );
}

/** Le nom de la carte, son numéro à défaut, et rien d'inventé sans l'un ni
 *  l'autre. */
function titreDe(disposition: Disposition | null): string {
  if (disposition?.carteNom) return disposition.carteNom;
  if (disposition?.carteId) return `Carte ${disposition.carteId}`;
  return "Éditeur de pavillon";
}

/** L'icône de l'API, ou sa place vide de même taille tant qu'elle manque. */
function Icone({ fiche }: { fiche: FicheDecoration | undefined }) {
  return fiche?.icon ? (
    <img src={fiche.icon} alt="" width={32} height={32} className="size-8 shrink-0" />
  ) : (
    <span aria-hidden="true" className="size-8 shrink-0 border border-rule bg-surface-inset" />
  );
}

function Detail({ decoration, fiche }: { decoration: Decoration; fiche: FicheDecoration | undefined }) {
  const [x, y, z] = decoration.position;
  return (
    <div className="absolute top-4 left-4 flex max-w-[360px] items-start gap-3 border border-rule bg-surface p-4">
      <Icone fiche={fiche} />
      <div className="min-w-0">
        <p className="body-compact text-ink">{fiche?.name ?? decoration.nom}</p>
        <p className="caption text-ink-muted">
          n° {decoration.id} · x {Math.round(x)} · y {Math.round(y)} · z {Math.round(z)} · échelle{" "}
          {decoration.echelle.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}
        </p>
      </div>
    </div>
  );
}

/** Les fiches de l'API pour les sortes de la disposition. Sans réponse, la
 *  liste garde les noms du fichier, que le jeu écrit déjà en français. */
function useFiches(ids: number[]): Map<number, FicheDecoration> {
  const [fiches, setFiches] = useState<Map<number, FicheDecoration>>(new Map());
  const cle = ids.join(",");

  useEffect(() => {
    if (!cle) return;
    let parti = false;
    lireFiches(cle.split(",").map(Number))
      .then((lues) => {
        if (!parti) setFiches(lues);
      })
      .catch((cause) => console.error("les fiches des décorations ne se lisent pas", cause));
    return () => {
      parti = true;
    };
  }, [cle]);

  return fiches;
}

type Archive = {
  chemin: string;
  setChemin: (chemin: string) => void;
  ouverte: EtatArchive | null;
  enCours: boolean;
  erreur: string | null;
  ouvrir: (chemin: string) => void;
};

/** L'archive du jeu, d'où viennent les modèles. Celle de la dernière fois se
 *  rouvre d'elle-même ; sans elle, la scène montre des repères. */
function useArchive(): Archive {
  const [chemin, setChemin] = useState("");
  const [ouverte, setOuverte] = useState<EtatArchive | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const indice = useRef<number | null>(null);

  function ouvrir(demande: string) {
    setEnCours(true);
    setErreur(null);
    ouvrirArchive(demande, indice.current)
      .then((etat) => {
        // Rouverte, l'archive a pu être mise à jour : ses modèles se relisent.
        modelesLus.delete(etat.chemin);
        setOuverte(etat);
        indice.current = etat.paquet;
        return ecrireArchive({ chemin: etat.chemin, paquet: etat.paquet });
      })
      .catch((cause) => {
        setOuverte(null);
        setErreur(typeof cause === "string" ? cause : "L'archive ne s'ouvre pas.");
      })
      .finally(() => setEnCours(false));
  }

  useEffect(() => {
    let parti = false;
    lireArchive()
      .then((rangee) => {
        if (parti) return;
        if (!rangee) {
          setChemin(CHEMIN_ARCHIVE_PAR_DEFAUT);
          return;
        }
        setChemin(rangee.chemin);
        indice.current = rangee.paquet;
        ouvrir(rangee.chemin);
      })
      .catch(() => {
        if (!parti) setChemin(CHEMIN_ARCHIVE_PAR_DEFAUT);
      });
    return () => {
      parti = true;
    };
  }, []);

  return { chemin, setChemin, ouverte, enCours, erreur, ouvrir };
}

function BarreArchive({ archive }: { archive: Archive }) {
  function soumettre(evenement: FormEvent) {
    evenement.preventDefault();
    if (archive.chemin.trim()) archive.ouvrir(archive.chemin.trim());
  }

  return (
    <form onSubmit={soumettre} className="flex flex-wrap items-end gap-3 border-b border-rule px-6 py-3">
      <div className="flex min-w-[320px] flex-1 flex-col gap-2">
        <Label htmlFor="archive-gw2">Archive du jeu (Gw2.dat)</Label>
        <Input
          id="archive-gw2"
          value={archive.chemin}
          spellCheck={false}
          onChange={(e) => archive.setChemin(e.target.value)}
        />
      </div>
      <Button type="submit" variant="outline" disabled={archive.enCours}>
        {archive.enCours ? "OUVERTURE…" : "OUVRIR L'ARCHIVE"}
      </Button>
      <p role="status" className="basis-full caption text-ink-muted">
        {archive.erreur ? (
          <span className="text-crimson-ink">{archive.erreur}</span>
        ) : archive.ouverte ? (
          `${archive.ouverte.decorations} modèles · ${archive.ouverte.chemin}`
        ) : archive.enCours ? (
          "Lecture de l'archive…"
        ) : (
          "Archive fermée"
        )}
      </p>
    </form>
  );
}

/** Lectures de modèles menées de front : chacune occupe un fil de Rust et
 *  ses tampons, et une disposition compte plus de cent sortes. */
const LECTURES_SIMULTANEES = 6;

/** Les modèles déjà lus, par archive puis par décoration : un nouvel import
 *  ne relit pas ce qu'un autre a déjà décompressé. */
const modelesLus = new Map<string, Map<number, Maillage[]>>();

/** Les modèles des sortes de la disposition, lus dans l'archive ouverte. La
 *  table se pose au fil des lectures, pas une fois la dernière finie. Une
 *  sorte sans modèle reste absente de la table : la scène la montre en
 *  repère. */
function useModeles(ids: number[], archive: EtatArchive | null): Map<number, Maillage[]> {
  const [modeles, setModeles] = useState<Map<number, Maillage[]>>(new Map());
  const cle = ids.join(",");
  const ouverte = archive?.chemin ?? null;

  useEffect(() => {
    if (!cle || !ouverte) return;
    let parti = false;
    let lus = modelesLus.get(ouverte);
    if (!lus) {
      lus = new Map();
      modelesLus.set(ouverte, lus);
    }
    const memoire = lus;
    const voulus = cle.split(",").map(Number);
    const presents = () =>
      new Map(voulus.flatMap((id) => (memoire.get(id)?.length ? [[id, memoire.get(id)!]] : [])));
    const restants = voulus.filter((id) => !memoire.has(id));

    // Une image par lot plutôt qu'une par modèle : la scène se reconstruit
    // à chaque nouvelle table.
    let enAttente = false;
    const publier = () => {
      if (enAttente) return;
      enAttente = true;
      requestAnimationFrame(() => {
        enAttente = false;
        if (!parti) setModeles(presents());
      });
    };

    const suivant = async (): Promise<void> => {
      const id = restants.shift();
      if (id === undefined || parti) return;
      try {
        memoire.set(id, await lireModele(id));
      } catch (cause) {
        console.error(`le modèle de la décoration ${id} ne se lit pas`, cause);
      }
      publier();
      return suivant();
    };
    // Ce que la mémoire a déjà, tout de suite ; le reste au fil des lectures.
    publier();
    for (let i = 0; i < LECTURES_SIMULTANEES; i++) void suivant();

    return () => {
      parti = true;
    };
  }, [cle, ouverte]);

  return ouverte ? modeles : VIDE;
}

const VIDE = new Map<number, Maillage[]>();
