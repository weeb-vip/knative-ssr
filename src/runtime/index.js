import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { resolve_config } from './config.js';
import { CacheStore } from './store.js';
import { create_handler } from './handler.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

const IMMUTABLE = 'public, max-age=31536000, immutable';

function static_handler(root, { immutable_prefix }) {
	if (!fs.existsSync(root)) return null;

	return sirv(root, {
		etag: true,
		gzip: true,
		brotli: true,
		extensions: [],
		setHeaders: (res, pathname) => {
			// Vite emits content-hashed filenames under _app/immutable, so these can
			// be cached forever. Everything else in client/ (favicon, robots.txt,
			// manifest) is stable-named and must stay revalidatable.
			if (immutable_prefix && pathname.startsWith(immutable_prefix)) {
				res.setHeader('cache-control', IMMUTABLE);
			}
		}
	});
}

/**
 * Boot the SSR server. Called by the generated entry point.
 *
 * @param {object} args
 * @param {new (manifest: any) => any} args.Server
 * @param {any} args.manifest
 * @param {Set<string>} args.prerendered
 * @param {string} args.base
 * @param {string} args.buildId
 * @param {string} args.envPrefix
 * @param {object} args.cache
 */
export async function start({ Server, manifest, prerendered, base, buildId, envPrefix, cache }) {
	const config = resolve_config({ envPrefix, cache, buildId });

	const server = new Server(manifest);
	await server.init({ env: process.env });

	const store = new CacheStore(config.cache);

	const handler = create_handler({
		server,
		store,
		config,
		buildId,
		serve_static: static_handler(path.join(dir, 'client'), {
			immutable_prefix: `${base}/_app/immutable`
		}),
		serve_prerendered: static_handler(path.join(dir, 'prerendered'), {})
	});

	const http_server = http.createServer((req, res) => {
		handler(req, res).catch((err) => {
			console.error('[ssr] unhandled error:', err);
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader('content-type', 'text/plain');
			}
			if (!res.writableEnded) res.end('Internal Error');
		});
	});

	// Knative's activator can hold a connection open while a pod starts; the
	// default 5s keep-alive timeout closes those from under it and surfaces as
	// sporadic 502s under load.
	http_server.keepAliveTimeout = 65_000;
	http_server.headersTimeout = 70_000;

	http_server.listen(config.port, config.host, () => {
		console.log(
			`[ssr] listening on ${config.host}:${config.port} — ` +
				`build ${buildId}, cache namespace ${config.cache.keyPrefix}:${config.cache.version}, ` +
				`cache ${config.cache.enabled ? 'enabled' : 'disabled'}`
		);
		if (config.cache.enabled && config.cache.defaultTtl === 0) {
			console.log('[cache] default TTL is 0 — routes must opt in via platform.cache or s-maxage');
		}
	});

	// --- graceful shutdown --------------------------------------------------
	// Knative sends SIGTERM and then waits out the revision's timeout. Draining
	// properly is what keeps a scale-down from cutting live requests.
	let shutting_down = false;

	const shutdown = async (signal) => {
		if (shutting_down) return;
		shutting_down = true;
		console.log(`[ssr] ${signal} received, draining`);

		const forced = setTimeout(() => {
			console.warn('[ssr] drain timed out, exiting anyway');
			process.exit(0);
		}, config.shutdownTimeout);
		forced.unref();

		http_server.close(async () => {
			await store.close();
			clearTimeout(forced);
			console.log('[ssr] drained, exiting');
			process.exit(0);
		});

		// Stop keeping idle connections alive so the drain can actually finish.
		http_server.closeIdleConnections?.();
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));

	process.on('unhandledRejection', (err) => {
		console.error('[ssr] unhandled rejection:', err);
	});

	return { server: http_server, store, config };
}

export default start;
