/**
 * Real-time publish of indexed events to Redis (#33).
 *
 * Called only after the database transaction for an event has committed, so subscribers never
 * see an event that was rolled back. A Redis failure is logged and swallowed, so it cannot block
 * or roll back the indexing transaction.
 *
 * The same committed events are also bridged to WebSocket clients (#211) via a per-market topic
 * so frontend feeds can subscribe to only the markets they care about.
 */

export interface PubSubClient {
  publish(channel: string, message: string): Promise<number>;
}

export interface PublishLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LedgerEventNotice {
  type: string;
  marketId?: number;
  timestamp: string;
  state: Record<string, unknown>;
}

/** Event types bridged to WebSocket clients (#211). */
export const BROADCAST_EVENT_TYPES = ["bet.placed", "market.resolved", "dispute.created"] as const;

export type BroadcastEventType = (typeof BROADCAST_EVENT_TYPES)[number];

/** Channel name for one topic, `stellar:events:<topic>`. */
export function channelFor(topic: string): string {
  return `stellar:events:${topic}`;
}

/** Redis hash key holding the cached stats for one market, `stellar:market:stats:<marketId>`. */
export function marketStatsKey(marketId: number): string {
  return `stellar:market:stats:${marketId}`;
}

/**
 * Channel name for the WebSocket bridge of one market, `stellar:ws:market:<marketId>`.
 * Clients subscribe to this topic to receive only events for that market.
 */
export function wsMarketChannelFor(marketId: number): string {
  return `stellar:ws:market:${marketId}`;
}

/**
 * Publishes one committed event. Returns `true` when the message was sent, and `false` when the
 * publish failed. It never throws.
 */
export async function publishCommittedEvent(
  client: PubSubClient,
  logger: PublishLogger,
  topic: string,
  notice: LedgerEventNotice,
): Promise<boolean> {
  try {
    await client.publish(channelFor(topic), JSON.stringify(notice));
    return true;
  } catch (err) {
    logger.warn(
      { event: "redis_publish_failed", topic, error: err instanceof Error ? err.message : String(err) },
      "Could not publish indexed event; the database commit is unaffected",
    );
    return false;
  }
}

/** Minimal Redis surface needed to invalidate a cached market stats hash. */
export interface CacheClient {
  del(...keys: string[]): Promise<number>;
}

/**
 * Invalidates the cached market stats hash after a new bet has been committed (#241). The next
 * market odds query will miss the cache, fall back to the database, and repopulate the hash.
 *
 * Like {@link publishCommittedEvent}, a Redis failure is logged and swallowed so it cannot block
 * or roll back the indexing transaction.
 */
export async function invalidateMarketStats(
  client: CacheClient,
  logger: PublishLogger,
  marketId: number,
): Promise<boolean> {
  try {
    await client.del(marketStatsKey(marketId));
    return true;
  } catch (err) {
    logger.warn(
      { event: "redis_cache_invalidate_failed", marketId, error: err instanceof Error ? err.message : String(err) },
      "Could not invalidate cached market stats; the database commit is unaffected",
    );
    return false;
  }
}
