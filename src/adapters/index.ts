import { twitterAdapter } from "./twitter";
import type { SourceAdapter } from "./types";

export const adapters: Record<string, SourceAdapter<any>> = {
  twitter: twitterAdapter,
};

export function getAdapter(name: string): SourceAdapter<any> {
  const a = adapters[name];
  if (!a) throw new Error(`No adapter registered for source "${name}"`);
  return a;
}
