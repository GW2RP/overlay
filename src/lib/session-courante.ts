import { useEffect, useState } from "react";

import { CLES, lireJeton, surChangement } from "@/lib/reglages";

/** Un numéro qui change à chaque changement de jeton, `null` sans jeton : de
 *  quoi relancer la lecture sans faire entrer le jeton dans sa clé. */
export function useSessionCourante(): number | null {
  const [session, setSession] = useState<{ jeton: boolean; version: number }>({
    jeton: false,
    version: 0,
  });

  useEffect(() => {
    let parti = false;
    let arreter: (() => void) | null = null;
    const suivre = (jeton: string | null | undefined) =>
      setSession((avant) => ({ jeton: Boolean(jeton), version: avant.version + 1 }));
    void lireJeton().then((jeton) => {
      if (!parti) suivre(jeton);
    });
    void surChangement<string | null>(CLES.jeton, suivre).then((stop) => {
      if (parti) stop();
      else arreter = stop;
    });
    return () => {
      parti = true;
      arreter?.();
    };
  }, []);

  return session.jeton ? session.version : null;
}
