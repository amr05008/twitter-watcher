export interface TwitterWatcherClientConfig {
  baseUrl: string;
  triggerToken: string;
  fetchImpl?: typeof fetch;
  /** Retries for side-effect-free operations only. Defaults to 2. */
  readRetries?: number;
  retryBaseDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export class TwitterWatcherHttpError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TwitterWatcherHttpError";
  }
}

export class TwitterWatcherNetworkError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TwitterWatcherNetworkError";
  }
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

export interface ExploreTweet {
  id: string;
  author: string;
  authorName: string | null;
  authorFollowers: number | null;
  text: string;
  url: string;
  createdAt: string;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
  isReply: boolean;
  isRetweet: boolean;
}

export interface ExploreAccount {
  userName: string;
  name: string | null;
  followers: number | null;
  following: number | null;
  description: string | null;
  location: string | null;
  statusesCount: number | null;
}

export interface SearchTweetsResult {
  query: string;
  queryType: "Latest" | "Top";
  fetched: number;
  hasMore: boolean;
  tweets: ExploreTweet[];
}

export interface AccountTweetsResult {
  handle: string;
  fetched: number;
  hasMore: boolean;
  tweets: ExploreTweet[];
}

export interface AccountFollowingResult {
  handle: string;
  fetched: number;
  hasMore: boolean;
  accounts: ExploreAccount[];
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

export interface RefreshResult {
  handlesQueried: number;
  ingested: number;
  failedHandles: number;
  skippedMalformed: number;
}

export class TwitterWatcherClient {
  private baseUrl: string;
  private triggerToken: string;
  private fetchImpl: typeof fetch;
  private readRetries: number;
  private retryBaseDelayMs: number;
  private sleepImpl: (ms: number) => Promise<void>;

  constructor(config: TwitterWatcherClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.triggerToken = config.triggerToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.readRetries = Math.max(0, config.readRetries ?? 2);
    this.retryBaseDelayMs = Math.max(0, config.retryBaseDelayMs ?? 250);
    this.sleepImpl = config.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { retrySafe?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "X-Trigger-Token": this.triggerToken,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const attempts = options.retrySafe ? this.readRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (attempt + 1 < attempts) {
          await this.sleepImpl(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        throw new TwitterWatcherNetworkError(
          method,
          path,
          `Twitter Watcher ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }

      if (res.ok) return (await res.json()) as T;

      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retryable && attempt + 1 < attempts) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
        const delay = Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : this.retryBaseDelayMs * 2 ** attempt;
        await this.sleepImpl(delay);
        continue;
      }

      const text = await res.text().catch(() => "<unreadable>");
      throw new TwitterWatcherHttpError(
        method,
        path,
        res.status,
        `Twitter Watcher ${method} ${path} → ${res.status}: ${text.slice(0, 1000)}`,
      );
    }

    throw new TwitterWatcherNetworkError(method, path, `Twitter Watcher ${method} ${path} failed`);
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
    return this.request<DiscoverResult>("POST", "/api/discover", input, { retrySafe: true });
  }

  async searchTweets(input: {
    query: string;
    queryType?: "Latest" | "Top";
    maxTweets?: number;
  }): Promise<SearchTweetsResult> {
    return this.request<SearchTweetsResult>("POST", "/api/search-tweets", input, { retrySafe: true });
  }

  async getAccountTweets(input: {
    handle: string;
    maxTweets?: number;
  }): Promise<AccountTweetsResult> {
    return this.request<AccountTweetsResult>("POST", "/api/account-tweets", input, { retrySafe: true });
  }

  async getAccountFollowing(input: {
    handle: string;
    maxAccounts?: number;
  }): Promise<AccountFollowingResult> {
    return this.request<AccountFollowingResult>("POST", "/api/account-following", input, { retrySafe: true });
  }

  async listWatchedAccounts(): Promise<{ targets: WatchTarget[] }> {
    return this.request<{ targets: WatchTarget[] }>("GET", "/api/watch-targets", undefined, { retrySafe: true });
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
}
