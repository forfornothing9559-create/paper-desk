// Runs the Grok desk's own store file, grok/src/lib/desk-store.ts, unedited.
//
// That file is the part of the Grok app that takes each market read and hands
// it to the rules (its `ingest` function). The cloud runner has its own copy of
// those few lines. The tests use this file as the answer key: same reads in,
// and the two must hold exactly the same book afterwards.
//
// desk-store.ts needs three things the browser normally gives it:
//   - the "zustand" library (installed for tests only, in tests/deps)
//   - the "@/..." import shortcut (mapped here to grok/src/...)
//   - localStorage (a plain in-memory stand-in here)

import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPS = pathToFileURL(join(ROOT, "tests", "deps", "package.json")).href;
const KEY = "paper-desk-v1"; // the name desk-store.ts saves under

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(join(ROOT, "grok", "src", `${specifier.slice(2)}.ts`)).href, context);
    }
    if (specifier === "zustand" || specifier.startsWith("zustand/")) {
      return nextResolve(specifier, { ...context, parentURL: DEPS });
    }
    return nextResolve(specifier, context);
  },
});

const memory = new Map();
const storage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value));
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};
// The library looks for the browser's storage as `localStorage` or as
// `window.localStorage`, depending on its version. Give it both.
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { localStorage: storage } });
}

let serial = 0;

/**
 * A fresh Grok desk holding `saved` (the same fields the Grok app keeps in the
 * browser). Only one may be in use at a time: they share the storage name.
 */
export async function newGrokDesk(saved) {
  serial += 1;
  memory.clear();
  memory.set(KEY, JSON.stringify({ state: saved, version: 0 }));
  const url = `${pathToFileURL(join(ROOT, "grok", "src", "lib", "desk-store.ts")).href}?desk=${serial}`;
  const mod = await import(url);
  if (!mod.useDesk?.persist) {
    throw new Error(
      `The Grok store did not find its storage. useDesk has: ${Object.keys(mod.useDesk ?? {}).join(", ")}. ` +
        `typeof window ${typeof globalThis.window}, typeof localStorage ${typeof globalThis.localStorage}.`,
    );
  }
  await mod.useDesk.persist.rehydrate();
  return {
    ingest(quotes, at, error) {
      mod.useDesk.getState().ingest(quotes, at, error);
    },
    /** What the Grok app would have saved in the browser right now. */
    state() {
      return JSON.parse(memory.get(KEY)).state;
    },
  };
}

export async function zustandVersion() {
  try {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(join(ROOT, "tests", "deps", "node_modules", "zustand", "package.json"), "utf8")).version;
  } catch {
    return "not installed";
  }
}
