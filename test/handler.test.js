import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { create_handler } from '../src/runtime/handler.js';
import { resolve_config } from '../src/runtime/config.js';
import { tag_key } from '../src/runtime/key.js';

/**
 * End-to-end tests of the request path against a real HTTP server, with Redis
 * replaced by a Map. Exercises the actual handler — cache lookup, segmentation,
 * storage refusals, purge — rather than the policy functions in isolation.
 */

/** In-memory stand-in for CacheStore with the same surface. */
class FakeStore {
	constructor() {
		this.data = new Map();
		this.tags = new Map();
		this.locks = new Set();
		this.stats = { hit: 0, miss: 0, stale: 0, bypass: 0, stored: 0, purged: 0, errors: 0, revalidations: 0 };
		this.status = 'ready';
	}

	async get(keys) {
		for (const key of keys) {
			const entry = this.data.get(key);
			if (entry) return { key, entry };
		}
		return null;
	}

	async set(key, entry) {
		this.data.set(key, entry);
		this.stats.stored++;
		for (const tag of entry.tags ?? []) {
			const tk = tag_key('ssr', 'test', tag);
			if (!this.tags.has(tk)) this.tags.set(tk, new Set());
			this.tags.get(tk).add(key);
		}
		return true;
	}

	async acquire_lock(key) {
		if (this.locks.has(key)) return false;
		this.locks.add(key);
		return true;
	}

	async release_lock(key) {
		this.locks.delete(key);
	}

	async purge_tags(tags) {
		let removed = 0;
		for (const tag of tags) {
			const tk = tag_key('ssr', 'test', tag);
			for (const key of this.tags.get(tk) ?? []) {
				if (this.data.delete(key)) removed++;
			}
			this.tags.delete(tk);
		}
		this.stats.purged += removed;
		return removed;
	}

	async purge_keys(keys) {
		let removed = 0;
		for (const k of keys) if (this.data.delete(k)) removed++;
		return removed;
	}

	async purge_all() {
		const n = this.data.size;
		this.data.clear();
		this.tags.clear();
		return n;
	}

	async close() {}
}

let server;
let store;
let base;
let renders = 0;

/** Routes under test, keyed by pathname. */
const routes = {
	'/public': (cache) => {
		cache.public().ttl(60).swr(600).tag('shows');
		return new Response('<html>public page</html>', {
			headers: { 'content-type': 'text/html' }
		});
	},
	'/default': () => new Response('<html>uncached by default</html>'),
	'/opted-in': (cache) => {
		cache.ttl(60);
		return new Response('<html>anon-cacheable</html>');
	},
	'/sets-cookie': (cache) => {
		cache.public().ttl(60);
		return new Response('<html>login</html>', {
			headers: { 'set-cookie': 'auth_token=fresh; Path=/' }
		});
	},
	'/short': (cache) => {
		cache.public().ttl(1).swr(60);
		return new Response(`<html>render ${renders}</html>`);
	}
};

