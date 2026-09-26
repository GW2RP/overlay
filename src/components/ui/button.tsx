import * as React from "react";

import { cn } from "@/lib/utils";

/** Le bouton du système : angles vifs, libellé en capitales Cinzel — écrites
 *  dans le contenu, jamais par `text-transform`. Une seule variante `default`
 *  (carmin) par écran. */

const VARIANTES = {
  default: "bg-crimson border-crimson-edge text-on-crimson hover:bg-crimson-edge",
  outline: "bg-transparent border-gold text-gold-ink hover:bg-surface-selected",
  quiet: "border-rule bg-transparent text-ink-muted hover:bg-surface-selected",
  ghost: "border-transparent bg-transparent text-ink-body hover:bg-surface-selected",
  link: "border-transparent bg-transparent text-crimson-ink underline underline-offset-4 tracking-normal font-body font-normal hover:text-crimson-edge",
} as const;

const TAILLES = {
  default: "min-h-tap px-5 py-4 button-label",
  lead: "min-h-tap px-[26px] py-[17px] button-label",
  sm: "min-h-tap px-4 py-3 button-label",
  icon: "size-tap p-0 button-label",
  inline: "min-h-0 p-0 meta",
} as const;

export type ButtonProps = React.ComponentProps<"button"> & {
  variant?: keyof typeof VARIANTES;
  size?: keyof typeof TAILLES;
};

export function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-none border transition-none disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none",
        VARIANTES[variant],
        TAILLES[size],
        className,
      )}
      {...props}
    />
  );
}
