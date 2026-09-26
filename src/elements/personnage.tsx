import { EtatSansPosition } from "@/components/etat-element";
import { UserIcon } from "@/components/icons";
import { PROFESSION_LABELS, RACE_MUMBLE_LABELS } from "@/lib/domaine";
import type { Position } from "@/lib/position";

/**
 * Le personnage joué, tel que le lien Mumble le décrit : son nom, sa race et
 * sa profession, la carte où il se tient, et sa position dans le repère du
 * hub — le point que la carte du hub désigne au même endroit.
 */
export function Personnage({ position }: { position: Position }) {
  if (position.etat !== "pret") return <EtatSansPosition position={position} />;

  const identite = position.lien.identite;
  const race = identite ? RACE_MUMBLE_LABELS[identite.race] : undefined;
  const profession = identite ? PROFESSION_LABELS[identite.profession] : undefined;

  // Trois lignes, à la largeur d'un élément : le nom seul, puis qui il est et
  // où il est, puis le point du hub. Sur une seule ligne, race et profession
  // se tronquaient dès que le nom faisait deux mots.
  return (
    <div className="flex h-full flex-col gap-1 px-4 py-3">
      <p className="eyebrow text-gold-eyebrow">PERSONNAGE</p>
      <p className="flex items-center gap-2 body-compact text-ink">
        <UserIcon size={18} className="text-gold-ink" />
        {identite?.name ? (
          <span className="truncate">{identite.name}</span>
        ) : (
          <span className="text-ink-muted">Nom non transmis</span>
        )}
      </p>
      <p className="truncate caption text-ink-muted">
        {[race, profession].filter(Boolean).join(" ")}
        {race || profession ? " · " : ""}
        {position.carte.name}
        {position.carte.region_name ? ` · ${position.carte.region_name}` : ""}
        {position.lien.etat.en_combat ? " · en combat" : ""}
      </p>
      <p className="caption tabular-nums text-ink-muted">
        x {position.point.x.toLocaleString("fr-FR")} · y {position.point.y.toLocaleString("fr-FR")}
      </p>
    </div>
  );
}
