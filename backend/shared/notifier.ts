/**
 * Shared notification helpers.
 *
 * Posts rich embed messages to dedicated channels (#alerts-critical,
 * #oracle-disputes, #audit-events) with severity color bars and direct links
 * back to the web UI. Includes a token-bucket rate limiter so alert storms do
 * not flood the channels.
 *
 * Also provides user-facing webhook notifications for bet outcomes and
 * referral earnings. Outgoing payloads are signed with an HMAC-SHA256
 * signature header derived from a per-user shared secret, and failed
 * deliveries are retried up to 5 times with exponential backoff.
 */

import { createHmac } from 'crypto';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export type AlertChannel = 'alerts-critical' | 'oracle-disputes' | 'audit-events';

export interface AlertPayload {
  /** Short headline shown as the embed title. */
  title: string;
  /** Human-readable description of what happened. */
  message: string;
  severity: AlertSeverity;
  /** Logical channel the alert belongs to. */
  channel: AlertChannel;
  /** Optional path (e.g. `/disputes/42`) appended to the web UI base URL. */
  link?: string;
  /** Optional structured fields rendered as embed fields. */
  fields?: Record<string, string | number>;
  /** Optional ISO timestamp; defaults to now. */
  timestamp?: string;
}

export interface NotifierConfig {
  /** Base URL of the web UI used to build direct links. */
  webBaseUrl: string;
  /** Webhook URLs keyed by logical channel. */
  webhooks: Partial<Record<AlertChannel, string>>;
  /** Max alerts allowed per window, per channel. Defaults to 5. */
  rateLimit?: number;
  /** Rate-limit window in milliseconds. Defaults to 60_000. */
  rateLimitWindowMs?: number;
}

/**
 * Per-user communication preferences, keyed by Stellar wallet address.
 * Mirrors the `user_notification_settings` table (one row per wallet).
 */
export interface UserNotificationSettings {
  /** Stellar wallet address (primary key). */
  walletAddress: string;
  /** Notify when a bet is settled. */
  betSettlement: boolean;
  /** Notify when a dispute is raised or resolved. */
  disputeAlerts: boolean;
  /** Notify when a referral commission is credited. */
  referralCommission: boolean;
  /** Deliver alerts via email. */
  emailEnabled: boolean;
  /** Deliver alerts via push notification. */
  pushEnabled: boolean;
}

/**
 * A registered push notification token for a wallet address.
 * Mirrors the `device_tokens` table (many tokens per wallet).
 */
export interface DeviceToken {
  /** Stellar wallet address (foreign key to user_notification_settings). */
  walletAddress: string;
  /** Opaque push registration token issued by the platform. */
  token: string;
  /** Platform that issued the token. */
  platform: 'ios' | 'android' | 'web';
  /** ISO timestamp of registration. */
  createdAt: string;
}

/** Severity color bars (decimal RGB) used for the embed side stripe. */
const SEVERITY_COLORS: Record<AlertSeverity, number> = {
  critical: 0xd32f2f, // red
  high: 0xf57c00, // orange
  medium: 0xfbc02d, // amber
  low: 0x388e3c, // green
};

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

/**
 * Normalize Unicode homoglyphs to their ASCII equivalents.
 */
export function normalizeHomoglyphs(input: string): string {
  let result = '';
  for (const char of input) {
    result += HOMOGLYPH_MAP[char] ?? char;
  }
  return result;
}

/**
 * Strip HTML tags and script content from a string.
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '');
}

/**
 * Sanitize a referral display name.
 *
 * Strips HTML/script tags, normalizes Unicode homoglyphs, then validates
 * against the whitelist `^[a-zA-Z0-9_-]{3,20}$`.
 *
 * @returns the sanitized name, or `null` if it is invalid.
 */
