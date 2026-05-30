import type { Env } from "../env";

export interface WatchTarget {
  id: string;
  source: string;
  kind: "handle" | "search";
  handle: string;
  weight: number;
  addedAt: string;
}

export interface NormalizedPost {
  source: string;
  sourceId: string;
  author: string;
  timestamp: string;
  text: string;
  url: string;
  raw: unknown;
}

export interface SourceAdapter<TRaw = unknown> {
  name: string;
  normalize(raw: TRaw, target: WatchTarget): NormalizedPost;
  webhookHandler?(req: Request, env: Env): Promise<Response>;
}
