"use client";

// App-wide confirmation modal replacing the browser's window.confirm(). Promise-based so call sites
// stay one line: `if (!(await confirm({ title, body, confirmLabel, tone }))) return;`. Mount
// <ConfirmProvider> once (in the app layout); components call useConfirm() to get the confirm fn.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ConfirmOpts = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default"; // danger = red confirm button (deletes/removes)
};

const Ctx = createContext<((o: ConfirmOpts) => Promise<boolean>) | null>(null);

// Falls back to window.confirm if used outside a provider, so it can never silently no-op.
export function useConfirm(): (o: ConfirmOpts) => Promise<boolean> {
  const ctx = useContext(Ctx);
  return (
    ctx ??
    (async (o: ConfirmOpts) => (typeof window !== "undefined" ? window.confirm(o.body ?? o.title) : true))
  );
}

export default function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ opts, resolve })),
    []
  );

  const close = (v: boolean) => {
    setState((s) => {
      s?.resolve(v);
      return null;
    });
  };

  // Escape cancels; lock body scroll while open
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(false); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [state]);

  const danger = state?.opts.tone === "danger";

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {state && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
          <div onClick={() => close(false)} className="absolute inset-0 bg-ink/60" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={state.opts.title}
            className="relative w-full max-w-sm rounded-t-2xl bg-chalk p-5 text-ink shadow-2xl sm:rounded-2xl"
          >
            <h3 className="font-disp text-lg font-extrabold text-ink">{state.opts.title}</h3>
            {state.opts.body && (
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-mute">{state.opts.body}</p>
            )}
            <div className="mt-5 flex gap-2.5">
              <button
                onClick={() => close(false)}
                className="flex-1 rounded-xl border border-ink/20 py-2.5 font-bold text-ink transition-colors hover:border-ink/40"
              >
                {state.opts.cancelLabel ?? "Cancel"}
              </button>
              <button
                onClick={() => close(true)}
                autoFocus
                className={`flex-1 rounded-xl py-2.5 font-bold transition ${
                  danger ? "bg-brick text-white hover:brightness-110" : "bg-flood text-ink hover:brightness-105"
                }`}
              >
                {state.opts.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
