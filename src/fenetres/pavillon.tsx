import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import { CataloguePavillon } from "@/components/catalogue-pavillon";
import { InspecteurPavillon } from "@/components/inspecteur-pavillon";
import { Modale } from "@/components/modale";
import { ScenePavillon, type Outil } from "@/components/scene-pavillon";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";
import {
  choisirDossier,
  dossierDispositions,
  ecrireFichierDisposition,
  exporterDisposition,
  lireFichierDisposition,
  listerDispositions,
  nomDeFichier,
  sansExtension,
  type FichierDisposition,
} from "@/lib/dispositions";
import { useHistorique } from "@/lib/historique";
import {
  CHEMIN_ARCHIVE_PAR_DEFAUT,
  ErreurDisposition,
  ecrireDisposition,
  lireDisposition,
  lireFiches,
  lireModele,
  lireTexture,
  nouvelleCle,
  ouvrirArchive,
  sortesDe,
  type Decoration,
  type Disposition,
  type EtatArchive,
  type FicheDecoration,
  type Maillage,
  type TextureLue,
} from "@/lib/pavillon";
import { ecrireArchive, lireArchive } from "@/lib/reglages";

/**
 * L'éditeur de pavillon : une fenêtre à part, à chrome, qu'on ouvre depuis la
 * principale. On y choisit le dossier où le jeu range ses dispositions, on en
 * ouvre une — ou on importe un fichier d'ailleurs —, on la voit en trois
 * dimensions et on la corrige : déplacer, tourner, mettre à l'échelle,
 * ajouter, dupliquer, retirer, une décoration ou plusieurs à la fois.
 *
 * Chaque geste pose un nouvel état (`useHistorique`) : « annuler » rend le
 * précédent. Enregistrer écrit un nouveau fichier dans le dossier, ou
 * remplace celui d'où la disposition vient ; exporter l'écrit ailleurs.
 */

/** Une disposition ouverte : ce que son en-tête dit, et d'où elle vient. */
type Ouverte = {
  disposition: Disposition;
  /** Le fichier du dossier d'où elle a été lue ou où elle a été
   *  enregistrée ; `null` pour un fichier importé d'ailleurs. */
  fichier: string | null;
  /** Le dossier de ce fichier. On peut changer de dossier, disposition
   *  ouverte : « remplacer » ne vaut que dans celui-ci, sans quoi il
   *  écraserait l'homonyme d'un autre dossier. */
  dossier: string | null;
  /** Son nom, sans extension : celui du fichier, ou de l'import. */
  nom: string;
};

type Onglet = "dispositions" | "decorations";

type EtatModale = { type: "enregistrer" } | { type: "abandonner"; ensuite: () => void } | null;

/** Le pas des poignées et des flèches, en pouces. */
const PAS_POSITION = [1, 10, 50, 100] as const;
/** Le pas de la poignée de rotation, en degrés. */
const PAS_ANGLE = [5, 15, 45, 90] as const;
/** Le pas des flèches quand les poignées sont libres. */
const PAS_CLAVIER_LIBRE = 10;

const OUTILS: { outil: Outil; libelle: string }[] = [
  { outil: "deplacer", libelle: "DÉPLACER" },
  { outil: "tourner", libelle: "TOURNER" },
  { outil: "echelle", libelle: "ÉCHELLE" },
];

/** Une erreur de Rust, ou d'ailleurs, en une phrase. */
function phrase(cause: unknown, defaut: string): string {
  const texte = typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "";
  if (!texte) return defaut;
  const debut = texte.charAt(0).toLocaleUpperCase("fr-FR") + texte.slice(1);
  return /[.!?…]$/.test(debut) ? debut : `${debut}.`;
}

