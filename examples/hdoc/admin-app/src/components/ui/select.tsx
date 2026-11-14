import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A native select rather than a listbox widget: the slot pickers hold long
 * `fontId · family (revision…)` lists where type-ahead and no focus management
 * matter more than custom rendering.
 */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-8 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent",
        "bg-no-repeat py-1 pr-7 pl-2.5 text-sm shadow-xs transition-colors",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "bg-[image:var(--select-chevron)] bg-[length:12px] bg-[position:right_0.5rem_center]",
        className,
      )}
      style={
        {
          "--select-chevron":
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23808080' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Select };
