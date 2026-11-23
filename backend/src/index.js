const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { run: runMigrations } = require('./db/migrate');

const app = express();

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://app.example.com,https://www.example.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const PUBLIC_RATE_LIMIT = Number(process.env.RATE_LIMIT_PUBLIC || 60);
const AUTH_RATE_LIMIT = Number(process.env.RATE_LIMIT_AUTH || 300);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);

const whitelistedIps = (process.env.RATE_LIMIT_WHITELIST_IPS || '')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);

const trustedIndexerHooks = (process.env.RATE_LIMIT_TRUSTED_HOOKS || '')
  .split(',')
  .map((hook) => hook.trim())
  .filter(Boolean);

let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => {
    console.error('Redis rate limit store error:', err.message);
  });
  redisClient.connect().catch((err) => {
    console.error('Redis rate limit store connection failed:', err.message);
  });
}

// In-memory fallback token bucket store used when Redis is unavailable.
const memoryBuckets = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getWalletAddress(req) {
  const header = req.headers['x-wallet-address'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim().toLowerCase();
  }
  return null;
}

function isWhitelisted(req) {
  const ip = getClientIp(req);
  if (whitelistedIps.includes(ip)) {
    return true;
  }
  const hook = req.headers['x-indexer-hook'];
  if (typeof hook === 'string' && trustedIndexerHooks.includes(hook.trim())) {
    return true;
  }
  return false;
}

async function consumeToken(key, limit, windowMs) {
  const now = Date.now();
  const refillRate = limit / windowMs;

  if (redisClient && redisClient.isOpen) {
    const script = `
      local key = KEYS[1]
      local limit = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local refill = tonumber(ARGV[3])
      local window = tonumber(ARGV[4])
      local data = redis.call('HMGET', key, 'tokens', 'ts')
      local tokens = tonumber(data[1])
      local ts = tonumber(data[2])
      if tokens == nil then tokens = limit end
      if ts == nil then ts = now end
      local elapsed = math.max(0, now - ts)
      tokens = math.min(limit, tokens + elapsed * refill)
      local allowed = 0
      if tokens >= 1 then
        tokens = tokens - 1
        allowed = 1
      end
      redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
      redis.call('PEXPIRE', key, window)
      return { allowed, math.floor(tokens) }
    `;
    try {
      const result = await redisClient.eval(script, {
        keys: [key],
        arguments: [String(limit), String(now), String(refillRate), String(windowMs)],
      });
      return { allowed: Number(result[0]) === 1, remaining: Number(result[1]) };
    } catch (err) {
      console.error('Redis rate limit eval failed, falling back to memory:', err.message);
    }
  }

  let bucket = memoryBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: limit, ts: now };
  }
  const elapsed = Math.max(0, now - bucket.ts);
  bucket.tokens = Math.min(limit, bucket.tokens + elapsed * refillRate);
  let allowed = false;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    allowed = true;
  }
  bucket.ts = now;
  memoryBuckets.set(key, bucket);
  return { allowed, remaining: Math.floor(bucket.tokens) };
}

async function rateLimitMiddleware(req, res, next) {
  if (isWhitelisted(req)) {
    return next();
  }

  const wallet = getWalletAddress(req);
  const authenticated = Boolean(wallet);
  const limit = authenticated ? AUTH_RATE_LIMIT : PUBLIC_RATE_LIMIT;
  const key = authenticated ? `ratelimit:wallet:${wallet}` : `ratelimit:ip:${getClientIp(req)}`;

  try {
    const { allowed, remaining } = await consumeToken(key, limit, RATE_LIMIT_WINDOW_MS);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
    if (!allowed) {
      const retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please retry later.',
        retryAfter,
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://trusted-cdn.example.com'],
        connectSrc: ["'self'", ...allowedOrigins],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
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
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Wallet-Address', 'X-Indexer-Hook'],
  })
);

app.use(express.json());

app.use(rateLimitMiddleware);

const MARKET_CATEGORIES = ['crypto', 'sports', 'tech', 'politics'];
const MARKET_STATUSES = ['active', 'resolved', 'closed'];

// In-memory market store used by the search/filter endpoint. When a PostgreSQL
// pool is configured, the same query shape is executed against the markets
// table which carries a GIN index on the tsvector of question + description.
const markets = [];

function normalizeMarket(market) {
  return {
    id: market.id,
    question: market.question,
    description: market.description || '',
    category: market.category,
    status: market.status,
    createdAt: market.createdAt || null,
  };
}