export function FenetrePavillon() {
  const [ouverte, setOuverte] = useState<Ouverte | null>(null);
  const [cadrage, setCadrage] = useState(0);
  const historique = useHistorique<Decoration[]>([]);
  const decorations = historique.present;
  const [choix, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [outil, setOutil] = useState<Outil>("deplacer");
  const [pas, setPas] = useState<number | null>(10);
  const [pasAngle, setPasAngle] = useState<number | null>(15);
  const [onglet, setOnglet] = useState<Onglet>("dispositions");
  const [catalogue, setCatalogue] = useState(false);
  const [modale, setModale] = useState<EtatModale>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [annonce, setAnnonce] = useState<string | null>(null);
  const champ = useRef<HTMLInputElement>(null);
  const pointDePose = useRef<(() => [number, number, number]) | null>(null);
  /** Le numéro de la dernière ouverture demandée : une lecture plus lente,
   *  partie avant, ne remplace pas ce qu'on a ouvert depuis. */
  const ouverture = useRef(0);

  const dossier = useDossier();
  const sortes = useMemo(() => sortesDe(decorations), [decorations]);
  // Triés, pour que la clé des lectures ne bouge pas quand l'ordre des
  // sortes change avec leur nombre : seul un nouvel identifiant relit.
  const ids = useMemo(() => sortes.map((sorte) => sorte.id).sort((a, b) => a - b), [sortes]);
  const fiches = useFiches(ids);
  const archive = useArchive();
  const modeles = useModeles(ids, archive.ouverte);
  const textures = useTextures(modeles, archive.ouverte);

  // Une annulation peut retirer une décoration choisie : la sélection ne
  // garde que celles qui existent encore.
  const selection = useMemo<ReadonlySet<number>>(() => {
    const presentes = decorations.filter((d) => choix.has(d.cle)).map((d) => d.cle);
    return presentes.length === choix.size ? choix : new Set(presentes);
  }, [decorations, choix]);
  const choisies = useMemo(() => decorations.filter((d) => selection.has(d.cle)), [decorations, selection]);
  const rangs = useMemo(() => new Map(decorations.map((d, i) => [d.cle, i + 1])), [decorations]);

  /* --- Ouvrir ------------------------------------------------------------- */

  function ouvrir(texte: string, fichier: string | null, depuis: string | null, nom: string) {
    try {
      const lue = lireDisposition(texte);
      setOuverte({ disposition: lue, fichier, dossier: depuis, nom });
      historique.repartir(lue.decorations);
      setSelection(new Set());
      setCadrage((c) => c + 1);
      setErreur(null);
      setAnnonce(null);
    } catch (cause) {
      setErreur(cause instanceof ErreurDisposition ? cause.message : "Ce fichier ne se lit pas.");
    }
  }

  /** Quitter une disposition modifiée demande d'abandonner ses
   *  modifications. */
  function apresConfirmation(action: () => void) {
    if (historique.modifie) setModale({ type: "abandonner", ensuite: action });
    else action();
  }

  function chargerFichier(nom: string) {
    if (!dossier.dossier) return;
    const depuis = dossier.dossier;
    apresConfirmation(() => {
      const numero = ++ouverture.current;
      lireFichierDisposition(nom)
        .then((texte) => {
          if (numero === ouverture.current) ouvrir(texte, nom, depuis, sansExtension(nom));
        })
        .catch((cause) => {
          if (numero === ouverture.current) setErreur(phrase(cause, "Ce fichier ne se lit pas."));
        });
    });
  }

  async function importer(evenement: ChangeEvent<HTMLInputElement>) {
    const fichier = evenement.target.files?.[0];
    // Le même fichier, réimporté après une modification, doit se relire.
    evenement.target.value = "";
    if (!fichier) return;
    const texte = await fichier.text();
    apresConfirmation(() => {
      ++ouverture.current;
      ouvrir(texte, null, null, sansExtension(fichier.name));
    });
  }

  /* --- Les gestes --------------------------------------------------------- */

  /** Un geste qui ne change rien — une saisie retapée à l'identique — n'en
   *  est pas un : ni entrée d'historique, ni disposition « modifiée ».
   *  `fusionner` prolonge le geste d'avant : une flèche maintenue se répète,
   *  et s'annule d'un coup. */
  const remplacer = useCallback(
    (modifiees: Decoration[], fusionner = false) => {
      const parCle = new Map(modifiees.map((d) => [d.cle, d]));
      let change = false;
      const suivantes = decorations.map((d) => {
        const m = parCle.get(d.cle);
        if (!m || memePlace(m, d)) return d;
        change = true;
        return m;
      });
      if (change) historique.appliquer(suivantes, fusionner);
    },
    [decorations, historique],
  );

  const cliquer = useCallback((cle: number | null, ajouter: boolean) => {
    setSelection((avant) => {
      if (cle === null) return ajouter ? avant : new Set();
      if (!ajouter) return new Set([cle]);
      const suivante = new Set(avant);
      if (suivante.has(cle)) suivante.delete(cle);
      else suivante.add(cle);
      return suivante;
    });
  }, []);

  function choisirSorte(id: number, ajouter: boolean) {
    const cles = decorations.filter((d) => d.id === id).map((d) => d.cle);
    const toutes = cles.every((cle) => selection.has(cle));
    if (!ajouter) {
      setSelection(toutes && cles.length === selection.size ? new Set() : new Set(cles));
      return;
    }
    const suivante = new Set(selection);
    for (const cle of cles) {
      if (toutes) suivante.delete(cle);
      else suivante.add(cle);
    }
    setSelection(suivante);
  }

  function ajouter(fiche: FicheDecoration) {
    const nouvelle: Decoration = {
      cle: nouvelleCle(),
      id: fiche.id,
      nom: fiche.name,
      position: pointDePose.current?.() ?? [0, 0, 0],
      rotation: [0, 0, 0],
      echelle: 1,
    };
    historique.appliquer([...decorations, nouvelle]);
    setSelection(new Set([nouvelle.cle]));
  }

  /** Les copies se posent sur les originaux, choisies à leur place : on les
   *  emmène ensuite aux poignées ou aux flèches. */
  function dupliquer() {
    if (choisies.length === 0) return;
    const copies = choisies.map((d) => ({ ...d, cle: nouvelleCle() }));
    historique.appliquer([...decorations, ...copies]);
    setSelection(new Set(copies.map((d) => d.cle)));
  }

  function retirer() {
    if (choisies.length === 0) return;
    historique.appliquer(decorations.filter((d) => !selection.has(d.cle)));
    setSelection(new Set());
  }

  function deplacer([dx, dy, dz]: [number, number, number], repetition: boolean) {
    if (choisies.length === 0) return;
    remplacer(
      choisies.map((d) => ({
        ...d,
        position: [d.position[0] + dx, d.position[1] + dy, d.position[2] + dz],
      })),
      repetition,
    );
  }

  // Le clavier de la scène. Les champs gardent leurs touches, et une boîte
  // ouverte garde toutes les siennes.
  const clavier = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    clavier.current = (e: KeyboardEvent) => {
      if (!ouverte || modale) return;
      const cible = e.target as HTMLElement | null;
      if (cible?.closest("input, select, textarea")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const touche = e.key.toLowerCase();
      const pasClavier = (pas ?? PAS_CLAVIER_LIBRE) / (e.shiftKey ? 10 : 1);
      const fleches: Record<string, [number, number, number]> = {
        arrowleft: [-pasClavier, 0, 0],
        arrowright: [pasClavier, 0, 0],
        arrowup: [0, pasClavier, 0],
        arrowdown: [0, -pasClavier, 0],
        // z compte vers le bas : monter, c'est le diminuer.
        pageup: [0, 0, -pasClavier],
        pagedown: [0, 0, pasClavier],
      };
      if (ctrl && touche === "z" && !e.shiftKey) historique.annuler();
      else if (ctrl && (touche === "y" || (touche === "z" && e.shiftKey))) historique.retablir();
      else if (ctrl && touche === "d") dupliquer();
      else if (ctrl && touche === "a") setSelection(new Set(decorations.map((d) => d.cle)));
      else if (!ctrl && (e.key === "Delete" || e.key === "Backspace")) retirer();
      else if (e.key === "Escape") setSelection(new Set());
      else if (!ctrl && fleches[touche] && choisies.length > 0) deplacer(fleches[touche], e.repeat);
      else return;
      e.preventDefault();
    };
  });
  useEffect(() => {
    const ecouter = (e: KeyboardEvent) => clavier.current(e);
    window.addEventListener("keydown", ecouter);
    return () => window.removeEventListener("keydown", ecouter);
  }, []);

  /* --- Écrire ------------------------------------------------------------- */

  function texteCourant(): string {
    return ouverte ? ecrireDisposition({ ...ouverte.disposition, decorations }) : "";
  }

  async function enregistrer(nom: string, remplacerFichier: boolean): Promise<void> {
    if (!ouverte || !dossier.dossier) return;
    await ecrireFichierDisposition(dossier.dossier, nom, texteCourant(), remplacerFichier);
    setOuverte({ ...ouverte, fichier: nom, dossier: dossier.dossier, nom: sansExtension(nom) });
    historique.marquerEnregistre();
    setModale(null);
    setAnnonce(`Enregistrée dans ${nom}`);
    void dossier.rafraichir();
  }

  function exporter() {
    if (!ouverte) return;
    setErreur(null);
    exporterDisposition(nomDeFichier(ouverte.nom), texteCourant())
      .then((chemin) => {
        if (chemin) setAnnonce(`Exportée vers ${chemin}`);
      })
      .catch((cause) => setErreur(phrase(cause, "La disposition ne s'exporte pas.")));
  }

  /* --- L'écran ------------------------------------------------------------ */

  const meta = ouverte
    ? [
        titreDe(ouverte.disposition),
        `${decorations.length} décorations`,
        ouverte.fichier ?? "importée",
      ].join(" · ")
    : null;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b-2 border-rule px-6 py-4">
        <div className="min-w-0">
          <p className="eyebrow text-gold-eyebrow">PAVILLON</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="card-title text-ink">{ouverte ? ouverte.nom : "Éditeur de pavillon"}</h1>
            {historique.modifie ? (
              <span className="border border-chip-edge bg-chip px-2 py-1 chip-label text-gold-ink">MODIFIÉE</span>
            ) : null}
          </div>
          {meta ? <p className="caption text-ink-muted">{meta}</p> : null}
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
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="outline" onClick={() => champ.current?.click()}>
            IMPORTER UN FICHIER
          </Button>
          <Button type="button" variant="outline" disabled={!ouverte} onClick={exporter}>
            EXPORTER…
          </Button>
          <Button
            type="button"
            variant={modale ? "outline" : "default"}
            disabled={!ouverte}
            onClick={() => setModale({ type: "enregistrer" })}
          >
            ENREGISTRER
          </Button>
        </div>
      </header>

      <BarreArchive archive={archive} />

      {erreur ? (
        <p role="alert" className="mx-6 mt-4 border border-crimson-edge bg-surface-inset px-4 py-3 body-compact text-crimson-ink">
          {erreur}
        </p>
      ) : null}
      <p role="status" className={annonce ? "mx-6 mt-4 caption text-ink-muted" : "sr-only"}>
        {annonce}
      </p>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-xs shrink-0 flex-col border-r border-rule">
          <nav aria-label="Colonne" className="flex border-b border-hairline">
            {(["dispositions", "decorations"] as const).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={onglet === o}
                onClick={() => setOnglet(o)}
                className={`min-h-tap flex-1 border-b-2 button-label ${
                  onglet === o ? "border-crimson text-gold-ink" : "border-transparent text-ink-muted"
                }`}
              >
                {o === "dispositions" ? "DISPOSITIONS" : "DÉCORATIONS"}
              </button>
            ))}
          </nav>
          {onglet === "dispositions" ? (
            <ListeDispositions
              dossier={dossier}
              courant={ouverte && ouverte.dossier === dossier.dossier ? ouverte.fichier : null}
              onOuvrir={chargerFichier}
            />
          ) : (
            <ListeSortes
              sortes={sortes}
              fiches={fiches}
              selection={selection}
              decorations={decorations}
              onChoisir={choisirSorte}
            />
          )}
        </aside>

        {ouverte ? (
          <>
            <section className="flex min-w-0 flex-1 flex-col">
              <div role="toolbar" aria-label="Outils" className="flex flex-wrap items-end gap-3 border-b border-rule px-4 py-3">
                <div className="flex">
                  {OUTILS.map(({ outil: o, libelle }) => (
                    <Button
                      key={o}
                      type="button"
                      size="sm"
                      variant={outil === o ? "outline" : "quiet"}
                      aria-pressed={outil === o}
                      onClick={() => setOutil(o)}
                    >
                      {libelle}
                    </Button>
                  ))}
                </div>
                <ChoixPas
                  id="pas-position"
                  etiquette="Pas"
                  valeur={pas}
                  choix={PAS_POSITION.map((p) => ({ valeur: p, libelle: `${p} pouces` }))}
                  onChange={setPas}
                />
                <ChoixPas
                  id="pas-angle"
                  etiquette="Angle"
                  valeur={pasAngle}
                  choix={PAS_ANGLE.map((p) => ({ valeur: p, libelle: `${p}°` }))}
                  onChange={setPasAngle}
                />
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="quiet" disabled={!historique.peutAnnuler} onClick={historique.annuler}>
                    ANNULER
                  </Button>
                  <Button type="button" size="sm" variant="quiet" disabled={!historique.peutRetablir} onClick={historique.retablir}>
                    RÉTABLIR
                  </Button>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-pressed={catalogue}
                  className="ml-auto"
                  onClick={() => setCatalogue((c) => !c)}
                >
                  AJOUTER UNE DÉCORATION
                </Button>
              </div>
              <div className="relative min-h-0 flex-1">
                <ScenePavillon
                  cadrage={cadrage}
                  decorations={decorations}
                  modeles={modeles}
                  textures={textures}
                  selection={selection}
                  outil={outil}
                  pasPosition={pas}
                  pasAngle={pasAngle === null ? null : (pasAngle * Math.PI) / 180}
                  onCliquer={cliquer}
                  onTransformer={remplacer}
                  pointDePoseRef={pointDePose}
                />
              </div>
            </section>
            <aside className="flex w-sm shrink-0 flex-col border-l border-rule">
              {catalogue ? (
                <CataloguePavillon onChoisir={ajouter} onFermer={() => setCatalogue(false)} />
              ) : (
                <InspecteurPavillon
                  choisies={choisies}
                  fiches={fiches}
                  rangs={rangs}
                  onModifier={(d) => remplacer([d])}
                  onDupliquer={dupliquer}
                  onRetirer={retirer}
                />
              )}
            </aside>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="panel-title text-ink-muted">AUCUNE DISPOSITION</p>
          </div>
        )}
      </div>

      {modale?.type === "abandonner" ? (
        <Modale
          titre="ABANDONNER LES MODIFICATIONS ?"
          onFermer={() => setModale(null)}
          actions={
            <>
              <Button type="button" variant="quiet" onClick={() => setModale(null)}>
                ANNULER
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setModale(null);
                  modale.ensuite();
                }}
              >
                ABANDONNER
              </Button>
            </>
          }
        />
      ) : null}
      {modale?.type === "enregistrer" && ouverte ? (
        <ModaleEnregistrer
          ouverte={ouverte}
          dossier={dossier}
          onEnregistrer={enregistrer}
          onFermer={() => setModale(null)}
        />
      ) : null}
    </div>
  );
}

