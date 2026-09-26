import * as React from "react";

import { cn } from "@/lib/utils";

/** Champs à angles vifs sur `surface-inset`, bordés de 1 px `rule`. Chaque
 *  contrôle a une étiquette visible. */

const controlClasses =
  "w-full min-h-tap rounded-none border border-rule bg-surface-inset px-[14px] py-3 body-compact text-ink placeholder:text-ink-subtle";

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("meta text-ink-muted", className)} {...props} />;
}

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(controlClasses, className)} {...props} />;
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="select" className={cn(controlClasses, className)} {...props} />;
}

/** Le curseur natif, à la couleur d'action : on ne redessine pas la glissière. */
export function Slider({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="range"
      data-slot="slider"
      className={cn("w-full accent-[var(--crimson)]", className)}
      {...props}
    />
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
        {required ? <span className="sr-only"> (obligatoire)</span> : null}
      </Label>
      {children}
      {hint ? <p className="caption text-ink-subtle">{hint}</p> : null}
      {error ? (
        <p role="alert" className="caption text-crimson-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
