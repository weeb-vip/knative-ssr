import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide_storage, freshness, may_serve, request_is_cacheable } from '../src/runtime/policy.js';
import { is_authenticated, lookup_keys, normalise_query } from '../src/runtime/key.js';

const config = {
	defaultTtl: 0,
	defaultSwr: 0,
	maxTtl: 86400,
	varyHeaders: []
};

/** A context with nothing set — what a route that never calls platform.cache gets. */
function ctx(overrides = {}) {
	return { tags: new Set(), noStore: false, public: false, segment: undefined, ...overrides };
}

function res(headers = {}, status = 200) {
	return new Response('<html>hi</html>', { status, headers });
}

// ---------------------------------------------------------------------------
// The rules that stop one user seeing another user's page.
// ---------------------------------------------------------------------------

test('an authenticated request is never stored by default', () => {
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=60' }),
		authenticated: true,
		ctx: ctx(),
		config
	});
	assert.equal(decision, null);
});

test('public() is refused for an authenticated request', () => {
	// A route claiming to be identical for everyone cannot be verified once it
	// has rendered with a logged-in user's data, so the claim is declined rather
	// than trusted.
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=60' }),
		authenticated: true,
		ctx: ctx({ public: true }),
		config
	});
	assert.equal(decision, null);
});

test('public() is honoured for an anonymous request', () => {
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=60' }),
		authenticated: false,
		ctx: ctx({ public: true }),
		config
	});
	assert.equal(decision.segment, 'pub');
	assert.equal(decision.ttl, 60);
});

test('an anonymous request lands in the anon segment, not pub', () => {
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=60' }),
		authenticated: false,
		ctx: ctx(),
		config
	});
	assert.equal(decision.segment, 'anon');
});

test('shared() requires an authenticated request', () => {
	assert.equal(
		decide_storage({
			response: res({ 'cache-control': 's-maxage=60' }),
			authenticated: false,
			ctx: ctx({ segment: 'auth' }),
			config
		}),
		null
	);

	assert.equal(
		decide_storage({
			response: res({ 'cache-control': 's-maxage=60' }),
			authenticated: true,
			ctx: ctx({ segment: 'auth' }),
			config
		}).segment,
		'auth'
	);
});

test('a response setting a cookie is never stored', () => {
	// This is what catches the token-refresh path in hooks.server.ts without the
	// route having to know anything about caching.
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=60', 'set-cookie': 'auth_token=new' }),
		authenticated: false,
		ctx: ctx({ public: true }),
		config
	});
	assert.equal(decision, null);
});

test('cache-control private and no-store are refused', () => {
	for (const value of ['private, s-maxage=60', 'no-store, s-maxage=60']) {
		assert.equal(
			decide_storage({
				response: res({ 'cache-control': value }),
				authenticated: false,
				ctx: ctx({ public: true }),
				config
			}),
			null,
			value
		);
	}
});

test('Vary on cookie, authorization or * is refused', () => {
	for (const value of ['Cookie', 'cookie, accept-encoding', 'Authorization', '*']) {
		assert.equal(
			decide_storage({
				response: res({ 'cache-control': 's-maxage=60', vary: value }),
				authenticated: false,
				ctx: ctx({ public: true }),
				config
			}),
			null,
			value
		);
	}
});

test('Vary on an unkeyed header is refused, on a keyed one allowed', () => {
	const response = res({ 'cache-control': 's-maxage=60', vary: 'Accept-Language' });

	assert.equal(
		decide_storage({ response, authenticated: false, ctx: ctx({ public: true }), config }),
		null,
		'not in varyHeaders'
	);

	assert.equal(
		decide_storage({
			response: res({ 'cache-control': 's-maxage=60', vary: 'Accept-Language' }),
			authenticated: false,
			ctx: ctx({ public: true }),
			config: { ...config, varyHeaders: ['accept-language'] }
		}).segment,
		'pub'
	);
});

test('accept-encoding may be varied on without being keyed', () => {
	// Bodies are stored decoded, so encoding negotiation happens downstream.
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=60', vary: 'Accept-Encoding' }),
		authenticated: false,
		ctx: ctx({ public: true }),
		config
	});
	assert.equal(decision.segment, 'pub');
});

test('non-200 responses are never stored', () => {
	for (const status of [301, 404, 500, 206]) {
		assert.equal(
			decide_storage({
				response: res({ 'cache-control': 's-maxage=60' }, status),
				authenticated: false,
				ctx: ctx({ public: true }),
				config
			}),
			null,
			String(status)
		);
	}
});

test('noStore() overrides everything', () => {
	assert.equal(
		decide_storage({
			response: res({ 'cache-control': 's-maxage=3600' }),
			authenticated: false,
			ctx: ctx({ public: true, ttl: 3600, noStore: true }),
			config
		}),
		null
	);
});

