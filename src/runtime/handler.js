import { getRequest, setResponse } from '@sveltejs/kit/node';
import {
	build_key,
	is_authenticated,
	lookup_keys,
	normalise_query,
	request_host,
	SEGMENT_ANON,
	SEGMENT_AUTH,
	vary_hash
} from './key.js';
import { decide_storage, freshness, may_serve, request_is_cacheable } from './policy.js';
import { handle_admin } from './admin.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-request cache control handed to routes as `event.platform.cache`.
 *
 * Mirrors the shape adapter-cloudflare gives you via `platform`, so a route can
 * feature-detect (`event.platform?.cache`) and stay portable — on Cloudflare the
 * property is simply absent and the route renders uncached.
 */
function create_context() {
	const ctx = {
		tags: new Set(),
		ttl: undefined,
		swr: undefined,
		noStore: false,
		public: false,
		segment: undefined,
		revalidating: false
	};

	ctx.api = {
		/** Tag this page so it can be purged by tag later. */
		tag(...tags) {
			for (const t of tags.flat()) if (t) ctx.tags.add(String(t));
			return ctx.api;
		},
		/** Seconds this page stays fresh. */
		ttl(seconds) {
			ctx.ttl = Math.max(0, Number(seconds) || 0);
			return ctx.api;
		},
		/** Seconds past the TTL we may serve stale while revalidating behind it. */
		swr(seconds) {
			ctx.swr = Math.max(0, Number(seconds) || 0);
			return ctx.api;
		},
		/** Declare the output identical for every visitor. Only honoured for
		 *  requests without auth cookies — see resolve_segment in policy.js. */
		public() {
			ctx.public = true;
			return ctx.api;
		},
		/** Cache separately for logged-in users, shared across all of them. Only
		 *  safe when the page varies by login state but not by which user. */
		shared() {
			ctx.segment = SEGMENT_AUTH;
			return ctx.api;
		},
		/** Cache privately for one user. */
		user(id) {
			ctx.segment = `user:${id}`;
			return ctx.api;
		},
		/** Never store this response. */
		noStore() {
			ctx.noStore = true;
			return ctx.api;
		},
		/** True when this render was triggered by a background revalidation, so a
		 *  route can skip work that only matters for a live visitor. */
		get revalidating() {
			return ctx.revalidating;
		}
	};

	return ctx;
}

function client_address(req, config) {
	if (config.addressHeader) {
		const value = req.headers[config.addressHeader.toLowerCase()];
		if (value) {
			const parts = String(value).split(',').map((s) => s.trim());
			// Trust only as many proxies as we're told to; the client controls
			// everything to the left of them.
			const index = parts.length - config.xffDepth;
			return parts[Math.max(0, index)] || req.socket.remoteAddress;
		}
	}
	return req.socket.remoteAddress;
}

function origin_from(req, config) {
	const protocol = req.headers[config.protocolHeader] || 'http';
	const host = req.headers[config.hostHeader] || req.headers.host;
	return `${protocol}://${host}`;
}

/**
 * Run a sirv handler, resolving true if it served the request.
 * sirv calls next() when it has nothing to serve.
 */
function try_static(serve, req, res) {
	if (!serve) return Promise.resolve(false);

	return new Promise((resolve) => {
		let settled = false;

		const done = (served) => {
			if (settled) return;
			settled = true;
			res.removeListener('finish', on_finish);
			res.removeListener('close', on_close);
			resolve(served);
		};

		const on_finish = () => done(true);
		const on_close = () => done(true);

		res.once('finish', on_finish);
		res.once('close', on_close);

		// Registered before invoking, because sirv may respond synchronously.
		serve(req, res, () => done(false));
	});
}

