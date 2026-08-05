import { SEGMENT_ANON, SEGMENT_AUTH, SEGMENT_PUBLIC } from './key.js';

/**
 * Decides what may be cached, and for how long.
 *
 * Everything here is biased towards refusing to store. A missed caching
 * opportunity is a slow page; a wrong one serves a logged-in user's HTML to a
 * stranger. The rules below are the only thing standing between those.
 */

/** @param {string | null} value */
export function parse_cache_control(value) {
	const directives = new Map();
	if (!value) return directives;

	for (const part of value.split(',')) {
		const eq = part.indexOf('=');
		if (eq === -1) {
			directives.set(part.trim().toLowerCase(), true);
		} else {
			directives.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
		}
	}
	return directives;
}

function seconds(directives, name) {
	const raw = directives.get(name);
	if (raw === undefined || raw === true) return undefined;
	const n = Number.parseInt(String(raw).replace(/"/g, ''), 10);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Can we even consider caching this request? Cheap checks, run before render.
 */
export function request_is_cacheable(request) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;

	// A client that explicitly asked to skip the cache gets a fresh render, but
	// note this does NOT let a client poison the cache — we still store the
	// result normally, we just don't serve a stored one.
	const cc = parse_cache_control(request.headers.get('cache-control'));
	if (cc.has('no-cache') || cc.has('no-store')) return false;

	// An Authorization header means an API-style authenticated request. Those are
	// never cached under a shared segment and we don't have a segment for them.
	if (request.headers.has('authorization')) return false;

	return true;
}

/**
 * Decide whether to store the rendered response, in which segment, and with
 * what freshness. Returns null to refuse.
 *
 * @param {object} args
 * @param {Response} args.response
 * @param {boolean} args.authenticated  request carried an auth cookie
 * @param {object} args.ctx             per-request overrides from platform.cache
 * @param {object} args.config          resolved cache config
 */
export function decide_storage({ response, authenticated, ctx, config }) {
	// --- hard refusals, in order of how badly they'd bite -------------------

	// A route said no. Always wins.
	if (ctx.noStore) return null;

	// Only successful, complete responses. 206/304 have no full body to store,
	// and error pages should not be pinned for a TTL.
	if (response.status !== 200) return null;

	// Setting a cookie means the response is establishing or refreshing state
	// specific to this caller. Storing it would hand that state to whoever gets
	// the entry next. This catches the token-refresh path in hooks.server.ts
	// without the route needing to know anything about caching.
	if (response.headers.has('set-cookie')) return null;

	const cc = parse_cache_control(response.headers.get('cache-control'));
	if (cc.has('no-store') || cc.has('private')) return null;

	// Vary on anything we don't key on would mean storing one variant and
	// serving it to requests that should have received another. Cookie is called
	// out separately because it is the one that would leak rather than merely
	// mis-serve.
	const vary = (response.headers.get('vary') || '')
		.split(',')
		.map((v) => v.trim().toLowerCase())
		.filter(Boolean);

	if (vary.includes('*') || vary.includes('cookie') || vary.includes('authorization')) return null;

	const keyed = new Set([...config.varyHeaders.map((h) => h.toLowerCase()), 'accept-encoding']);
	for (const header of vary) {
		// accept-encoding is safe to ignore: we store bodies uncompressed and let
		// the proxy or Istio negotiate encoding on the way out.
		if (!keyed.has(header)) return null;
	}

	// --- segment ------------------------------------------------------------

	const segment = resolve_segment({ authenticated, ctx });
	if (!segment) return null;

	// --- freshness ----------------------------------------------------------

	const ttl = ctx.ttl ?? seconds(cc, 's-maxage') ?? config.defaultTtl;
	if (!ttl || ttl <= 0) return null;

	const swr = ctx.swr ?? seconds(cc, 'stale-while-revalidate') ?? config.defaultSwr;

	return {
		segment,
		ttl: Math.min(ttl, config.maxTtl),
		swr: Math.max(0, Math.min(swr ?? 0, config.maxTtl)),
		tags: [...ctx.tags]
	};
}

/**
 * Which segment may this response be stored in?
 *
 * The one rule that matters: a response rendered for a logged-in user never
 * lands in `pub` or `anon`. A route can declare itself public, but that
 * declaration is only honoured for requests that had no auth cookie — otherwise
 * a single mis-annotated route would leak on the first logged-in request.
 */
function resolve_segment({ authenticated, ctx }) {
	if (ctx.segment) {
		// Explicit per-user segment: isolated by construction, always allowed.
		if (ctx.segment.startsWith('user:')) return ctx.segment;

		if (ctx.segment === SEGMENT_AUTH) return authenticated ? SEGMENT_AUTH : null;

		if (ctx.segment === SEGMENT_PUBLIC) return authenticated ? null : SEGMENT_PUBLIC;
	}

	if (ctx.public) {
		// `public()` means "identical for everyone". Rendered anonymously it is
		// safe to share; rendered for a logged-in user we cannot verify the claim,
		// so we decline rather than trust it.
		return authenticated ? null : SEGMENT_PUBLIC;
	}

	// Default: an authed request is not cached at all. An anonymous one is cached
	// in its own segment, where no logged-in request will ever read it.
	return authenticated ? null : SEGMENT_ANON;
}

/**
 * May we serve this stored entry to this request?
 *
 * Belt-and-braces. Segment isolation already makes the wrong entry unreachable
 * by key, so this should never fire — but it is the check that turns a future
 * key-format bug into a cache miss instead of a data leak.
 */
export function may_serve(entry, { authenticated }) {
	if (!entry) return false;
	if (entry.segment === SEGMENT_PUBLIC) return true;
	if (entry.segment === SEGMENT_ANON) return !authenticated;
	if (entry.segment === SEGMENT_AUTH) return authenticated;
	if (entry.segment?.startsWith('user:')) return authenticated;
	return false;
}

/** Freshness of a stored entry, given the clock. */
export function freshness(entry, now) {
	const age = (now - entry.storedAt) / 1000;
	if (age <= entry.ttl) return 'fresh';
	if (age <= entry.ttl + entry.swr) return 'stale';
	return 'expired';
}
