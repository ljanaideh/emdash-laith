---
name: hyperdrive-postgresql
description: Debug and fix EmDash deployments on Cloudflare Workers with Hyperdrive + PostgreSQL. Use when hitting connection hangs, stale read bugs, duplicate key errors during seed, setup wizard failures, or passkey auth errors on Cloudflare Workers.
---

# Hyperdrive + PostgreSQL Deployment Skill

You are helping debug or set up EmDash running on Cloudflare Workers with Cloudflare Hyperdrive connecting to a PostgreSQL database (AWS RDS, Supabase, Neon, etc.).

## Architecture

```
Browser → Cloudflare Worker → Hyperdrive (edge pool) → PostgreSQL
```

Hyperdrive maintains warm connections at the edge. The Worker creates a fresh `pg.Client` per query (not a Pool) — re-reading `env.HYPERDRIVE.connectionString` each time to handle CS rotation.

## The One Rule That Explains Most Bugs

**Hyperdrive caches non-transactional reads for ~60 seconds.**

Any `SELECT` that is not inside `BEGIN...COMMIT` is served from a read replica cache. This is invisible in development (SQLite has no cache) and only shows up in production.

**Pattern that breaks:**
1. Request A writes a value
2. Request B reads it → gets cached stale value → takes wrong branch

**Fix:** wrap every read that follows a recent write in `withTransaction`:

```ts
// WRONG
const row = await db.selectFrom("options").where("name", "=", "key").executeTakeFirst();

// RIGHT — transaction bypasses Hyperdrive cache
const row = await withTransaction(db, (trx) =>
  trx.selectFrom("options").where("name", "=", "key").executeTakeFirst()
);
```

## Diagnosing Common Errors

### Setup wizard fails mid-flow / collection not found after creation

**Cause:** `createField` or `applySeed` does a non-transactional existence check after a recent write.

**Fix:** All reads inside `createCollection`, `createField`, and `applySeed` must use `withTransaction`. Pre-check SELECTs must be replaced with INSERT-then-catch-duplicate.

```ts
// WRONG — SELECT served from cache, INSERT duplicates
const existing = await db.selectFrom("t").where("slug", "=", slug).executeTakeFirst();
if (!existing) await db.insertInto("t").values({...}).execute();

// RIGHT
try {
  await db.insertInto("t").values({...}).execute();
} catch (err) {
  if (isDuplicateKeyError(err)) return;
  throw err;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  return (
    e.code === "23505" ||
    e.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    e.message.includes("UNIQUE constraint failed")
  );
}
```

### Passkey verify returns 400 on first attempt ("needs to create the key twice")

**Cause:** `admin-verify.ts` reads `emdash:setup_state` non-transactionally. Hyperdrive serves stale null → step check fails.

**Fix:** Wrap all three guard reads (`setup_complete`, `userCount`, `setup_state`) in a single `withTransaction` at the top of the POST handler.

### Setup redirect loop after successful verify

**Cause:** `middleware/setup.ts` reads `emdash:setup_complete` non-transactionally. After verify sets it to true, the middleware still sees cached null and redirects back to setup.

**Fix:** Wrap `setup_complete` and `userCount` reads in `withTransaction` in the setup middleware.

### SQL syntax error: `syntax error at or near "window"`

**Cause:** `window` is a PostgreSQL reserved keyword. Works unquoted in SQLite, breaks in PostgreSQL.

**Fix:** Quote it in all raw SQL:
```sql
-- WRONG
INSERT INTO _emdash_rate_limits (key, window, count) ...
ON CONFLICT (key, window) DO UPDATE ...

-- RIGHT
INSERT INTO _emdash_rate_limits (key, "window", count) ...
ON CONFLICT (key, "window") DO UPDATE ...
```

Check every raw SQL string for other reserved keywords: `order`, `group`, `user`, `table`, `index`, `select`, `where`, etc.

### Worker hangs on DB connect (no timeout, no error)

