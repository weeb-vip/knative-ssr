/**
 * Runtime configuration, resolved from adapter options with env overrides.
 *
 * Every knob is readable from the environment so the Helm chart is the single
 * place deploys are tuned — you should not need to rebuild the image to change
 * a TTL. Env wins over build-time options.
 */

/** Cookies that mean "this request belongs to a logged-in user".
 *  Kept in sync with src/lib/server/auth-cookies.ts in weeb-frontend, and with
 *  CACHE_AUTH_COOKIES in the Helm chart — the Go edge proxy reads the same list
 *  from the same env var so the two tiers cannot disagree about who is authed. */
export const DEFAULT_AUTH_COOKIES = [
	'auth_token',
	'access_token',
	'refresh_token',
	// legacy names, still set by AuthStorage on the client
	'authToken',
	'refreshToken',
	'session',
	'auth',
	'user'
];

/** Query params that never change the rendered output. Stripped from the cache
 *  key so a campaign link doesn't fragment the cache into thousands of copies. */
export const DEFAULT_IGNORED_PARAMS = [
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'utm_id',
	'gclid',
	'fbclid',
	'msclkid',
	'ref',
	'_ga'
];

function env_reader(prefix) {
	return (name, fallback) => {
		const value = process.env[prefix + name];
		return value === undefined || value === '' ? fallback : value;
	};
}

function to_int(value, fallback) {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

function to_bool(value, fallback) {
	if (value === undefined) return fallback;
	return value === 'true' || value === '1' || value === 'yes';
}

function to_list(value, fallback) {
	if (value === undefined) return fallback;
	return value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * @param {{ envPrefix?: string, cache?: object, buildId: string }} options
 */
export function resolve_config({ envPrefix = '', cache = {}, buildId }) {
	const env = env_reader(envPrefix);

	return {
		host: env('HOST', '0.0.0.0'),
		port: to_int(env('PORT'), 3000),
		origin: env('ORIGIN'),
		// Istio sets x-forwarded-host on the way in (see the VirtualService), and
		// the cache key is host-scoped, so getting this wrong fragments the cache.
		hostHeader: env('HOST_HEADER', 'x-forwarded-host'),
		protocolHeader: env('PROTOCOL_HEADER', 'x-forwarded-proto'),
		addressHeader: env('ADDRESS_HEADER', 'x-forwarded-for'),
		xffDepth: to_int(env('XFF_DEPTH'), 1),
		bodySizeLimit: to_int(env('BODY_SIZE_LIMIT'), 512 * 1024),
		shutdownTimeout: to_int(env('SHUTDOWN_TIMEOUT'), 25_000),

		cache: {
			enabled: to_bool(env('CACHE_ENABLED'), cache.enabled ?? true),
			redisUrl: env('CACHE_REDIS_URL', cache.redisUrl ?? 'redis://127.0.0.1:6379'),
			keyPrefix: env('CACHE_KEY_PREFIX', cache.keyPrefix ?? 'ssr'),
			// Overriding this pins the cache namespace across deploys — only do that
			// when you know a release cannot change rendered output.
			version: env('CACHE_VERSION', buildId),

			// 0 means opt-in only: a route caches only when it sets s-maxage or calls
			// platform.cache.ttl(). This is the safe default — turning it on globally
			// caches every route including ones you haven't audited for personalisation.
			defaultTtl: to_int(env('CACHE_DEFAULT_TTL'), cache.defaultTtl ?? 0),
			defaultSwr: to_int(env('CACHE_DEFAULT_SWR'), cache.defaultSwr ?? 0),
			maxTtl: to_int(env('CACHE_MAX_TTL'), cache.maxTtl ?? 86_400),
			maxBodyBytes: to_int(env('CACHE_MAX_BODY_BYTES'), cache.maxBodyBytes ?? 2 * 1024 * 1024),

			authCookies: to_list(env('CACHE_AUTH_COOKIES'), cache.authCookies ?? DEFAULT_AUTH_COOKIES),
			ignoredParams: to_list(env('CACHE_IGNORED_PARAMS'), cache.ignoredParams ?? DEFAULT_IGNORED_PARAMS),
			// Headers we are willing to key on. A response that Varies on anything
			// outside this list is refused rather than cached under a key that
			// ignores the variation.
			varyHeaders: to_list(env('CACHE_VARY_HEADERS'), cache.varyHeaders ?? []),

			// Single-flight: concurrent misses for the same key collapse to one
			// render. Matters most right after a deploy, when the whole namespace is
			// cold and every in-flight request would otherwise hit the GraphQL gateway.
			lockTtl: to_int(env('CACHE_LOCK_TTL'), cache.lockTtl ?? 10_000),
			lockWait: to_int(env('CACHE_LOCK_WAIT'), cache.lockWait ?? 5_000),

			purgeToken: env('CACHE_PURGE_TOKEN', cache.purgeToken),
			adminPath: env('CACHE_ADMIN_PATH', cache.adminPath ?? '/_cache'),

			// Fail-open breaker. If Redis starts erroring we stop calling it for a
			// while rather than adding its timeout to every single request.
			breakerThreshold: to_int(env('CACHE_BREAKER_THRESHOLD'), cache.breakerThreshold ?? 5),
			breakerResetMs: to_int(env('CACHE_BREAKER_RESET_MS'), cache.breakerResetMs ?? 10_000),
			commandTimeout: to_int(env('CACHE_COMMAND_TIMEOUT'), cache.commandTimeout ?? 200),

			debugHeaders: to_bool(env('CACHE_DEBUG_HEADERS'), cache.debugHeaders ?? true)
		}
	};
}