export function create_handler({ server, store, config, buildId, serve_static, serve_prerendered }) {
	const cache_config = config.cache;

	/** Render through SvelteKit, collecting cache directives from the route. */
	async function render(request, { revalidating = false, address } = {}) {
		const ctx = create_context();
		ctx.revalidating = revalidating;

		const response = await server.respond(request, {
			platform: { cache: ctx.api, buildId },
			getClientAddress: () => address ?? '127.0.0.1'
		});

		return { response, ctx };
	}

	/**
	 * Store a rendered response if policy allows.
	 *
	 * Note the response is only buffered when we've decided to store it —
	 * uncacheable routes keep streaming straight through to the client.
	 */
	async function maybe_store(response, ctx, key_base, authenticated) {
		const decision = decide_storage({ response, authenticated, ctx, config: cache_config });
		if (!decision) return;

		const buffered = await response.clone().arrayBuffer();
		if (buffered.byteLength > cache_config.maxBodyBytes) return;

		const headers = {};
		for (const [k, v] of response.headers) {
			// Hop-by-hop and per-response headers must not be replayed to the next
			// visitor. content-encoding especially: we store decoded bytes.
			if (k === 'set-cookie' || k === 'content-encoding' || k === 'content-length') continue;
			headers[k] = v;
		}

		await store.set(build_key({ ...key_base, segment: decision.segment }), {
			status: response.status,
			headers,
			body: Buffer.from(buffered),
			segment: decision.segment,
			ttl: decision.ttl,
			swr: decision.swr,
			tags: decision.tags,
			storedAt: Date.now(),
			build: cache_config.version
		});
	}

	/** Stable lock name for a request, independent of which segment it ends up
	 *  stored in — two concurrent misses must contend on the same lock. */
	function lock_name(key_base, authenticated) {
		return build_key({ ...key_base, segment: authenticated ? SEGMENT_AUTH : SEGMENT_ANON });
	}

	/** Re-render in the background and refresh the entry. Best-effort. */
	async function revalidate(request, key_base, authenticated, address) {
		const name = lock_name(key_base, authenticated);
		if (!(await store.acquire_lock(name))) return;

		store.stats.revalidations++;
		try {
			const clone = new Request(request.url, { method: 'GET', headers: request.headers });
			const { response, ctx } = await render(clone, { revalidating: true, address });
			await maybe_store(response, ctx, key_base, authenticated);
		} catch (err) {
			console.warn(`[cache] revalidation failed for ${key_base.pathname}: ${err.message}`);
		} finally {
			await store.release_lock(name);
		}
	}

	function cached_response(entry, state) {
		const headers = new Headers(entry.headers);
		if (cache_config.debugHeaders) {
			headers.set('x-cache', state);
			headers.set('x-cache-age', String(Math.round((Date.now() - entry.storedAt) / 1000)));
		}
		return new Response(entry.body, { status: entry.status, headers });
	}

	function with_cache_header(response, state) {
		if (!cache_config.debugHeaders) return response;
		const headers = new Headers(response.headers);
		headers.set('x-cache', state);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}

	return async function handler(req, res) {
		// Static assets and prerendered pages come off disk and never touch Redis
		// — they're already immutable and content-hashed.
		if (await try_static(serve_static, req, res)) return;
		if (await try_static(serve_prerendered, req, res)) return;

		let request;
		try {
			request = await getRequest({
				base: config.origin || origin_from(req, config),
				request: req,
				bodySizeLimit: config.bodySizeLimit
			});
		} catch (err) {
			res.statusCode = err?.status || 400;
			res.end('Bad Request');
			return;
		}

		const address = client_address(req, config);

		const admin = await handle_admin(request, { store, config: cache_config, buildId });
		if (admin) return setResponse(res, admin);

		const authenticated = is_authenticated(request.headers.get('cookie'), cache_config.authCookies);

		const url = new URL(request.url);
		const key_base = {
			prefix: cache_config.keyPrefix,
			version: cache_config.version,
			host: request_host(request, config.hostHeader),
			method: 'GET',
			pathname: url.pathname,
			query: normalise_query(url.searchParams, cache_config.ignoredParams),
			varyHash: vary_hash(request.headers, cache_config.varyHeaders)
		};

		const eligible = cache_config.enabled && request_is_cacheable(request);

		if (!eligible) {
			store.stats.bypass++;
			const { response } = await render(request, { address });
			return setResponse(res, with_cache_header(response, 'BYPASS'));
		}

		const keys = lookup_keys(key_base, authenticated);
		const found = await store.get(keys);

		if (found && may_serve(found.entry, { authenticated })) {
			const state = freshness(found.entry, Date.now());

			if (state === 'fresh') {
				store.stats.hit++;
				return setResponse(res, cached_response(found.entry, 'HIT'));
			}

			if (state === 'stale') {
				store.stats.stale++;
				// Serve immediately, refresh behind the response — the visitor pays
				// nothing for the staleness.
				revalidate(request, key_base, authenticated, address).catch(() => {});
				return setResponse(res, cached_response(found.entry, 'STALE'));
			}
		}

		store.stats.miss++;

		// Single-flight. Right after a deploy the whole namespace is cold, and
		// without this every concurrent request for the same page renders and hits
		// the GraphQL gateway. The winner renders; the losers wait briefly for the
		// entry to land, then give up and render themselves — a stuck holder must
		// never turn into a stalled request.
		const name = lock_name(key_base, authenticated);
		const leader = await store.acquire_lock(name);

		if (!leader) {
			const deadline = Date.now() + cache_config.lockWait;
			while (Date.now() < deadline) {
				await sleep(50);
				const retry = await store.get(keys);
				if (retry && may_serve(retry.entry, { authenticated })) {
					if (freshness(retry.entry, Date.now()) !== 'expired') {
						store.stats.hit++;
						return setResponse(res, cached_response(retry.entry, 'HIT'));
					}
				}
			}
		}

		try {
			const { response, ctx } = await render(request, { address });
			await maybe_store(response, ctx, key_base, authenticated);
			return setResponse(res, with_cache_header(response, 'MISS'));
		} finally {
			if (leader) await store.release_lock(name);
		}
	};
}
