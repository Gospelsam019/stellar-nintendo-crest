/**
 * Strict validation at the ledger event parsing boundary (#29).
 *
 * Raw Soroban events are untyped. Each one is checked against its expected shape before any
 * handler sees it, so a malformed payload becomes a reported failure rather than an exception
 * in the ingestion loop. A failure carries the reasons, so the caller can write it to the DLQ.
 *
 * This uses plain type guards instead of zod, because the backend has no schema library
 * installed yet. The shape is the same as a zod schema would describe.
 */

import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

export interface RawContractEvent {
  topic: string;
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  value: unknown;
}

export type ParseResult =
  | { ok: true; event: RawContractEvent }
  | { ok: false; reasons: string[] };

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Checks one raw event. Returns every problem found, not just the first.
 */
export function parseContractEvent(raw: unknown): ParseResult {
  const reasons: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reasons: ["event is not an object"] };
  }
  const e = raw as Record<string, unknown>;

  if (!isString(e.topic)) reasons.push("topic must be a non-empty string");
  if (!isString(e.contractId)) reasons.push("contractId must be a non-empty string");
  if (!isNonNegativeInt(e.ledger)) reasons.push("ledger must be a non-negative integer");
  if (!isString(e.txHash)) reasons.push("txHash must be a non-empty string");
  if (!isNonNegativeInt(e.eventIndex)) reasons.push("eventIndex must be a non-negative integer");
  if (e.value === undefined) reasons.push("value is missing");

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, event: e as unknown as RawContractEvent };
}

/**
 * A dead-letter record for an event that could not be parsed or validated (#218).
 *
 * The raw payload is serialized so an operator can inspect and retry it later via the admin
 * CLI. `ledger` is best-effort: it is extracted from the raw event when present so the DLQ row
 * can be correlated with the ingestion position even when the rest of the shape is invalid.
 */
export interface DeadLetterRecord {
  /** JSON-serialized raw event payload. */
  payload: string;
  /** Human-readable error message (joined validation reasons or thrown error). */
  errorMessage: string;
  /** Stack trace when the failure came from a thrown exception; null for validation failures. */
  errorStack: string | null;
  /** Ledger sequence the event belongs to, when it could be recovered from the payload. */
  ledger: number | null;
}

/**
 * Serializes a raw event payload to JSON without throwing on circular or non-serializable data.
 */
const serializePayload = (raw: unknown): string => {
  try {
    const json = JSON.stringify(raw);
    return json === undefined ? String(raw) : json;
  } catch (err) {
    return `[unserializable payload: ${String(err)}]`;
  }
};

/**
 * Best-effort extraction of the ledger sequence from a raw event, used to correlate DLQ rows.
 */
const extractLedger = (raw: unknown): number | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const ledger = (raw as Record<string, unknown>).ledger;
  return isNonNegativeInt(ledger) ? ledger : null;
};

/**
 * Builds a DLQ record from a failed event. Accepts either validation reasons or a thrown error
 * so both failure modes are captured with the same shape.
 */
export function buildDeadLetterRecord(
  raw: unknown,
  reasons: string[],
  err?: unknown,
): DeadLetterRecord {
  const errorMessage = err !== undefined ? String(err) : reasons.join("; ");
  const errorStack =
    err instanceof Error && typeof err.stack === "string" ? err.stack : null;
  return {
    payload: serializePayload(raw),
    errorMessage: errorMessage.length > 0 ? errorMessage : "unknown parse failure",
    errorStack,
    ledger: extractLedger(raw),
  };
}

/**
 * Parses a batch and routes each failure to `onDeadLetter` instead of throwing, so one bad
 * event never stops the loop. Returns the events that passed.
 */
export function parseEventsOrDeadLetter(
  raws: unknown[],
  onDeadLetter: (raw: unknown, reasons: string[]) => void,
): RawContractEvent[] {
  const valid: RawContractEvent[] = [];
  for (const raw of raws) {
    try {
      const result = parseContractEvent(raw);
      if (result.ok) {
        valid.push(result.event);
      } else {
        onDeadLetter(raw, result.reasons);
      }
    } catch (err) {
      onDeadLetter(raw, [`parser threw: ${String(err)}`]);
    }
  }
  return valid;
}

/**
 * Notification storage schema (#253).
 *
 * These DDL statements create the tables that remember a user's communication preferences
 * and their registered push device tokens. Both tables are keyed by the user's wallet
 * address, which is indexed for instant lookup when an event trigger fires.
 *
 * `user_notification_settings` holds one row per wallet address with boolean toggles for
 * bet settlement, dispute alerts, and referral commission notifications.
 *
 * `device_tokens` enforces a one-to-many relationship between a wallet address and its
 * push tokens via a foreign key back to `user_notification_settings`.
 */
export const NOTIFICATION_SCHEMA_MIGRATION = `
CREATE TABLE IF NOT EXISTS user_notification_settings (
  wallet_address TEXT PRIMARY KEY,
  bet_settlement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  dispute_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  referral_commission_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_notification_settings_wallet
  ON user_notification_settings (wallet_address);

CREATE TABLE IF NOT EXISTS device_tokens (
  id BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL
    REFERENCES user_notification_settings (wallet_address) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_address, token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_wallet
  ON device_tokens (wallet_address);
`;
