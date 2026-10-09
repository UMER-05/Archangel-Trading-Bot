import * as React from "react";
import { cn } from "@lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "outline";
  size?: "sm" | "md" | "lg";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const base =
      "inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-base-200 active:scale-[0.98] disabled:active:scale-100";

    const variants = {
      primary:
        "bg-primary hover:bg-primary-hover text-white shadow-[0_1px_0_rgba(255,255,255,0.15)_inset] disabled:bg-primary/35 disabled:cursor-not-allowed",
      secondary:
        "bg-base-300 hover:bg-base-300/70 text-base-content border border-white/5 disabled:opacity-40 disabled:cursor-not-allowed",
      danger:
        "bg-danger hover:bg-danger/85 text-[#1a0d10] disabled:bg-danger/35 disabled:cursor-not-allowed",
      ghost:
        "bg-transparent hover:bg-white/5 text-base-content border border-transparent disabled:opacity-40 disabled:cursor-not-allowed",
      outline:
        "bg-transparent hover:bg-white/5 text-base-content border border-base-300 disabled:opacity-40 disabled:cursor-not-allowed",
    }[variant];

    const sizes = {
      sm: "px-3 py-1.5 text-sm gap-1.5",
      md: "px-4 py-2.5 text-sm gap-2",
      lg: "px-6 py-3 text-base gap-2.5",
    }[size];

    return (
      <button
        ref={ref}
        className={cn(base, variants, sizes, className)}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
