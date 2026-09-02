#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  TwitterWatcherClient,
  TwitterWatcherHttpError,
  TwitterWatcherNetworkError,
  type TwitterWatcherClientConfig,
} from "./client.js";

export const EXIT_USAGE = 2;
export const EXIT_CONFIRMATION_REQUIRED = 3;
export const EXIT_HTTP = 4;
export const EXIT_NETWORK = 5;

const HELP = `twitter-watcher — portable CLI for a deployed Twitter Watcher

Usage:
  twitter-watcher <command> [options]

Read-only commands:
  search-tweets      --query <query> [--type Top|Latest] [--max 1..1000]
  account-tweets     --handle <handle> [--max 1..1000]
  account-following  --handle <handle> [--max 1..1000]
  discover           --topic <topic> [--lookback-days 1..30]
  watch-list

Commands with side effects (require exactly one of --dry-run or --yes):
  refresh            --dry-run|--yes
  briefing           --dry-run|--yes
  watch-add          --handle <handle> --dry-run|--yes
  watch-remove       --handle <handle> --dry-run|--yes

Environment:
  TWITTER_WATCHER_BASE_URL       Deployed Worker base URL
  TWITTER_WATCHER_TRIGGER_TOKEN  X-Trigger-Token value

Output is JSON on stdout. Diagnostics go to stderr. Credentials are never
accepted as command-line flags. Use '<command> --help' for command details.`;

const COMMAND_HELP: Record<string, string> = {
  "search-tweets": `Usage: twitter-watcher search-tweets --query <query> [--type Top|Latest] [--max 1..1000]\nReturns raw matching tweets. Default type is Latest; server default max is 150.`,
  "account-tweets": `Usage: twitter-watcher account-tweets --handle <handle> [--max 1..1000]\nReturns raw recent tweets for any account, including replies.`,
  "account-following": `Usage: twitter-watcher account-following --handle <handle> [--max 1..1000]\nReturns accounts followed by the handle.`,
  discover: `Usage: twitter-watcher discover --topic <topic> [--lookback-days 1..30]\nRuns paid Twitter search plus server-side account ranking.`,
  "watch-list": `Usage: twitter-watcher watch-list\nLists passively watched accounts.`,
  refresh: `Usage: twitter-watcher refresh --dry-run|--yes\nPulls current tweets into D1. This changes server state and may spend API credit.`,
  briefing: `Usage: twitter-watcher briefing --dry-run|--yes\nRuns selection, posts qualifying signal to Discord, and changes briefing state.`,
  "watch-add": `Usage: twitter-watcher watch-add --handle <handle> --dry-run|--yes\nAdds a Twitter handle idempotently.`,
  "watch-remove": `Usage: twitter-watcher watch-remove --handle <handle> --dry-run|--yes\nRemoves a Twitter handle idempotently.`,
};

interface CliClient {
  runBriefing(): ReturnType<TwitterWatcherClient["runBriefing"]>;
  refreshTweets(): ReturnType<TwitterWatcherClient["refreshTweets"]>;
  discoverAccounts(input: Parameters<TwitterWatcherClient["discoverAccounts"]>[0]): ReturnType<TwitterWatcherClient["discoverAccounts"]>;
  searchTweets(input: Parameters<TwitterWatcherClient["searchTweets"]>[0]): ReturnType<TwitterWatcherClient["searchTweets"]>;
  getAccountTweets(input: Parameters<TwitterWatcherClient["getAccountTweets"]>[0]): ReturnType<TwitterWatcherClient["getAccountTweets"]>;
  getAccountFollowing(input: Parameters<TwitterWatcherClient["getAccountFollowing"]>[0]): ReturnType<TwitterWatcherClient["getAccountFollowing"]>;
  listWatchedAccounts(): ReturnType<TwitterWatcherClient["listWatchedAccounts"]>;
  addWatchedAccount(input: Parameters<TwitterWatcherClient["addWatchedAccount"]>[0]): ReturnType<TwitterWatcherClient["addWatchedAccount"]>;
  removeWatchedAccount(input: Parameters<TwitterWatcherClient["removeWatchedAccount"]>[0]): ReturnType<TwitterWatcherClient["removeWatchedAccount"]>;
}

