import * as React from "react";

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <table className="min-w-full divide-y divide-base-300 bg-base-200 text-base-content rounded-xl overflow-hidden">
      {children}
    </table>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <svg
        className="animate-spin h-6 w-6 text-blue-600"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v8z"
        />
      </svg>
    </div>
  );
}