// ---------------------------------------------------------------------------
// Freshness and opt-in
// ---------------------------------------------------------------------------

test('nothing is stored without an explicit TTL when defaultTtl is 0', () => {
	assert.equal(
		decide_storage({ response: res(), authenticated: false, ctx: ctx({ public: true }), config }),
		null
	);
});

test('platform.cache.ttl beats the s-maxage header', () => {
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=10' }),
		authenticated: false,
		ctx: ctx({ public: true, ttl: 300, swr: 600 }),
		config
	});
	assert.equal(decision.ttl, 300);
	assert.equal(decision.swr, 600);
});

test('ttl and swr are clamped to maxTtl', () => {
	const decision = decide_storage({
		response: res(),
		authenticated: false,
		ctx: ctx({ public: true, ttl: 999999, swr: 999999 }),
		config
	});
	assert.equal(decision.ttl, 86400);
	assert.equal(decision.swr, 86400);
});

test('stale-while-revalidate is parsed from the header', () => {
	const decision = decide_storage({
		response: res({ 'cache-control': 's-maxage=60, stale-while-revalidate=600' }),
		authenticated: false,
		ctx: ctx({ public: true }),
		config
	});
	assert.equal(decision.ttl, 60);
	assert.equal(decision.swr, 600);
});

test('freshness moves fresh → stale → expired', () => {
	const entry = { storedAt: Date.now(), ttl: 60, swr: 600 };
	assert.equal(freshness(entry, entry.storedAt), 'fresh');
	assert.equal(freshness(entry, entry.storedAt + 30_000), 'fresh');
	assert.equal(freshness(entry, entry.storedAt + 120_000), 'stale');
	assert.equal(freshness(entry, entry.storedAt + 700_000), 'expired');
});

// ---------------------------------------------------------------------------
// Request eligibility and lookup
// ---------------------------------------------------------------------------

test('only GET and HEAD are cacheable', () => {
	for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
		const request = new Request('https://staging.weeb.vip/', { method });
		assert.equal(request_is_cacheable(request), false, method);
	}
	assert.equal(request_is_cacheable(new Request('https://staging.weeb.vip/')), true);
});

test('an Authorization header is never served from cache', () => {
	const request = new Request('https://staging.weeb.vip/', {
		headers: { authorization: 'Bearer x' }
	});
	assert.equal(request_is_cacheable(request), false);
});

test('may_serve refuses to hand an anon entry to a logged-in request', () => {
	assert.equal(may_serve({ segment: 'anon' }, { authenticated: true }), false);
	assert.equal(may_serve({ segment: 'anon' }, { authenticated: false }), true);
	assert.equal(may_serve({ segment: 'pub' }, { authenticated: true }), true);
	assert.equal(may_serve({ segment: 'auth' }, { authenticated: false }), false);
	assert.equal(may_serve(null, { authenticated: false }), false);
});

test('lookup keys differ by auth state and always try pub first', () => {
	const base = {
		prefix: 'ssr',
		version: '1.0.0',
		host: 'staging.weeb.vip',
		method: 'GET',
		pathname: '/airing',
		query: '',
		varyHash: '0'
	};

	const anon = lookup_keys(base, false);
	const authed = lookup_keys(base, true);

	assert.match(anon[0], /:pub:/);
	assert.match(anon[1], /:anon:/);
	assert.match(authed[1], /:auth:/);
	assert.equal(anon[0], authed[0], 'pub key is shared');
	assert.notEqual(anon[1], authed[1], 'segment keys are distinct');
});

test('auth detection ignores emptied and prefixed cookies', () => {
	const names = ['auth_token', 'access_token'];
	assert.equal(is_authenticated('auth_token=abc', names), true);
	assert.equal(is_authenticated('auth_token=', names), false);
	assert.equal(is_authenticated('auth_token=null', names), false);
	// Word-boundary safety: a different cookie ending in the same name must not
	// count, matching the cookieFromString behaviour in auth-storage.ts.
	assert.equal(is_authenticated('guest_access_token=abc', names), false);
	assert.equal(is_authenticated('', names), false);
});

test('tracking params do not fragment the cache', () => {
	const ignored = ['utm_source', 'gclid'];
	const a = normalise_query(new URLSearchParams('q=naruto&utm_source=x'), ignored);
	const b = normalise_query(new URLSearchParams('utm_source=y&q=naruto&gclid=z'), ignored);
	assert.equal(a, b);
	assert.equal(a, 'q=naruto');
});

test('param order does not change the key', () => {
	assert.equal(
		normalise_query(new URLSearchParams('b=2&a=1'), []),
		normalise_query(new URLSearchParams('a=1&b=2'), [])
	);
});
