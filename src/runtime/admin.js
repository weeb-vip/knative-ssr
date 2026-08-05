import { timingSafeEqual } from 'node:crypto';
import { build_key, SEGMENT_ANON, SEGMENT_AUTH, SEGMENT_PUBLIC } from './key.js';

/**
 * Admin surface: health, stats, and purge.
 *
 * Purge and stats require a bearer token and are disabled outright when none is
 * configured — an open purge endpoint is a free cache-flush DoS, and an open
 * stats endpoint leaks your URL space.
 */

function unauthorised() {
	return json({ error: 'unauthorized' }, 401);
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

function token_matches(provided, expected) {
	if (!provided || !expected) return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	// Length must match before timingSafeEqual, and comparing lengths first is
	// not the leak here — the token length is not the secret.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function authorise(request, config) {
	if (!config.purgeToken) return false;
	const header = request.headers.get('authorization') || '';
	const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
	return token_matches(provided, config.purgeToken);
}

/**
 * @returns {Promise<Response | null>} null when the path isn't ours
 */
export async function handle_admin(request, { store, config, buildId }) {
	const url = new URL(request.url);
	const base = config.adminPath;

	if (!url.pathname.startsWith(base)) return null;

	const route = url.pathname.slice(base.length) || '/';

	// Unauthenticated: Knative's probes need this, and it reveals nothing.
	if (route === '/health' || route === '/healthz') {
		return json({ status: 'ok', build: buildId, cache: store.status });
	}

	if (!config.purgeToken) {
		return json(
			{ error: 'cache admin disabled', hint: 'set CACHE_PURGE_TOKEN to enable' },
			404
		);
	}

	if (!authorise(request, config)) return unauthorised();

	if (route === '/stats') {
		return json({
			build: buildId,
			namespace: `${config.keyPrefix}:${config.version}`,
			redis: store.status,
			stats: store.stats
		});
	}

	if (route === '/purge') {
		if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

		let body;
		try {
			body = await request.json();
		} catch {
			return json({ error: 'invalid json body' }, 400);
		}

		const tags = Array.isArray(body?.tags) ? body.tags.filter((t) => typeof t === 'string') : [];
		const paths = Array.isArray(body?.paths) ? body.paths.filter((p) => typeof p === 'string') : [];
		const host = typeof body?.host === 'string' ? body.host.toLowerCase() : null;

		if (body?.all === true) {
			const removed = await store.purge_all();
			return json({ purged: removed, scope: 'all' });
		}

		if (!tags.length && !paths.length) {
			return json({ error: 'provide tags[], paths[], or all:true' }, 400);
		}

		let purged = 0;
		if (tags.length) purged += await store.purge_tags(tags);

		if (paths.length) {
			if (!host) {
				return json({ error: 'purging by path requires "host"' }, 400);
			}
			// Paths are host- and segment-scoped, so expand each path across every
			// segment it could have been stored under. Cheap: UNLINK on a missing
			// key is a no-op.
			const keys = [];
			for (const p of paths) {
				const [pathname, query = ''] = p.split('?');
				for (const segment of [SEGMENT_PUBLIC, SEGMENT_ANON, SEGMENT_AUTH]) {
					keys.push(
						build_key({
							prefix: config.keyPrefix,
							version: config.version,
							segment,
							host,
							method: 'GET',
							pathname,
							query,
							varyHash: '0'
						})
					);
				}
			}
			purged += await store.purge_keys(keys);
		}

		return json({ purged, tags, paths });
	}

	return json({ error: 'not found' }, 404);
}
