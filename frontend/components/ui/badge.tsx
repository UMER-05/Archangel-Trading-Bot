import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@lib/utils";

// Previously referenced shadcn-convention tokens (bg-destructive, text-primary-foreground,
// focus:ring-ring, etc.) that were never defined in tailwind.config.ts — Tailwind
// silently drops unknown utility classes, so "destructive"/"default"/"secondary"/
// "outline" rendered with no background at all (ValidationStatus.tsx's
// variant="destructive" badge was invisible against the card). Mapped onto
// this app's real design tokens instead.
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-base-200",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-white hover:bg-primary-hover",
        secondary:
          "border-transparent bg-base-300 text-base-content hover:bg-base-300/80",
        destructive: "border-transparent bg-danger text-[#1a0d10] hover:bg-danger/85",
        outline: "border-base-300 text-base-content",
        success: "border-transparent bg-success text-[#04140d] hover:bg-success/85",
        warning: "border-transparent bg-warning text-[#1a1206] hover:bg-warning/85",
        error: "border-transparent bg-danger text-[#1a0d10] hover:bg-danger/85",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
