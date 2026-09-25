// Every Redis key RPN uses, in one place.
//
// The Upstash instance is shared with other apps (their keys look like "resident:…" and
// "testdoc:…"), so every RPN key lives under the "rpn:" namespace and cleanup scripts only ever
// touch patterns that start with it.
//
//   rpn:quota:daily:{storeId}:{YYYY-MM-DD}          remaining box units for the day      (TTL: a few days after the date)
//   rpn:quota:hourly:{storeId}:{YYYY-MM-DD}:{HH}    remaining box units for that hour    (TTL: same)
//   rpn:cache:menu:v{n}                              cached GET /menu list                (TTL: 30 days, dropped on change)
//   rpn:cache:variants:v{n}                          cached GET /variants list            (TTL: 30 days, dropped on change)
//   rpn:wa:{session}:{type}                          WhatsApp (Baileys) auth state         (no TTL)
//
// Bump a cache version when the cached row shape changes, so old entries are simply ignored.

export const REDIS_NAMESPACE = 'rpn';

/** "12:00" / "12:30" / "12" → "12" (hour slots are keyed by hour only; avoids ':' inside a segment). */
export const hourOf = (time: string) => time.split(':')[0].padStart(2, '0');

export const redisKeys = {
    dailyQuota: (storeId: number, date: string) => `${REDIS_NAMESPACE}:quota:daily:${storeId}:${date}`,
    hourlyQuota: (storeId: number, date: string, time: string) => `${REDIS_NAMESPACE}:quota:hourly:${storeId}:${date}:${hourOf(time)}`,
    menuCache: `${REDIS_NAMESPACE}:cache:menu:v1`,
    variantsCache: `${REDIS_NAMESPACE}:cache:variants:v1`,
    /** Prefix for one WhatsApp session's auth keys ("rpn:wa:main" → "rpn:wa:main:creds", …). */
    waSession: (session: string) => `${REDIS_NAMESPACE}:wa:${session}`,
};

/** SCAN patterns for scripts. All of them stay inside the rpn: namespace. */
export const redisPatterns = {
    quota: `${REDIS_NAMESPACE}:quota:*`,
    cache: `${REDIS_NAMESPACE}:cache:*`,
};

/**
 * Keys written before the rpn: namespace existed (2026-09). Only the WhatsApp session still had
 * data when this was introduced; it is renamed on first start (see useRedisAuthState).
 */
export const LEGACY_WA_SESSION_PREFIX = 'rpn-wa-session';
