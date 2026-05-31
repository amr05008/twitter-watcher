export interface TwitterWatcherClientConfig {
  baseUrl: string;
  triggerToken: string;
  fetchImpl?: typeof fetch;
}

export interface BriefingResult {
  briefingId: string;
  postCount?: number;
  /** Set when the run found nothing worth surfacing and posted nothing. */
  skipped?: true;
  /** Set on a quiet Monday cron that posted a liveness ping (cron-only). */
  healthPing?: true;
}

export interface DiscoverResult {
  topic: string;
  generatedAt: string;
  runId: string;
  accounts: Array<{
    handle: string;
    rationale: string;
    signalScore: number;
    postCount: number;
    samples: string[];
  }>;
}

export interface WatchTarget {
  id: string;
  source: string;
  kind: string;
  handle: string;
  weight: number;
  addedAt: string;
}

export interface PromoteResult {
  id: string;
  alreadyExisted: boolean;
}

export interface DeleteResult {
  id: string;
  removed: boolean;
}

export interface IngestResult {
  ingested: number;
  skippedNoTarget: number;
  skippedMalformed: number;
  datasetId: string;
}

export interface RefreshResult {
  handlesQueried: number;
  ingested: number;
  skippedNoTarget: number;
  skippedMalformed: number;
}

export class TwitterWatcherClient {
  private baseUrl: string;
  private triggerToken: string;
  private fetchImpl: typeof fetch;

  constructor(config: TwitterWatcherClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.triggerToken = config.triggerToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "X-Trigger-Token": this.triggerToken,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable>");
      throw new Error(`Twitter Watcher ${method} ${path} → ${res.status}: ${text}`);
    }

    return (await res.json()) as T;
  }

  async runBriefing(): Promise<BriefingResult> {
    return this.request<BriefingResult>("POST", "/trigger");
  }

  async refreshTweets(): Promise<RefreshResult> {
    return this.request<RefreshResult>("POST", "/api/refresh");
  }

  async discoverAccounts(input: {
    topic: string;
    lookbackDays?: number;
    maxResults?: number;
  }): Promise<DiscoverResult> {
    return this.request<DiscoverResult>("POST", "/api/discover", input);
  }

  async listWatchedAccounts(): Promise<{ targets: WatchTarget[] }> {
    return this.request<{ targets: WatchTarget[] }>("GET", "/api/watch-targets");
  }

  async addWatchedAccount(input: {
    handle: string;
    source?: string;
  }): Promise<PromoteResult> {
    return this.request<PromoteResult>("POST", "/api/promote", {
      handle: input.handle,
      source: input.source ?? "twitter",
    });
  }

  async removeWatchedAccount(input: {
    handle: string;
    source?: string;
  }): Promise<DeleteResult> {
    return this.request<DeleteResult>("DELETE", "/api/watch-targets", {
      handle: input.handle,
      source: input.source ?? "twitter",
    });
  }

  async ingestApifyDataset(input: {
    datasetId: string;
    webhookSecret: string;
  }): Promise<IngestResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const res = await this.fetchImpl(
      `${this.baseUrl}/webhook/apify/${input.webhookSecret}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          resource: { defaultDatasetId: input.datasetId },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable>");
      throw new Error(`Twitter Watcher webhook → ${res.status}: ${text}`);
    }
    return (await res.json()) as IngestResult;
  }
}
