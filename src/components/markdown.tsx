import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { estImageDuMagasin } from "@/lib/images";
import { ouvrirDehors } from "@/lib/liens";

/**
 * Un texte long du hub, tel que ses fiches l'écrivent : du markdown.
 *
 * Deux règles, les mêmes que sur le site. Une image ne s'affiche que si elle
 * vient du magasin : une adresse quelconque ferait du texte d'un membre une
 * requête vers le serveur d'un autre. Et un lien s'ouvre dans le navigateur de
 * la personne, jamais dans la vue web : un élément qui naviguerait n'en
 * reviendrait pas.
 */
export function Markdown({ texte }: { texte: string }) {
  return (
    <div className="flex flex-col gap-3 body-compact text-ink-body [&_a]:text-crimson-ink [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-l-2 [&_blockquote]:border-rule [&_blockquote]:pl-3 [&_blockquote]:italic [&_h1]:card-title [&_h1]:text-ink [&_h2]:panel-title [&_h2]:text-ink [&_h3]:body-compact [&_h3]:font-semibold [&_h3]:text-ink [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(evenement) => {
                evenement.preventDefault();
                if (href) void ouvrirDehors(href);
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            estImageDuMagasin(src) ? (
              <img src={src} alt={alt ?? ""} className="max-w-full border-2 border-rule" />
            ) : null,
        }}
      >
        {texte}
      </ReactMarkdown>
    </div>
  );
}