/** Deux états d'une décoration à la même place, à la même taille. */
function memePlace(a: Decoration, b: Decoration): boolean {
  return (
    a.id === b.id &&
    a.echelle === b.echelle &&
    a.position.every((v, i) => v === b.position[i]) &&
    a.rotation.every((v, i) => v === b.rotation[i])
  );
}

/** Le nom de la carte, son numéro à défaut, et rien d'inventé sans l'un ni
 *  l'autre. */
function titreDe(disposition: Disposition): string {
  if (disposition.carteNom) return disposition.carteNom;
  if (disposition.carteId) return `Carte ${disposition.carteId}`;
  return "Carte inconnue";
}

function ChoixPas({
  id,
  etiquette,
  valeur,
  choix,
  onChange,
}: {
  id: string;
  etiquette: string;
  valeur: number | null;
  choix: { valeur: number; libelle: string }[];
  onChange: (valeur: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="caption">
        {etiquette}
      </Label>
      <Select
        id={id}
        value={valeur ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="w-auto py-2"
      >
        <option value="">Libre</option>
        {choix.map((c) => (
          <option key={c.valeur} value={c.valeur}>
            {c.libelle}
          </option>
        ))}
      </Select>
    </div>
  );
}

/* --- Le dossier --------------------------------------------------------------- */

type Dossier = {
  dossier: string | null;
  fichiers: FichierDisposition[];
  erreur: string | null;
  choisir: () => Promise<void>;
  rafraichir: () => Promise<void>;
};

/** Le dossier des dispositions, tenu par Rust : celui qu'on a choisi, à
 *  défaut celui où le jeu les range sur cette machine. L'écran ne fait que
 *  le montrer. La liste se relit quand la fenêtre reprend le focus : on
 *  revient d'un export fait dans le jeu. */
function useDossier(): Dossier {
  const [dossier, setDossier] = useState<string | null>(null);
  const [fichiers, setFichiers] = useState<FichierDisposition[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);

  const lire = useCallback(async () => {
    try {
      const lus = await listerDispositions();
      lus.sort((a, b) => a.nom.localeCompare(b.nom, "fr-FR"));
      setFichiers(lus);
      setErreur(null);
    } catch (cause) {
      setFichiers([]);
      setErreur(phrase(cause, "Ce dossier ne se lit pas."));
    }
  }, []);

  useEffect(() => {
    let parti = false;
    (async () => {
      const chemin = await dossierDispositions();
      if (parti || !chemin) return;
      setDossier(chemin);
      await lire();
    })().catch((cause) => console.error("le dossier des dispositions ne se lit pas", cause));
    return () => {
      parti = true;
    };
  }, [lire]);

  useEffect(() => {
    if (!dossier) return;
    const relire = () => void lire();
    window.addEventListener("focus", relire);
    return () => window.removeEventListener("focus", relire);
  }, [dossier, lire]);

  const choisir = useCallback(async () => {
    try {
      const chemin = await choisirDossier();
      if (!chemin) return;
      setDossier(chemin);
      await lire();
    } catch (cause) {
      setErreur(phrase(cause, "Ce dossier ne se choisit pas."));
    }
  }, [lire]);

  const rafraichir = useCallback(() => (dossier ? lire() : Promise.resolve()), [dossier, lire]);

  return { dossier, fichiers, erreur, choisir, rafraichir };
}

function ChampDossier({ dossier }: { dossier: Dossier }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="dossier-dispositions">Dossier des dispositions</Label>
      <div className="flex gap-2">
        <Input
          id="dossier-dispositions"
          readOnly
          value={dossier.dossier ?? ""}
          placeholder="Aucun dossier"
          title={dossier.dossier ?? undefined}
          className="min-w-0 flex-1 caption"
        />
        <Button type="button" variant="quiet" size="sm" onClick={() => void dossier.choisir()}>
          CHOISIR…
        </Button>
      </div>
      {dossier.erreur ? (
        <p role="alert" className="caption text-crimson-ink">
          {dossier.erreur}
        </p>
      ) : null}
    </div>
  );
}

function ListeDispositions({
  dossier,
  courant,
  onOuvrir,
}: {
  dossier: Dossier;
  courant: string | null;
  onOuvrir: (nom: string) => void;
}) {
  const [recherche, setRecherche] = useState("");
  const cherche = recherche.trim().toLocaleLowerCase("fr-FR");
  const trouves = dossier.fichiers.filter(
    (f) =>
      !cherche ||
      f.nom.toLocaleLowerCase("fr-FR").includes(cherche) ||
      (f.carte ?? "").toLocaleLowerCase("fr-FR").includes(cherche),
  );

  return (
    <>
      <div className="flex flex-col gap-4 px-5 py-4">
        <ChampDossier dossier={dossier} />
        {dossier.fichiers.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="recherche-dispositions">Rechercher</Label>
            <Input
              id="recherche-dispositions"
              type="search"
              placeholder="Nom ou carte"
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
            />
          </div>
        ) : null}
      </div>
      {dossier.dossier ? (
        <>
          <h2 className="panel-title border-y border-hairline px-5 py-3 text-ink">
            {trouves.length === 0 ? "AUCUNE DISPOSITION" : `${trouves.length} DISPOSITIONS`}
          </h2>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {trouves.map((f) => {
              const actif = f.nom === courant;
              const details = [f.carte, f.decorations === null ? null : `${f.decorations} décorations`]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={f.nom}>
                  <button
                    type="button"
                    aria-current={actif || undefined}
                    onClick={() => onOuvrir(f.nom)}
                    className={`flex w-full flex-col gap-1 border-b border-l-2 border-b-hairline px-5 py-3 text-left ${
                      actif ? "border-l-crimson bg-surface-selected" : "border-l-transparent hover:bg-surface-selected"
                    }`}
                  >
                    <span className="body-compact text-ink">{sansExtension(f.nom)}</span>
                    {details ? <span className="caption text-ink-muted">{details}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </>
  );
}

function ListeSortes({
  sortes,
  fiches,
  selection,
  decorations,
  onChoisir,
}: {
  sortes: ReturnType<typeof sortesDe>;
  fiches: Map<number, FicheDecoration>;
  selection: ReadonlySet<number>;
  decorations: Decoration[];
  onChoisir: (id: number, ajouter: boolean) => void;
}) {
  const choisiesParSorte = new Map<number, number>();
  for (const d of decorations) {
    if (selection.has(d.cle)) choisiesParSorte.set(d.id, (choisiesParSorte.get(d.id) ?? 0) + 1);
  }
  return (
    <>
      <h2 className="panel-title border-b border-hairline px-5 py-3 text-ink">
        {sortes.length === 0 ? "AUCUNE DÉCORATION" : `${sortes.length} SORTES`}
      </h2>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {sortes.map((sorte) => {
          const fiche = fiches.get(sorte.id);
          const choisies = choisiesParSorte.get(sorte.id) ?? 0;
          return (
            <li key={sorte.id}>
              <button
                type="button"
                aria-pressed={choisies === sorte.nombre}
                onClick={(e) => onChoisir(sorte.id, e.ctrlKey || e.metaKey || e.shiftKey)}
                className={`flex w-full items-center gap-3 border-b border-hairline px-5 py-2 text-left ${
                  choisies > 0 ? "bg-surface-selected" : "hover:bg-surface-selected"
                }`}
              >
                <Icone fiche={fiche} />
                <span className="min-w-0 flex-1 body-compact text-ink">{fiche?.name ?? sorte.nom}</span>
                <span className="meta text-ink-muted">
                  {choisies > 0 && choisies < sorte.nombre ? `${choisies} / ${sorte.nombre}` : sorte.nombre}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** L'icône de l'API, ou sa place vide de même taille tant qu'elle manque. */
function Icone({ fiche }: { fiche: FicheDecoration | undefined }) {
  return fiche?.icon ? (
    <img src={fiche.icon} alt="" width={32} height={32} className="size-8 shrink-0" />
  ) : (
    <span aria-hidden="true" className="size-8 shrink-0 border border-rule bg-surface-inset" />
  );
}

/* --- Enregistrer --------------------------------------------------------------- */

/** Le premier nom libre du dossier : le nom lui-même, puis « nom (2) »,
 *  « nom (3) »… */
function nomLibre(base: string, fichiers: FichierDisposition[]): string {
  const pris = new Set(fichiers.map((f) => f.nom.toLocaleLowerCase("fr-FR")));
  const libre = (nom: string) => !pris.has(nomDeFichier(nom).toLocaleLowerCase("fr-FR"));
  if (libre(base)) return base;
  for (let n = 2; ; n++) {
    if (libre(`${base} (${n})`)) return `${base} (${n})`;
  }
}

/** Par défaut, un nouveau fichier : on ne perd pas l'original sans l'avoir
 *  demandé. Remplacer ne s'offre que pour une disposition lue dans le
 *  dossier courant. */
function ModaleEnregistrer({
  ouverte,
  dossier,
  onEnregistrer,
  onFermer,
}: {
  ouverte: Ouverte;
  dossier: Dossier;
  onEnregistrer: (nom: string, remplacer: boolean) => Promise<void>;
  onFermer: () => void;
}) {
  const [remplacerVoulu, setRemplacer] = useState(false);
  const [nom, setNom] = useState(() => nomLibre(ouverte.nom, dossier.fichiers));
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  // Choisir un autre dossier depuis la boîte retire « remplacer » : le
  // fichier d'origine n'y est pas.
  const peutRemplacer = ouverte.fichier !== null && ouverte.dossier === dossier.dossier;
  const remplacer = remplacerVoulu && peutRemplacer;
  const nomVide = !remplacer && nom.trim().replace(/\.xml$/i, "").trim() === "";

  async function soumettre(evenement?: FormEvent) {
    evenement?.preventDefault();
    if (!dossier.dossier || nomVide || enCours) return;
    setEnCours(true);
    setErreur(null);
    try {
      await onEnregistrer(remplacer && ouverte.fichier ? ouverte.fichier : nomDeFichier(nom), remplacer);
    } catch (cause) {
      setErreur(phrase(cause, "La disposition ne s'enregistre pas."));
      setEnCours(false);
    }
  }

  return (
    <Modale
      titre="ENREGISTRER"
      onFermer={onFermer}
      actions={
        <>
          <Button type="button" variant="quiet" onClick={onFermer}>
            ANNULER
          </Button>
          <Button type="button" disabled={!dossier.dossier || nomVide || enCours} onClick={() => void soumettre()}>
            {enCours ? "ENREGISTREMENT…" : "ENREGISTRER"}
          </Button>
        </>
      }
    >
      <ChampDossier dossier={dossier} />
      <form onSubmit={(e) => void soumettre(e)} className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-3 border-0">
          <legend className="sr-only">Où l'enregistrer</legend>
          <label
            className={`flex flex-col gap-3 border px-4 py-3 ${!remplacer ? "border-gold bg-surface-selected" : "border-hairline"}`}
          >
            <span className="flex items-center gap-3 body-compact text-ink">
              <input
                type="radio"
                name="mode"
                checked={!remplacer}
                onChange={() => setRemplacer(false)}
                className="size-5 accent-[var(--crimson)]"
              />
              Nouveau fichier
            </span>
            <span className="flex items-center gap-2 pl-8">
              <Input
                aria-label="Nom du fichier"
                value={nom}
                disabled={remplacer}
                onChange={(e) => setNom(e.target.value)}
                className="min-w-0 flex-1"
              />
              <span className="body-compact text-ink-muted">.xml</span>
            </span>
          </label>
          {peutRemplacer ? (
            <label
              className={`flex items-center gap-3 border px-4 py-3 body-compact text-ink ${
                remplacer ? "border-gold bg-surface-selected" : "border-hairline"
              }`}
            >
              <input
                type="radio"
                name="mode"
                checked={remplacer}
                onChange={() => setRemplacer(true)}
                className="size-5 accent-[var(--crimson)]"
              />
              {`Remplacer ${ouverte.fichier}`}
            </label>
          ) : null}
        </fieldset>
        {erreur ? (
          <p role="alert" className="caption text-crimson-ink">
            {erreur}
          </p>
        ) : null}
      </form>
    </Modale>
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
        texturesLues.delete(etat.chemin);
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
      <div className="flex min-w-xs flex-1 flex-col gap-2">
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

  // L'effet suit l'archive elle-même, pas son chemin : rouverte au même
  // endroit après une mise à jour, elle relit ses modèles.
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
    // `archive` change à chaque ouverture, `ouverte` n'en est que le chemin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cle, archive]);

  return ouverte ? modeles : VIDE;
}

const VIDE = new Map<number, Maillage[]>();

/** Les textures déjà demandées, par archive puis par fichier ; `null` pour une
 *  texture qui ne se lit pas, qu'on ne redemande pas. La lecture en cours y
 *  est déjà : un nouveau lot de modèles relance l'effet, et ne redemande pas
 *  ce que le précédent attend encore. */
const texturesLues = new Map<string, Map<number, DemandeTexture>>();

/** Une texture demandée : sa lecture, et ce qu'elle a rendu une fois finie. */
type DemandeTexture = { lecture: Promise<TextureLue | null>; lue?: TextureLue | null };

/** Les textures des modèles lus, au fil des lectures comme les modèles.
 *  Chaque fichier ne se demande qu'une fois : plusieurs sortes partagent la
 *  même écorce. */
function useTextures(
  modeles: Map<number, Maillage[]>,
  archive: EtatArchive | null,
): Map<number, TextureLue | null> {
  const [textures, setTextures] = useState<Map<number, TextureLue | null>>(new Map());
  const ouverte = archive?.chemin ?? null;
  const voulues = [
    ...new Set(
      [...modeles.values()].flatMap((maillages) =>
        maillages.flatMap((m) => (m.texture === null ? [] : [m.texture])),
      ),
    ),
  ].sort((a, b) => a - b);
  const cle = voulues.join(",");

  useEffect(() => {
    if (!cle || !ouverte) return;
    let parti = false;
    let lues = texturesLues.get(ouverte);
    if (!lues) {
      lues = new Map();
      texturesLues.set(ouverte, lues);
    }
    const memoire = lues;
    const fichiers = cle.split(",").map(Number);
    // Ce qui est déjà lu se montre tout de suite : attendre une lecture en
    // cours le rendrait à l'or le temps d'une image.
    const presentes = new Map<number, TextureLue | null>(
      fichiers.flatMap((f) => {
        const demande = memoire.get(f);
        return demande && demande.lue !== undefined ? [[f, demande.lue]] : [];
      }),
    );

    let enAttente = false;
    const publier = () => {
      if (enAttente) return;
      enAttente = true;
      requestAnimationFrame(() => {
        enAttente = false;
        if (!parti) setTextures(new Map(presentes));
      });
    };

    const lire = (fichier: number) => {
      let demande = memoire.get(fichier);
      if (!demande) {
        const nouvelle: DemandeTexture = {
          lecture: lireTexture(fichier)
            .catch((cause) => {
              console.error(`la texture ${fichier} ne se lit pas`, cause);
              return null;
            })
            .then((lue) => (nouvelle.lue = lue)),
        };
        demande = nouvelle;
        memoire.set(fichier, demande);
      }
      return demande.lecture;
    };

    const restantes = fichiers.filter((f) => !presentes.has(f));
    const suivante = async (): Promise<void> => {
      const fichier = restantes.shift();
      if (fichier === undefined || parti) return;
      presentes.set(fichier, await lire(fichier));
      publier();
      return suivante();
    };
    publier();
    for (let i = 0; i < LECTURES_SIMULTANEES; i++) void suivante();

    return () => {
      parti = true;
    };
    // `archive` change à chaque ouverture, `ouverte` n'en est que le chemin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cle, archive]);

  return ouverte ? textures : SANS_TEXTURES;
}

const SANS_TEXTURES = new Map<number, TextureLue | null>();
