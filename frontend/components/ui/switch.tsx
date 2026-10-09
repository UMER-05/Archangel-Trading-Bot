"use client";

import * as React from "react";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const Switch: React.FC<SwitchProps> = ({ checked, onCheckedChange }) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={`w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-base-200 ${
        checked ? "bg-primary" : "bg-white/15"
      } relative`}
    >
      <span
        className={`block w-5 h-5 bg-white rounded-full shadow-md absolute top-0.5 transition-transform duration-200 ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      ></span>
    </button>
  );
};