export interface CliDependencies {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  clientFactory?: (config: TwitterWatcherClientConfig) => CliClient;
}

class CliError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message);
  }
}

type ParsedOptions = Map<string, string | true>;

function parseOptions(args: string[], allowed: Set<string>): ParsedOptions {
  const result = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) throw new CliError(`unexpected argument: ${arg ?? ""}`, EXIT_USAGE);
    const name = arg.slice(2);
    if (!allowed.has(name)) throw new CliError(`unknown option --${name}`, EXIT_USAGE);
    if (result.has(name)) throw new CliError(`option --${name} may only be supplied once`, EXIT_USAGE);
    if (name === "help" || name === "dry-run" || name === "yes") {
      result.set(name, true);
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`option --${name} requires a value`, EXIT_USAGE);
    }
    result.set(name, value);
  }
  return result;
}

function requiredString(options: ParsedOptions, name: string): string {
  const value = options.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError(`missing required option --${name}`, EXIT_USAGE);
  }
  return value.trim();
}

function optionalInteger(
  options: ParsedOptions,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new CliError(`--${name} must be an integer from ${minimum} to ${maximum}`, EXIT_USAGE);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new CliError(`--${name} must be an integer from ${minimum} to ${maximum}`, EXIT_USAGE);
  }
  return parsed;
}

function normalizeHandle(value: string): string {
  const handle = value.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new CliError("handle must contain 1-15 letters, numbers, or underscores", EXIT_USAGE);
  }
  return handle;
}

function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("TWITTER_WATCHER_BASE_URL must be a valid HTTP(S) URL", EXIT_USAGE);
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
    throw new CliError("TWITTER_WATCHER_BASE_URL must use HTTP or HTTPS", EXIT_USAGE);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(
      "TWITTER_WATCHER_BASE_URL must not contain credentials, query parameters, or a fragment",
      EXIT_USAGE,
    );
  }
  return raw;
}

function requireConfirmation(options: ParsedOptions): "dry-run" | "execute" {
  const dryRun = options.get("dry-run") === true;
  const yes = options.get("yes") === true;
  if (dryRun && yes) throw new CliError("use either --dry-run or --yes, not both", EXIT_USAGE);
  if (!dryRun && !yes) {
    throw new CliError("this command has side effects; inspect --dry-run, then rerun with --yes", EXIT_CONFIRMATION_REQUIRED);
  }
  return dryRun ? "dry-run" : "execute";
}

function redact(message: string, token: string | undefined): string {
  return token ? message.split(token).join("[redacted]") : message;
}

