// @effect-diagnostics nodeBuiltinImport:off
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const tails = new Map<string, Promise<void>>();

function workspaceKey(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export const hasWorkspaceAdmission = (path: string) => tails.has(workspaceKey(path));

export async function withWorkspaceAdmission<A>(path: string, body: () => Promise<A>) {
  const key = workspaceKey(path);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await body();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

const directWriters = new Map<AbortController, string>();

export function registerDirectWorkspaceWriter(controller: AbortController, path: string) {
  directWriters.set(controller, workspaceKey(path));
}

export function unregisterDirectWorkspaceWriter(controller: AbortController) {
  directWriters.delete(controller);
}

export const hasDirectWorkspaceWriter = (path: string) =>
  [...directWriters.values()].includes(workspaceKey(path));
