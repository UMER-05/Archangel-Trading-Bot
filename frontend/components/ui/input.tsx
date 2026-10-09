import * as React from "react";
import { cn } from "@lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-base-content placeholder:text-base-content/35 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";