before(async () => {
	store = new FakeStore();

	const config = resolve_config({
		envPrefix: '',
		cache: { keyPrefix: 'ssr', purgeToken: 'testtoken', defaultTtl: 0, debugHeaders: true },
		buildId: 'test'
	});
	// resolve_config reads process.env; pin the namespace for the fake store's
	// tag keys regardless of the ambient environment.
	config.cache.version = 'test';

	const fakeServer = {
		async respond(request, { platform }) {
			renders++;
			const url = new URL(request.url);
			const route = routes[url.pathname];
			if (!route) return new Response('not found', { status: 404 });
			return route(platform.cache, request);
		}
	};

	const handler = create_handler({
		server: fakeServer,
		store,
		config,
		buildId: 'test',
		serve_static: null,
		serve_prerendered: null
	});

	server = http.createServer((req, res) => {
		handler(req, res).catch((err) => {
			res.statusCode = 500;
			res.end(String(err));
		});
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });

test('a public route misses then hits', async () => {
	const first = await get('/public');
	assert.equal(first.headers.get('x-cache'), 'MISS');
	assert.equal(await first.text(), '<html>public page</html>');

	const second = await get('/public');
	assert.equal(second.headers.get('x-cache'), 'HIT');
	assert.equal(await second.text(), '<html>public page</html>');
	// The stored entry preserves the original headers.
	assert.equal(second.headers.get('content-type'), 'text/html');
});

test('a logged-in request DOES get a pub entry — that is what public() means', async () => {
	// /public is already cached in `pub` from the previous test. The route
	// declared its output identical for everyone, so sharing it with a logged-in
	// visitor is the intended win, not a leak. This is the case that makes the
	// cache worth having when most traffic is logged in.
	const res = await get('/public', { cookie: 'auth_token=realtoken' });
	assert.equal(res.headers.get('x-cache'), 'HIT');
	assert.equal(await res.text(), '<html>public page</html>');
});

test('a logged-in request cannot read an anon entry', async () => {
	const anon = await get('/opted-in');
	assert.equal(anon.headers.get('x-cache'), 'MISS');
	assert.equal((await get('/opted-in')).headers.get('x-cache'), 'HIT');

	const stored_before = store.data.size;

	// The entry above lives in the `anon` segment, and this route never declared
	// itself public. A logged-in request must not reach it — this is the leak the
	// segmentation design exists to prevent. It renders instead (MISS: the lookup
	// was eligible, a pub entry would have been served, but none exists).
	const authed = await get('/opted-in', { cookie: 'access_token=xyz' });
	assert.equal(authed.headers.get('x-cache'), 'MISS');

	// ...and it must not have written anything, in any segment.
	assert.equal(store.data.size, stored_before, 'authed render must not be stored');

	// The anonymous entry is untouched and still serves anonymous requests.
	assert.equal((await get('/opted-in')).headers.get('x-cache'), 'HIT');
});

test('nothing is cached without an explicit opt-in', async () => {
	assert.equal((await get('/default')).headers.get('x-cache'), 'MISS');
	assert.equal((await get('/default')).headers.get('x-cache'), 'MISS');
});

test('a response setting a cookie is never stored', async () => {
	assert.equal((await get('/sets-cookie')).headers.get('x-cache'), 'MISS');
	assert.equal((await get('/sets-cookie')).headers.get('x-cache'), 'MISS');
});

test('POST is never cached', async () => {
	const res = await fetch(base + '/public', { method: 'POST' });
	assert.equal(res.headers.get('x-cache'), 'BYPASS');
});

test('tracking params do not create a second entry', async () => {
	assert.equal((await get('/public?utm_source=twitter')).headers.get('x-cache'), 'HIT');
	assert.equal((await get('/public?gclid=abc&fbclid=d')).headers.get('x-cache'), 'HIT');
});

test('a distinct query string is a distinct entry', async () => {
	assert.equal((await get('/public?page=2')).headers.get('x-cache'), 'MISS');
	assert.equal((await get('/public?page=2')).headers.get('x-cache'), 'HIT');
});

test('a stale entry is served immediately and revalidated behind it', async () => {
	assert.equal((await get('/short')).headers.get('x-cache'), 'MISS');
	assert.equal((await get('/short')).headers.get('x-cache'), 'HIT');

	await new Promise((r) => setTimeout(r, 1100));

	const before_renders = renders;
	const stale = await get('/short');
	assert.equal(stale.headers.get('x-cache'), 'STALE');

	// The visitor got a response without waiting for the re-render; the
	// revalidation happens behind it.
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(renders > before_renders, 'expected a background revalidation');
});

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

test('health is unauthenticated', async () => {
	const res = await get('/_cache/health');
	assert.equal(res.status, 200);
	assert.equal((await res.json()).status, 'ok');
});

test('purge and stats require the token', async () => {
	assert.equal((await get('/_cache/stats')).status, 401);

	const res = await fetch(base + '/_cache/purge', {
		method: 'POST',
		body: JSON.stringify({ tags: ['shows'] })
	});
	assert.equal(res.status, 401);
});

test('purge by tag evicts the tagged entries', async () => {
	assert.equal((await get('/public')).headers.get('x-cache'), 'HIT');

	const res = await fetch(base + '/_cache/purge', {
		method: 'POST',
		headers: { authorization: 'Bearer testtoken' },
		body: JSON.stringify({ tags: ['shows'] })
	});
	assert.equal(res.status, 200);
	assert.ok((await res.json()).purged > 0);

	assert.equal((await get('/public')).headers.get('x-cache'), 'MISS');
});

test('a wrong token is rejected', async () => {
	const res = await fetch(base + '/_cache/purge', {
		method: 'POST',
		headers: { authorization: 'Bearer wrongtoken' },
		body: JSON.stringify({ tags: ['shows'] })
	});
	assert.equal(res.status, 401);
});