function json(stdout: (text: string) => void, payload: unknown): void {
  stdout(`${JSON.stringify(payload)}\n`);
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  const clientFactory = dependencies.clientFactory ?? ((config) => new TwitterWatcherClient(config));

  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    stdout(`${HELP}\n`);
    return 0;
  }
  if (!(command in COMMAND_HELP)) {
    stderr(`twitter-watcher: unknown command '${command}'\n\n${HELP}\n`);
    return EXIT_USAGE;
  }

  try {
    let options: ParsedOptions;
    let operation: () => Promise<unknown>;
    let dryRunRequest: { method: string; path: string; body?: unknown } | undefined;

    // Parse and validate command arguments before requiring credentials.
    switch (command) {
      case "search-tweets": {
        options = parseOptions(args.slice(1), new Set(["query", "type", "max", "help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        const query = requiredString(options, "query");
        if (query.length > 500) throw new CliError("--query must be 500 characters or fewer", EXIT_USAGE);
        const rawType = options.get("type");
        if (rawType !== undefined && rawType !== "Top" && rawType !== "Latest") {
          throw new CliError("--type must be Top or Latest", EXIT_USAGE);
        }
        const maxTweets = optionalInteger(options, "max", 1, 1000);
        operation = async () => getClient().searchTweets({
          query,
          ...(typeof rawType === "string" && { queryType: rawType as "Top" | "Latest" }),
          ...(maxTweets !== undefined && { maxTweets }),
        });
        break;
      }
      case "account-tweets": {
        options = parseOptions(args.slice(1), new Set(["handle", "max", "help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        const handle = normalizeHandle(requiredString(options, "handle"));
        const maxTweets = optionalInteger(options, "max", 1, 1000);
        operation = async () => getClient().getAccountTweets({ handle, ...(maxTweets !== undefined && { maxTweets }) });
        break;
      }
      case "account-following": {
        options = parseOptions(args.slice(1), new Set(["handle", "max", "help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        const handle = normalizeHandle(requiredString(options, "handle"));
        const maxAccounts = optionalInteger(options, "max", 1, 1000);
        operation = async () => getClient().getAccountFollowing({ handle, ...(maxAccounts !== undefined && { maxAccounts }) });
        break;
      }
      case "discover": {
        options = parseOptions(args.slice(1), new Set(["topic", "lookback-days", "help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        const topic = requiredString(options, "topic");
        const lookbackDays = optionalInteger(options, "lookback-days", 1, 30);
        operation = async () => getClient().discoverAccounts({ topic, ...(lookbackDays !== undefined && { lookbackDays }) });
        break;
      }
      case "watch-list": {
        options = parseOptions(args.slice(1), new Set(["help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        operation = async () => getClient().listWatchedAccounts();
        break;
      }
      case "refresh": {
        options = parseOptions(args.slice(1), new Set(["dry-run", "yes", "help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        const mode = requireConfirmation(options);
        dryRunRequest = { method: "POST", path: "/api/refresh" };
        if (mode === "dry-run") { json(stdout, { dryRun: true, ...dryRunRequest }); return 0; }
        operation = async () => getClient().refreshTweets();
        break;
      }
      case "briefing": {
        options = parseOptions(args.slice(1), new Set(["dry-run", "yes", "help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        const mode = requireConfirmation(options);
        dryRunRequest = { method: "POST", path: "/trigger" };
        if (mode === "dry-run") { json(stdout, { dryRun: true, ...dryRunRequest }); return 0; }
        operation = async () => getClient().runBriefing();
        break;
      }
      case "watch-add":
      case "watch-remove": {
        options = parseOptions(args.slice(1), new Set(["handle", "dry-run", "yes", "help"]));
        if (options.has("help")) { stdout(`${COMMAND_HELP[command]}\n`); return 0; }
        const handle = normalizeHandle(requiredString(options, "handle"));
        const mode = requireConfirmation(options);
        const add = command === "watch-add";
        dryRunRequest = {
          method: add ? "POST" : "DELETE",
          path: add ? "/api/promote" : "/api/watch-targets",
          body: { handle, source: "twitter" },
        };
        if (mode === "dry-run") { json(stdout, { dryRun: true, ...dryRunRequest }); return 0; }
        operation = async () => add
          ? getClient().addWatchedAccount({ handle })
          : getClient().removeWatchedAccount({ handle });
        break;
      }
      default:
        throw new CliError(`unknown command '${command}'`, EXIT_USAGE);
    }

    let client: CliClient | undefined;
    function getClient(): CliClient {
      if (client) return client;
      const baseUrl = env.TWITTER_WATCHER_BASE_URL;
      const triggerToken = env.TWITTER_WATCHER_TRIGGER_TOKEN;
      const missing = [
        !baseUrl && "TWITTER_WATCHER_BASE_URL",
        !triggerToken && "TWITTER_WATCHER_TRIGGER_TOKEN",
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new CliError(`missing required environment variable(s): ${missing.join(", ")}`, EXIT_USAGE);
      }
      client = clientFactory({
        baseUrl: validateBaseUrl(baseUrl as string),
        triggerToken: triggerToken as string,
      });
      return client;
    }

    json(stdout, await operation());
    return 0;
  } catch (error) {
    const token = env.TWITTER_WATCHER_TRIGGER_TOKEN;
    if (error instanceof CliError) {
      stderr(`twitter-watcher: ${redact(error.message, token)}\n`);
      return error.exitCode;
    }
    if (error instanceof TwitterWatcherHttpError) {
      stderr(`twitter-watcher: ${redact(error.message, token)}\n`);
      return EXIT_HTTP;
    }
    if (error instanceof TwitterWatcherNetworkError) {
      stderr(`twitter-watcher: ${redact(error.message, token)}\n`);
      return EXIT_NETWORK;
    }
    stderr(`twitter-watcher: ${redact(error instanceof Error ? error.message : String(error), token)}\n`);
    return EXIT_NETWORK;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
