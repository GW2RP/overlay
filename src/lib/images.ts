/** Le magasin d'images du hub. À la lecture, une image ne s'affiche que si
 *  elle en vient : une adresse quelconque collée dans un champ ferait du texte
 *  d'un membre une requête vers le serveur d'un autre. La même règle que le
 *  hub (`isBlobUrl`), et la même liste dans la CSP de `tauri.conf.json`. */
const SUFFIXE_MAGASIN = ".public.blob.vercel-storage.com";

export function estImageDuMagasin(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    return new URL(url).hostname.endsWith(SUFFIXE_MAGASIN);
  } catch {
    return false;
  }
}
