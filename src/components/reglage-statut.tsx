import { useState, type FormEvent } from "react";

import { CheckIcon, CloseIcon, PencilIcon } from "@/components/icons";
import { MESSAGE_ACTIVITE_MAX, type Activite } from "@/lib/activite";
import { formatHeure } from "@/lib/dates";
import { ErreurHub, ecrireActivite } from "@/lib/nexus";
import type { LieuGere } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Le statut d'un lieu qu'on tient, réglé depuis « À proximité » : un
 * interrupteur qui agit tout de suite et n'envoie pas de message — celui
 * d'avant reste —, et un crayon qui ouvre le message sur place.
 *
 * Il ne s'affiche que cadenas ouvert : fermé, la fenêtre laisse passer les
 * clics au jeu, et un interrupteur qui ne reçoit pas le sien n'a rien à faire
 * à l'écran.
 */
export function ReglageStatut({
  lieu,
  activite,
  onEcrit,
}: {
  lieu: LieuGere;
  /** Déjà jugé à l'heure qu'il est (`activiteA`). */
  activite: Activite | null;
  onEcrit: (id: string, activite: Activite) => void;
}) {
  const actif = activite?.active ?? false;
  const [edition, setEdition] = useState(false);
  const [brouillon, setBrouillon] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);

  async function envoyer(demande: { active: boolean; message?: string }): Promise<boolean> {
    setEnvoi(true);
    setEchec(null);
    try {
      onEcrit(lieu.id, await ecrireActivite(lieu.slug, demande));
      return true;
    } catch (erreur) {
      setEchec(erreur instanceof ErreurHub ? erreur.message : "Le statut n'a pas été enregistré.");
      return false;
    } finally {
      setEnvoi(false);
    }
  }

  function ouvrir() {
    setBrouillon(activite?.message ?? "");
    setEchec(null);
    setEdition(true);
  }

  async function enregistrer(evenement: FormEvent) {
    evenement.preventDefault();
    if (await envoyer({ active: actif, message: brouillon.trim() })) setEdition(false);
  }

  return (
    <div className="flex flex-col pb-1 pl-7.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          role="switch"
          aria-checked={actif}
          aria-label={`${lieu.name} actif`}
          disabled={envoi}
          onClick={() => void envoyer({ active: !actif })}
          className="flex size-tap shrink-0 items-center disabled:opacity-60"
        >
          <span
            className={cn(
              "flex h-5 w-9.5 border p-0.75",
              actif
                ? "justify-end border-crimson-edge bg-crimson"
                : "justify-start border-rule bg-surface-inset",
            )}
          >
            <span className={cn("size-3", actif ? "bg-on-crimson" : "bg-ink-subtle")} />
          </span>
        </button>
        <span className="flex-1 caption text-ink-muted">
          {actif && activite?.until ? `inactif à ${formatHeure(activite.until)}` : null}
        </span>
        {edition ? null : (
          <button
            type="button"
            onClick={ouvrir}
            aria-label={`Modifier le message de ${lieu.name}`}
            className="flex size-tap shrink-0 items-center justify-center text-ink-muted hover:text-ink"
          >
            <PencilIcon size={16} />
          </button>
        )}
      </div>

      {edition ? (
        <form onSubmit={(evenement) => void enregistrer(evenement)} className="flex flex-col gap-1 pb-2">
          <div className="flex items-center">
            <label htmlFor={`message-${lieu.id}`} className="sr-only">
              Message du statut de {lieu.name}
            </label>
            <input
              id={`message-${lieu.id}`}
              type="text"
              value={brouillon}
              onChange={(evenement) => setBrouillon(evenement.target.value)}
              onKeyDown={(evenement) => {
                if (evenement.key === "Escape") setEdition(false);
              }}
              maxLength={MESSAGE_ACTIVITE_MAX}
              placeholder="Soirée dansante jusqu'à 21h"
              autoComplete="off"
              autoFocus
              className="min-h-tap min-w-0 flex-1 border border-gold bg-surface-inset px-2.5 body-compact text-ink outline-none placeholder:text-ink-subtle"
            />
            <button
              type="submit"
              disabled={envoi}
              aria-label="Enregistrer le message"
              className="flex size-tap shrink-0 items-center justify-center text-gold-ink disabled:opacity-60"
            >
              <CheckIcon size={16} />
            </button>
            <button
              type="button"
              onClick={() => setEdition(false)}
              aria-label="Annuler"
              className="flex size-tap shrink-0 items-center justify-center text-ink-muted hover:text-ink"
            >
              <CloseIcon size={14} />
            </button>
          </div>
          <span className="caption text-ink-muted">
            {brouillon.length}/{MESSAGE_ACTIVITE_MAX}
          </span>
        </form>
      ) : null}

      {echec ? (
        <p role="alert" className="pb-2 caption text-crimson-ink">
          {echec}
        </p>
      ) : null}
    </div>
  );
}
