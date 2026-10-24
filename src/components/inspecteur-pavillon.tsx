import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import {
  arrondirEchelle,
  normaliserAngle,
  type Decoration,
  type FicheDecoration,
} from "@/lib/pavillon";

/**
 * Ce qu'on sait de la sélection, et ce qu'on peut en faire. Une décoration
 * seule se corrige au chiffre près ; plusieurs se dupliquent ou se retirent
 * ensemble, et se transforment aux poignées.
 */
export function InspecteurPavillon({
  choisies,
  fiches,
  rangs,
  onModifier,
  onDupliquer,
  onRetirer,
}: {
  choisies: Decoration[];
  fiches: Map<number, FicheDecoration>;
  /** Le rang de chaque décoration dans le fichier, à partir de 1. */
  rangs: Map<number, number>;
  onModifier: (modifiee: Decoration) => void;
  onDupliquer: () => void;
  onRetirer: () => void;
}) {
  if (choisies.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="panel-title text-ink-muted">AUCUNE DÉCORATION CHOISIE</p>
      </div>
    );
  }

  const seule = choisies.length === 1 ? choisies[0] : null;
  const actions = (
    <div className="flex gap-3 border-t border-hairline px-5 py-4">
      <Button type="button" variant="outline" size="sm" className="flex-1" onClick={onDupliquer}>
        DUPLIQUER
      </Button>
      <Button type="button" variant="quiet" size="sm" className="flex-1" onClick={onRetirer}>
        RETIRER
      </Button>
    </div>
  );

  if (!seule) {
    return (
      <div className="flex flex-col">
        <h2 className="panel-title border-b border-hairline px-5 py-3 text-ink">
          {`${choisies.length} DÉCORATIONS`}
        </h2>
        {actions}
      </div>
    );
  }

  const fiche = fiches.get(seule.id);
  const [x, y, z] = seule.position;
  const [rx, ry, rz] = seule.rotation;
  const position = (axe: 0 | 1 | 2) => (valeur: number) => {
    const suivante = [...seule.position] as Decoration["position"];
    suivante[axe] = valeur;
    onModifier({ ...seule, position: suivante });
  };
  const rotation = (axe: 0 | 1 | 2) => (degres: number) => {
    const suivante = [...seule.rotation] as Decoration["rotation"];
    suivante[axe] = normaliserAngle((degres * Math.PI) / 180);
    onModifier({ ...seule, rotation: suivante });
  };

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      <div className="flex items-start gap-3 border-b border-hairline px-5 py-4">
        {fiche?.icon ? (
          <img src={fiche.icon} alt="" width={40} height={40} className="size-10 shrink-0" />
        ) : (
          <span aria-hidden="true" className="size-10 shrink-0 border border-rule bg-surface-inset" />
        )}
        <div className="min-w-0">
          <p className="body-compact text-ink">{fiche?.name ?? seule.nom}</p>
          <p className="caption text-ink-muted">
            Décoration {seule.id} · n° {rangs.get(seule.cle)}
          </p>
        </div>
      </div>

      {/* La clé de chaque groupe suit la décoration : un autre choix repart
          des valeurs de l'autre, pas d'une saisie laissée en cours. */}
      <fieldset key={seule.cle} className="flex flex-col gap-5 border-0 px-5 py-4">
        <Groupe titre="POSITION (POUCES)">
          <ChampNombre etiquette="x" valeur={x} decimales={2} onValider={position(0)} />
          <ChampNombre etiquette="y" valeur={y} decimales={2} onValider={position(1)} />
          <ChampNombre etiquette="z" valeur={z} decimales={2} onValider={position(2)} />
        </Groupe>
        <Groupe titre="ROTATION (DEGRÉS)">
          <ChampNombre etiquette="x" valeur={degres(rx)} decimales={1} onValider={rotation(0)} />
          <ChampNombre etiquette="y" valeur={degres(ry)} decimales={1} onValider={rotation(1)} />
          <ChampNombre etiquette="z" valeur={degres(rz)} decimales={1} onValider={rotation(2)} />
        </Groupe>
        <Groupe titre="ÉCHELLE">
          <ChampNombre
            etiquette="échelle"
            valeur={seule.echelle}
            decimales={3}
            onValider={(valeur) => {
              if (valeur > 0) onModifier({ ...seule, echelle: arrondirEchelle(valeur) });
            }}
          />
        </Groupe>
      </fieldset>
      {actions}
    </div>
  );
}

function degres(radians: number): number {
  return (radians * 180) / Math.PI;
}

function Groupe({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="eyebrow text-gold-eyebrow">{titre}</p>
      <div className="grid grid-cols-3 gap-2">{children}</div>
    </div>
  );
}

const FORMAT = (decimales: number) =>
  new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
    useGrouping: false,
  });

/** Un nombre à la française, qui ne s'applique qu'à `Entrée` ou en quittant
 *  le champ : une frappe n'est pas un geste. Une saisie illisible revient à
 *  la valeur d'avant. */
function ChampNombre({
  etiquette,
  valeur,
  decimales,
  onValider,
}: {
  etiquette: string;
  valeur: number;
  decimales: number;
  onValider: (valeur: number) => void;
}) {
  const affichee = FORMAT(decimales).format(valeur);
  const [saisie, setSaisie] = useState<string | null>(null);
  const id = `champ-${etiquette}-${decimales}`;

  function valider() {
    if (saisie === null) return;
    setSaisie(null);
    const nombre = Number(saisie.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".").replace("\u2212", "-"));
    if (saisie.trim() !== affichee && Number.isFinite(nombre)) onValider(nombre);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="caption">
        {etiquette}
      </Label>
      <input
        id={id}
        inputMode="decimal"
        value={saisie ?? affichee}
        onChange={(e) => setSaisie(e.target.value)}
        onBlur={valider}
        onKeyDown={(e) => {
          if (e.key === "Enter") valider();
          if (e.key === "Escape") {
            e.stopPropagation();
            setSaisie(null);
          }
        }}
        className="min-h-tap w-full min-w-0 rounded-none border border-rule bg-surface-inset px-2 py-2 body-compact text-ink tabular-nums"
      />
    </div>
  );
}
