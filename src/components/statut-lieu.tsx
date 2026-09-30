import { statutAffiche, type Activite } from "@/lib/activite";
import { cn } from "@/lib/utils";

/**
 * Le statut d'un lieu tel que son équipe le déclare : la puce, puis le message
 * entre guillemets — une parole rapportée, donc en italique. `ACTIF` est en
 * carmin comme « EN COURS » sur une scène. Un lieu qui n'a rien déclaré
 * n'affiche rien, ni un lieu inactif sans message (`statutAffiche`).
 *
 * Des `<span>` seulement : la ligne d'un lieu est un `<button>`.
 */
export function StatutLieu({
  activite,
  className,
}: {
  /** Déjà jugé à l'heure qu'il est (`activiteA`). */
  activite: Activite | null;
  className?: string;
}) {
  activite = statutAffiche(activite);
  if (!activite) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      <span
        className={cn(
          "chip-label border px-2 py-1",
          activite.active
            ? "border-crimson-edge bg-crimson text-on-crimson"
            : "border-chip-edge bg-neutral-badge text-ink-muted",
        )}
      >
        {activite.active ? "ACTIF" : "INACTIF"}
      </span>
      {activite.message ? (
        <span className="caption italic text-ink-body">« {activite.message} »</span>
      ) : null}
    </span>
  );
}
