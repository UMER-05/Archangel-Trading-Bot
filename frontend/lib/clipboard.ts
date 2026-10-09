// frontend/lib/clipboard.ts
//
// Copy text to the clipboard, reporting whether it actually worked.
//
// navigator.clipboard only exists on secure origins (https or localhost). On a
// dashboard served over plain http it is undefined, so `navigator.clipboard
// .writeText(...)` threw — the Copy buttons on the deposit address and token
// address did nothing, silently. This falls back to the old select-and-copy
// route, and lets the caller say "couldn't copy" when even that is blocked.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof window !== "undefined" &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied etc. — try the fallback below
  }

  try {
    if (typeof document === "undefined") return false;
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
