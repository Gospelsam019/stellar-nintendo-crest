const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const { Keypair, Networks, TransactionBuilder, Transaction, Operation, Account, BASE_FEE } = require('@stellar/stellar-sdk');

const app = express();

const ORACLE_HMAC_SECRET = process.env.ORACLE_HMAC_SECRET || '';
const ORACLE_TIMESTAMP_TOLERANCE_SECONDS = 300;

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://app.example.com,https://www.example.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Whitelist for referral display names: alphanumerics, underscore and hyphen only.
const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;

// Common Unicode confusables mapped to their ASCII lookalikes so that
// homoglyph impersonation attempts are normalized before validation.
const HOMOGLYPH_MAP = {
  // Cyrillic
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M',
  '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0425': 'X', '\u0423': 'Y', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J',
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j',
  // Greek
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
  '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03BF': 'o',
  '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v',
  '\u03C1': 'p', '\u03C5': 'u', '\u03C7': 'x',
  // Fullwidth Latin
  '\uFF21': 'A', '\uFF22': 'B', '\uFF23': 'C', '\uFF24': 'D', '\uFF25': 'E',
  '\uFF26': 'F', '\uFF27': 'G', '\uFF28': 'H', '\uFF29': 'I', '\uFF2A': 'J',
  '\uFF2B': 'K', '\uFF2C': 'L', '\uFF2D': 'M', '\uFF2E': 'N', '\uFF2F': 'O',
  '\uFF30': 'P', '\uFF31': 'Q', '\uFF32': 'R', '\uFF33': 'S', '\uFF34': 'T',
  '\uFF35': 'U', '\uFF36': 'V', '\uFF37': 'W', '\uFF38': 'X', '\uFF39': 'Y',
  '\uFF3A': 'Z',
  '\uFF41': 'a', '\uFF42': 'b', '\uFF43': 'c', '\uFF44': 'd', '\uFF45': 'e',
  '\uFF46': 'f', '\uFF47': 'g', '\uFF48': 'h', '\uFF49': 'i', '\uFF4A': 'j',
  '\uFF4B': 'k', '\uFF4C': 'l', '\uFF4D': 'm', '\uFF4E': 'n', '\uFF4F': 'o',
  '\uFF50': 'p', '\uFF51': 'q', '\uFF52': 'r', '\uFF53': 's', '\uFF54': 't',
  '\uFF55': 'u', '\uFF56': 'v', '\uFF57': 'w', '\uFF58': 'x', '\uFF59': 'y',
  '\uFF5A': 'z',
};

/**
 * Normalize Unicode confusable characters to their ASCII equivalents.
 * @param {string} value
 * @returns {string}
 */
function normalizeHomoglyphs(value) {
  return value.replace(/[\u0080-\uFFFF]/g, (char) => HOMOGLYPH_MAP[char] || char);
}

/**
 * Sanitize a referral display name against XSS and homoglyph impersonation.
 * Strips HTML/script content, normalizes confusables, then enforces the
 * `^[a-zA-Z0-9_-]{3,20}$` whitelist and length constraint.
 * @param {string} name
 * @returns {string|null} sanitized name, or null when invalid
 */
function sanitizeDisplayName(name) {
  if (typeof name !== 'string') {
    return null;
  }

  // Remove any HTML tags and script content before further processing.
  const stripped = name
    .replace(/<[^>]*>/g, '')
    .replace(/[<>"'`]/g, '')
    .trim();

  const normalized = normalizeHomoglyphs(stripped);

  if (!DISPLAY_NAME_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://trusted-cdn.example.com'],
        connectSrc: ["'self'", 'https://api.example.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Oracle-Signature', 'X-Oracle-Timestamp'],
    credentials: true,
    maxAge: 86400,
  })
);

app.use(express.json());

// Audit log querying API for security auditors.
// Reads from the immutable `audit_logs` table (see migration 0011).
// Supports filtering by actor, action, entity_type, entity_id and time range.
const AUDIT_LOG_MAX_LIMIT = 200;
const AUDIT_LOG_DEFAULT_LIMIT = 50;

function parseAuditLogFilters(query) {
  const filters = {};
  const where = [];
  const params = [];

  const addEq = (column, value) => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  };

  addEq('actor', query.actor);
  addEq('action', query.action);
  addEq('entity_type', query.entity_type);
  addEq('entity_id', query.entity_id);

  if (query.from) {
    params.push(query.from);
    where.push(`created_at >= $${params.length}`);
  }
  if (query.to) {
    params.push(query.to);
    where.push(`created_at <= $${params.length}`);
  }

  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = AUDIT_LOG_DEFAULT_LIMIT;
  if (limit > AUDIT_LOG_MAX_LIMIT) limit = AUDIT_LOG_MAX_LIMIT;

  let offset = parseInt(query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  filters.where = where.length ? `WHERE ${where.join(' AND ')}` : '';
  filters.params = params;
  filters.limit = limit;
  filters.offset = offset;
  return filters;
}

app.get('/api/audit-logs', async (req, res, next) => {
  try {
    const db = req.app.get('db');
    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const { where, params, limit, offset } = parseAuditLogFilters(req.query);
    const listParams = params.concat([limit, offset]);
    const sql = `
      SELECT id, actor, action, entity_type, entity_id, ip_address, metadata, created_at
      FROM audit_logs
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;

    const { rows } = await db.query(sql, listParams);
    return res.json({ data: rows, limit, offset });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/audit-logs/:id', async (req, res, next) => {
  try {
    const db = req.app.get('db');
    if (!db) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const { rows } = await db.query(
      `SELECT id, actor, action, entity_type, entity_id, ip_address, metadata, created_at
       FROM audit_logs WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Audit log entry not found' });
    }
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

module.exports = app;
module.exports.requireAuth = requireAuth;