export function sanitizeDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  /**
   * Notify the operations team that the dispute bot submitted a challenge.
   * Routes to the dedicated #oracle-disputes channel with the market, the
   * proposed vs. canonical outcome, and the posted challenge bond.
   */
  async notifyChallengeSubmitted(params: {
    marketId: string;
    proposedOutcome: string;
    canonicalOutcome: string;
    discrepancyBps: number;
    bondAmount: string;
    txHash?: string;
  }): Promise<boolean> {
    return this.notify({
      title: `Dispute challenge submitted for market ${params.marketId}`,
      message:
        `Automated dispute bot challenged a proposed outcome that contradicts ` +
        `the canonical price feed (discrepancy ${params.discrepancyBps} bps).`,
      severity: 'high',
      channel: 'oracle-disputes',
      link: `/markets/${params.marketId}`,
      fields: {
        'Market': params.marketId,
        'Proposed outcome': params.proposedOutcome,
        'Canonical outcome': params.canonicalOutcome,
        'Discrepancy (bps)': params.discrepancyBps,
        'Challenge bond': params.bondAmount,
        ...(params.txHash ? { 'Tx hash': params.txHash } : {}),
      },
    });
  }

  /** Token-bucket style limiter: at most `rateLimit` alerts per window. */
  private allow(channel: AlertChannel): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(channel);

    if (!bucket || now - bucket.windowStart >= this.config.rateLimitWindowMs) {
      this.buckets.set(channel, { count: 1, windowStart: now });
      return true;
    }

  if (!DISPLAY_NAME_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

/**
 * Validate a referral display name without returning the sanitized value.
 */
export function isValidDisplayName(input: unknown): boolean {
  return sanitizeDisplayName(input) !== null;
}

// ---------------------------------------------------------------------------
// User webhook notifications (bet outcomes + referral earnings)
// ---------------------------------------------------------------------------

export type UserNotificationEvent = 'bet.won' | 'referral.commission';

export interface UserWebhookRegistration {
  /** Destination URL the user registered in settings. */
  url: string;
  /** Shared secret used to sign outgoing payloads (HMAC-SHA256). */
  secret: string;
  /** Whether the registration is currently active. */
  enabled: boolean;
}

export interface UserNotificationPayload {
  event: UserNotificationEvent;
  /** ISO timestamp of when the event occurred. */
  occurredAt: string;
  /** Event-specific data (bet id, amount, currency, etc.). */
  data: Record<string, unknown>;
}

/** Header carrying the hex HMAC-SHA256 signature of the raw request body. */
export const SIGNATURE_HEADER = 'X-HandsOff-Signature';

/** Maximum number of delivery attempts (initial + retries). */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Base backoff delay in milliseconds; doubled on each retry. */
export const BASE_BACKOFF_MS = 1_000;

/** Compute the hex HMAC-SHA256 signature for a raw payload body. */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Exponential backoff delay for a given (1-based) attempt number. */
export function backoffDelayMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
}

/**
 * In-memory registry of user webhook registrations, keyed by user id.
 * Backed by user settings in production; kept minimal here so the delivery
 * worker can be exercised independently.
 */
export class UserWebhookRegistry {
  private readonly registrations = new Map<string, UserWebhookRegistration>();

  /** Register or replace the webhook URL + secret for a user. */
  register(userId: string, url: string, secret: string): UserWebhookRegistration {
    const registration: UserWebhookRegistration = { url, secret, enabled: true };
    this.registrations.set(userId, registration);
    return registration;
  }

  /** Remove a user's webhook registration. Returns true when one existed. */
  remove(userId: string): boolean {
    return this.registrations.delete(userId);
  }

  /** Fetch a user's registration, if any. */
  get(userId: string): UserWebhookRegistration | undefined {
    return this.registrations.get(userId);
  }
}

/**
 * Delivery worker that signs and POSTs user notifications, retrying failed
 * deliveries up to {@link MAX_DELIVERY_ATTEMPTS} times with exponential
 * backoff.
 */
export class UserNotificationWorker {
  constructor(
    private readonly registry: UserWebhookRegistry,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Deliver a notification to a user's registered webhook. Returns true when
   * a delivery succeeded, false when the user has no active webhook or all
   * attempts failed.
   */
  async deliver(userId: string, payload: UserNotificationPayload): Promise<boolean> {
    const registration = this.registry.get(userId);
    if (!registration || !registration.enabled) {
      return false;
    }

    const body = JSON.stringify(payload);
    const signature = signPayload(registration.secret, body);

    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(registration.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SIGNATURE_HEADER]: signature,
          },
          body,
        });
        if (res.ok) {
          return true;
        }
      } catch {
        // Network error: fall through to retry.
      }

      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        await this.sleep(backoffDelayMs(attempt));
      }
    }

    return false;
  }

  /** Notify a user that one of their bets resolved as a winner. */
  async notifyBetWon(userId: string, data: Record<string, unknown>): Promise<boolean> {
    return this.deliver(userId, {
      event: 'bet.won',
      occurredAt: new Date().toISOString(),
      data,
    });
  }

  /** Notify a user that they earned a referral commission. */
  async notifyReferralCommission(userId: string, data: Record<string, unknown>): Promise<boolean> {
    return this.deliver(userId, {
      event: 'referral.commission',
      occurredAt: new Date().toISOString(),
      data,
    });
  }
}
