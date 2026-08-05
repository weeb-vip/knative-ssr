import { createHash } from 'node:crypto';

/**
 * Cache key construction.
 *
 * THIS FILE IS A CONTRACT. The Go edge proxy (edge/key.go) must produce byte
 * -identical keys for the same request, or the proxy will never find anything
 * the SSR pods wrote. Any change here needs the same change there, and the
 * shared test vectors in test/key-vectors.json must be regenerated.
 *
 *   {prefix}:{version}:{segment}:{host}:{method}:{path}?{query}:{varyHash}
 *
 * Segment is the security boundary. Entries for different segments live at
 * different keys, so a logged-in request physically cannot read an entry
 * written for an anonymous one — that isolation is structural rather than a
 * check we could forget to perform.
 */

export const SEGMENT_PUBLIC = 'pub';
export const SEGMENT_ANON = 'anon';
export const SEGMENT_AUTH = 'auth';

/** Parse a Cookie header into a Map. Tolerant of the malformed junk that real
 *  browsers and extensions send — a bad cookie must not throw on the hot path. */
export function parse_cookies(header) {
	const out = new Map();
	if (!header) return out;

	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 1) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (name) out.set(name, value);
	}
	return out;
}

/**
 * Is this request from a logged-in user?
 *
 * Deliberately generous: any of the configured cookies present with a non-empty
 * value counts. A false positive costs a cache miss; a false negative could
 * serve someone else's HTML. The asymmetry decides the default.
 */
export function is_authenticated(cookie_header, auth_cookies) {
	const cookies = parse_cookies(cookie_header);
	for (const name of auth_cookies) {
		const value = cookies.get(name);
		if (value && value !== 'null' && value !== 'undefined' && value !== 'deleted') {
			return true;
		}
	}
	return false;
}

/** Normalise the query string: drop tracking params, sort the rest. Two URLs
 *  that render identically must land on one key. */
export function normalise_query(search_params, ignored) {
	const ignore = new Set(ignored);
	const pairs = [];

	for (const [k, v] of search_params) {
		if (ignore.has(k)) continue;
		pairs.push([k, v]);
	}

	pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));

	return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** Hash of the request values for headers we key on. Empty list → constant. */
export function vary_hash(headers, vary_headers) {
	if (!vary_headers.length) return '0';

	const parts = vary_headers
		.map((h) => h.toLowerCase())
		.sort()
		.map((h) => `${h}=${headers.get(h) ?? ''}`);

	return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** Host the page was rendered for. Cache keys are host-scoped because absolute
 *  URLs and canonical tags in the HTML embed it. */
export function request_host(request, host_header) {
	const headers = request.headers;
	return (headers.get(host_header) || headers.get('host') || 'unknown').toLowerCase();
}

/**
 * Build a cache key for one segment.
 * @returns {string}
 */
export function build_key({ prefix, version, segment, host, method, pathname, query, varyHash }) {
	const suffix = query ? `${pathname}?${query}` : pathname;
	return `${prefix}:${version}:${segment}:${host}:${method}:${suffix}:${varyHash}`;
}

/**
 * The keys to look up for an incoming request, in priority order.
 *
 * Anonymous → [pub, anon]; logged-in → [pub, auth]. One MGET covers both, and
 * `pub` winning means a route that declared itself identical for everyone gets
 * a single shared entry instead of two near-duplicates.
 */
export function lookup_keys(base, authenticated) {
	return [
		build_key({ ...base, segment: SEGMENT_PUBLIC }),
		build_key({ ...base, segment: authenticated ? SEGMENT_AUTH : SEGMENT_ANON })
	];
}

/** Redis key holding the set of cache keys carrying a tag. */
export function tag_key(prefix, version, tag) {
	return `${prefix}:${version}:tag:${tag}`;
}

/** Redis key for the single-flight lock guarding a render. */
export function lock_key(cache_key) {
	return `lock:${cache_key}`;
}