**Cause:** A cached `pg.Pool` baked in a stale Hyperdrive `connectionString`. Subsequent `connect()` calls hang indefinitely in Workers Node.js compat layer.

**Fix:** Use a fresh `pg.Client` per query, not a module-scoped Pool. The `hyperdrive.ts` dialect does this — never revert to a Pool singleton.

### Duplicate key errors during seed (`_emdash_collections`, `_emdash_taxonomy_defs`, `taxonomies`)

**Cause:** Seed ran partially before, or Hyperdrive cached the pre-check SELECT as null, causing a second INSERT.

**Fix:**
1. Clean up the partial DB state
2. Switch from SELECT-then-INSERT to INSERT-then-catch-duplicate (see above)
3. All seed reads must use `withTransaction`

## Files to Check for Hyperdrive Cache Bugs

When a read returns stale data after a write, check these files in order:

| File | Reads that need `withTransaction` |
|---|---|
| `packages/core/src/schema/registry.ts` | Collection existence in `createCollection`; all reads in `createField` |
| `packages/core/src/seed/apply.ts` | Collection, taxonomy def, and term existence checks |
| `packages/core/src/astro/routes/api/setup/admin-verify.ts` | `setup_complete`, `userCount`, `setup_state` |
| `packages/core/src/astro/middleware/setup.ts` | `setup_complete`, `userCount` |
| `packages/core/src/astro/routes/api/setup/status.ts` | `setup_complete`, `userCount`, `setup_state` |
| `packages/core/src/astro/routes/api/setup/index.ts` | `setup_complete` guard |

## Setup Checklist (Fresh Deployment)

```
1. AWS RDS: PostgreSQL 15+, port 5432 open, publicly accessible
2. Hyperdrive: `npx wrangler hyperdrive create` → save ID
3. wrangler.jsonc: add hyperdrive binding
4. astro.config.mjs: use hyperdrive() with pool.min=2, pool.max=5, timeouts
5. .dev.vars: HYPERDRIVE_LOCAL_CONNECTION_STRING
6. npx wrangler types  →  worker-configuration.d.ts
7. npx wrangler deploy
8. Visit /_emdash/admin/setup in a REGULAR browser window (not incognito)
```

## Pool Sizing Formula

```
(pods × processes × pool.max) + background + admin  <  max_connections × 0.7

Safe defaults:  pool.min=2, pool.max=5
Max pods at max_connections=200:  ~18 pods before PgBouncer needed
```

## PostgreSQL Server Settings

```ini
max_connections = 200
statement_timeout = 30000
idle_in_transaction_session_timeout = 10000
shared_buffers = 256MB
work_mem = 8MB
```

## Import Path Gotcha

In `packages/core/src/astro/middleware/`, the `#db/*` alias is NOT available. Use relative paths:

```ts
// WRONG (alias not resolved in middleware build)
import { withTransaction } from "#db/transaction.js";

// RIGHT
import { withTransaction } from "../../database/transaction.js";
```

`#db/*` maps to `src/database/*` — the directory is `database`, not `db`.

## Passkey Notes

- Passkey registration **does not work in incognito/private browsing**. Chrome/Edge do not save credentials to the OS store in incognito.
- Always use a regular browser window for setup wizard and initial login.
- After DB cleanup between test runs, also clear saved passkeys from the browser's password manager.

## DB Cleanup SQL (Between Test Runs)

```sql
DELETE FROM _emdash_fields;
DELETE FROM _emdash_collections WHERE slug IN ('posts', 'pages');
DROP TABLE IF EXISTS ec_posts;
DROP TABLE IF EXISTS ec_pages;
DELETE FROM _emdash_taxonomy_defs;
DELETE FROM taxonomies;
DELETE FROM options WHERE name IN ('emdash:setup_complete', 'emdash:setup_state', 'emdash:site_title', 'emdash:site_url');
DELETE FROM users;
DELETE FROM credentials;
DELETE FROM auth_tokens;
DELETE FROM auth_challenges;
DELETE FROM _emdash_rate_limits;
```
