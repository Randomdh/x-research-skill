/**
 * X API wrapper — search, threads, profiles, single tweets.
 * Supports OAuth 1.0a (via twitter-api-v2) or Bearer token.
 */

import { readFileSync } from "fs";
import { TwitterApi } from "twitter-api-v2";

const RATE_DELAY_MS = 350; // stay under 450 req/15min

interface Credentials {
  type: "bearer" | "oauth1";
  bearerToken?: string;
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accessSecret?: string;
}

function getCredentials(): Credentials {
  // Try bearer token first
  if (process.env.X_BEARER_TOKEN) {
    return { type: "bearer", bearerToken: process.env.X_BEARER_TOKEN };
  }

  // Try OAuth 1.0a credentials
  if (process.env.TWITTER_API_KEY) {
    return {
      type: "oauth1",
      apiKey: process.env.TWITTER_API_KEY,
      apiSecret: process.env.TWITTER_API_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_SECRET,
    };
  }

  // Try global.env
  try {
    const envFile = readFileSync(
      `${process.env.HOME}/.config/env/global.env`,
      "utf-8"
    );

    const bearerMatch = envFile.match(/X_BEARER_TOKEN=["']?([^"'\n]+)/);
    if (bearerMatch) {
      return { type: "bearer", bearerToken: bearerMatch[1] };
    }

    const apiKey = envFile.match(/TWITTER_API_KEY=["']?([^"'\n]+)/)?.[1];
    const apiSecret = envFile.match(/TWITTER_API_SECRET=["']?([^"'\n]+)/)?.[1];
    const accessToken = envFile.match(/TWITTER_ACCESS_TOKEN=["']?([^"'\n]+)/)?.[1];
    const accessSecret = envFile.match(/TWITTER_ACCESS_SECRET=["']?([^"'\n]+)/)?.[1];

    if (apiKey && apiSecret && accessToken && accessSecret) {
      return { type: "oauth1", apiKey, apiSecret, accessToken, accessSecret };
    }
  } catch {}

  throw new Error(
    "X credentials not found. Set X_BEARER_TOKEN or TWITTER_API_KEY/SECRET/ACCESS_TOKEN/ACCESS_SECRET"
  );
}

let _client: TwitterApi | null = null;

function getClient(): TwitterApi {
  if (_client) return _client;

  const creds = getCredentials();

  if (creds.type === "bearer") {
    _client = new TwitterApi(creds.bearerToken!);
  } else {
    _client = new TwitterApi({
      appKey: creds.apiKey!,
      appSecret: creds.apiSecret!,
      accessToken: creds.accessToken!,
      accessSecret: creds.accessSecret!,
    });
  }

  return _client;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface Tweet {
  id: string;
  text: string;
  author_id: string;
  username: string;
  name: string;
  created_at: string;
  conversation_id: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    impressions: number;
    bookmarks: number;
  };
  urls: string[];
  mentions: string[];
  hashtags: string[];
  tweet_url: string;
}

function parseTweets(data: any[], includes?: any): Tweet[] {
  if (!data) return [];

  const users: Record<string, any> = {};
  for (const u of includes?.users || []) {
    users[u.id] = u;
  }

  return data.map((t: any) => {
    const u = users[t.author_id] || {};
    const m = t.public_metrics || {};
    return {
      id: t.id,
      text: t.text,
      author_id: t.author_id,
      username: u.username || "?",
      name: u.name || "?",
      created_at: t.created_at,
      conversation_id: t.conversation_id,
      metrics: {
        likes: m.like_count || 0,
        retweets: m.retweet_count || 0,
        replies: m.reply_count || 0,
        quotes: m.quote_count || 0,
        impressions: m.impression_count || 0,
        bookmarks: m.bookmark_count || 0,
      },
      urls: (t.entities?.urls || [])
        .map((u: any) => u.expanded_url)
        .filter(Boolean),
      mentions: (t.entities?.mentions || [])
        .map((m: any) => m.username)
        .filter(Boolean),
      hashtags: (t.entities?.hashtags || [])
        .map((h: any) => h.tag)
        .filter(Boolean),
      tweet_url: `https://x.com/${u.username || "?"}/status/${t.id}`,
    };
  });
}

/**
 * Parse a "since" value into an ISO 8601 timestamp.
 */
function parseSince(since: string): Date | undefined {
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    const ms =
      unit === "m" ? num * 60_000 :
      unit === "h" ? num * 3_600_000 :
      num * 86_400_000;
    return new Date(Date.now() - ms);
  }

  if (since.includes("T") || since.includes("-")) {
    try {
      return new Date(since);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Search recent tweets (last 7 days).
 */
export async function search(
  query: string,
  opts: {
    maxResults?: number;
    pages?: number;
    sortOrder?: "relevancy" | "recency";
    since?: string;
  } = {}
): Promise<Tweet[]> {
  const client = getClient();
  const maxResults = Math.max(Math.min(opts.maxResults || 100, 100), 10);
  const pages = opts.pages || 1;
  const sort = opts.sortOrder || "relevancy";

  const searchOpts: any = {
    max_results: maxResults,
    "tweet.fields": ["created_at", "public_metrics", "author_id", "conversation_id", "entities"],
    expansions: ["author_id"],
    "user.fields": ["username", "name", "public_metrics"],
    sort_order: sort,
  };

  if (opts.since) {
    const startTime = parseSince(opts.since);
    if (startTime) {
      searchOpts.start_time = startTime.toISOString();
    }
  }

  let allTweets: Tweet[] = [];

  try {
    const paginator = await client.v2.search(query, searchOpts);
    let pageCount = 0;

    for await (const tweet of paginator) {
      // Build tweet list from paginator
      const data = paginator.data?.data || [];
      const includes = paginator.data?.includes;
      allTweets = parseTweets(data, includes);
      pageCount++;
      if (pageCount >= pages) break;
      await sleep(RATE_DELAY_MS);
    }
  } catch (err: any) {
    // Fallback: try direct fetch
    const results = await client.v2.search(query, searchOpts);
    const data = results.data?.data || results.data || [];
    const includes = results.includes;
    allTweets = parseTweets(Array.isArray(data) ? data : [data], includes);
  }

  return allTweets;
}

/**
 * Fetch a full conversation thread by root tweet ID.
 */
export async function thread(
  conversationId: string,
  opts: { pages?: number } = {}
): Promise<Tweet[]> {
  const query = `conversation_id:${conversationId}`;
  const tweets = await search(query, {
    pages: opts.pages || 2,
    sortOrder: "recency",
  });

  // Also fetch the root tweet
  try {
    const root = await getTweet(conversationId);
    if (root) {
      tweets.unshift(root);
    }
  } catch {
    // Root tweet might be deleted
  }

  return tweets;
}

/**
 * Get recent tweets from a specific user.
 */
export async function profile(
  username: string,
  opts: { count?: number; includeReplies?: boolean } = {}
): Promise<{ user: any; tweets: Tweet[] }> {
  const client = getClient();

  // Look up user
  const userResult = await client.v2.userByUsername(username, {
    "user.fields": ["public_metrics", "description", "created_at"],
  });

  if (!userResult.data) {
    throw new Error(`User @${username} not found`);
  }

  await sleep(RATE_DELAY_MS);

  // Search for their tweets
  const replyFilter = opts.includeReplies ? "" : " -is:reply";
  const query = `from:${username} -is:retweet${replyFilter}`;
  const tweets = await search(query, {
    maxResults: Math.min(opts.count || 20, 100),
    sortOrder: "recency",
  });

  return { user: userResult.data, tweets };
}

/**
 * Fetch a single tweet by ID.
 */
export async function getTweet(tweetId: string): Promise<Tweet | null> {
  const client = getClient();

  try {
    const result = await client.v2.singleTweet(tweetId, {
      "tweet.fields": ["created_at", "public_metrics", "author_id", "conversation_id", "entities"],
      expansions: ["author_id"],
      "user.fields": ["username", "name", "public_metrics"],
    });

    if (!result.data) return null;

    const parsed = parseTweets([result.data], result.includes);
    return parsed[0] || null;
  } catch {
    return null;
  }
}

/**
 * Sort tweets by engagement metric.
 */
export function sortBy(
  tweets: Tweet[],
  metric: "likes" | "impressions" | "retweets" | "replies" = "likes"
): Tweet[] {
  return [...tweets].sort((a, b) => b.metrics[metric] - a.metrics[metric]);
}

/**
 * Filter tweets by minimum engagement.
 */
export function filterEngagement(
  tweets: Tweet[],
  opts: { minLikes?: number; minImpressions?: number }
): Tweet[] {
  return tweets.filter((t) => {
    if (opts.minLikes && t.metrics.likes < opts.minLikes) return false;
    if (opts.minImpressions && t.metrics.impressions < opts.minImpressions)
      return false;
    return true;
  });
}

/**
 * Deduplicate tweets by ID.
 */
export function dedupe(tweets: Tweet[]): Tweet[] {
  const seen = new Set<string>();
  return tweets.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