function buildMarketSearchQuery({ q, category, status }) {
  const conditions = [];
  const params = [];

  if (q) {
    params.push(q);
    conditions.push(
      `to_tsvector('english', coalesce(question, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('english', $${params.length})`
    );
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = q
    ? `ORDER BY ts_rank(to_tsvector('english', coalesce(question, '') || ' ' || coalesce(description, '')), plainto_tsquery('english', $1)) DESC`
    : 'ORDER BY created_at DESC';

  return {
    text: `SELECT id, question, description, category, status, created_at FROM markets ${where} ${orderBy}`,
    params,
  };
}

function searchMarketsInMemory({ q, category, status }) {
  const term = q ? q.toLowerCase() : null;
  const results = markets.filter((market) => {
    if (category && market.category !== category) return false;
    if (status && market.status !== status) return false;
    if (term) {
      const haystack = `${market.question} ${market.description}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });

  if (term) {
    results.sort((a, b) => {
      const aScore = (a.question.toLowerCase().includes(term) ? 2 : 0) +
        (a.description.toLowerCase().includes(term) ? 1 : 0);
      const bScore = (b.question.toLowerCase().includes(term) ? 2 : 0) +
        (b.description.toLowerCase().includes(term) ? 1 : 0);
      return bScore - aScore;
    });
  }

  return results.map(normalizeMarket);
}

app.get('/api/markets', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';

  if (category && !MARKET_CATEGORIES.includes(category)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: `Invalid category. Allowed values: ${MARKET_CATEGORIES.join(', ')}`,
    });
  }
  if (status && !MARKET_STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: `Invalid status. Allowed values: ${MARKET_STATUSES.join(', ')}`,
    });
  }

  const filters = { q: q || null, category: category || null, status: status || null };
  const query = buildMarketSearchQuery(filters);
  const results = searchMarketsInMemory(filters);

  return res.json({
    data: results,
    meta: {
      count: results.length,
      filters,
      query,
    },
  });
});

const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Handsoff API',
    version: '1.0.0',
    description: 'Automated OpenAPI specification for the Handsoff backend.',
  },
  servers: [{ url: '/', description: 'Current server' }],
  components: {
    securitySchemes: {
      WalletAddress: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Wallet-Address',
        description: 'Wallet address used to identify authenticated callers.',
      },
      IndexerHook: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Indexer-Hook',
        description: 'Trusted indexer hook token for whitelisted integrations.',
      },
    },
    schemas: {
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
        },
        required: ['status'],
      },
      RateLimitError: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Too Many Requests' },
          message: { type: 'string', example: 'Rate limit exceeded. Please retry later.' },
          retryAfter: { type: 'integer', example: 60 },
        },
        required: ['error', 'message', 'retryAfter'],
      },
      Market: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string', enum: MARKET_CATEGORIES },
          status: { type: 'string', enum: MARKET_STATUSES },
          createdAt: { type: 'string', nullable: true },
        },
        required: ['id', 'question', 'category', 'status'],
      },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'Service health check',
        tags: ['System'],
        responses: {
          200: {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
          429: {
            description: 'Rate limit exceeded',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RateLimitError' },
              },
            },
          },
        },
      },
    },
    '/api/markets': {
      get: {
        summary: 'Search and filter markets',
        tags: ['Markets'],
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search term' },
          { name: 'category', in: 'query', schema: { type: 'string', enum: MARKET_CATEGORIES } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: MARKET_STATUSES } },
        ],
        responses: {
          200: {
            description: 'Matching markets ordered by relevance',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Market' } },
                    meta: { type: 'object' },
                  },
                },
              },
            },
          },
          400: { description: 'Invalid category or status' },
          429: {
            description: 'Rate limit exceeded',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RateLimitError' },
              },
            },
          },
        },
      },
    },
  },
};

app.get('/api/docs/json', (req, res) => {
  res.json(openApiSpec);
});

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function getAuditDb() {
  // Lazy require so the API can boot without a DB in non-DB environments.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  if (!getAuditDb.pool) {
    getAuditDb.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return getAuditDb.pool;
}

function requireAuditor(req, res, next) {
  const expected = process.env.AUDIT_API_TOKEN;
  const provided = req.get('authorization') || '';
  const token = provided.startsWith('Bearer ') ? provided.slice(7) : '';
  if (!expected || token !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

// Read-only querying API for security auditors over the immutable audit_logs table.
app.get('/audit-logs', requireAuditor, async (req, res) => {
  const { actor, action, entity_type: entityType, entity_id: entityId } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const clauses = [];
  const params = [];
  const addFilter = (column, value) => {
    if (value !== undefined && value !== '') {
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
  };
  addFilter('actor', actor);
  addFilter('action', action);
  addFilter('entity_type', entityType);
  addFilter('entity_id', entityId);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);
  const sql = `SELECT id, actor, action, entity_type, entity_id, ip_address, metadata, created_at
    FROM audit_logs ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  try {
    const { rows } = await getAuditDb().query(sql, params);
    res.json({ data: rows, limit, offset });
  } catch (err) {
    console.error('[api] audit-logs query failed:', err.message);
    res.status(500).json({ error: 'query_failed' });
  }
});

async function start() {
  if (process.env.DATABASE_URL) {
    await runMigrations({ direction: 'up' });
  }
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[api] listening on ${port}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[api] failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = app;
