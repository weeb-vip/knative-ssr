import type { Adapter } from '@sveltejs/kit';

export interface CacheOptions {
	/** Master switch. Default true. */
	enabled?: boolean;
	/** Redis connection string. Default `redis://127.0.0.1:6379`. */
	redisUrl?: string;
	/** Key namespace root. Default `ssr`. */
	keyPrefix?: string;
	/**
	 * Seconds a page stays fresh when the route says nothing.
	 *
	 * Default 0, meaning opt-in only. Raising this caches every route including
	 * ones never audited for personalisation — do it deliberately.
	 */
	defaultTtl?: number;
	/** Default stale-while-revalidate window in seconds. Default 0. */
	defaultSwr?: number;
	/** Ceiling applied to any TTL or SWR value. Default 86400. */
	maxTtl?: number;
	/** Responses larger than this are rendered but not stored. Default 2MiB. */
	maxBodyBytes?: number;
	/** Cookie names that mark a request as logged-in. Must match the Go edge
	 *  proxy's list — the Helm chart sets both from one value. */
	authCookies?: string[];
	/** Query params stripped from the cache key. */
	ignoredParams?: string[];
	/** Request headers the cache key includes. A response varying on anything
	 *  outside this list is refused rather than mis-keyed. Default []. */
	varyHeaders?: string[];
	/** Single-flight lock lifetime, ms. Default 10000. */
	lockTtl?: number;
	/** How long a follower waits for the leader's render, ms. Default 5000. */
	lockWait?: number;
	/** Bearer token for /_cache/purge and /_cache/stats. Admin routes are
	 *  disabled entirely when unset. */
	purgeToken?: string;
	/** Base path for the admin routes. Default `/_cache`. */
	adminPath?: string;
	/** Consecutive Redis failures before the breaker opens. Default 5. */
	breakerThreshold?: number;
	/** How long the breaker stays open, ms. Default 10000. */
	breakerResetMs?: number;
	/** Per-command Redis timeout, ms. Default 200. */
	commandTimeout?: number;
	/** Emit X-Cache / X-Cache-Age response headers. Default true. */
	debugHeaders?: boolean;
}

export interface AdapterOptions {
	/** Output directory. Default `build`. */
	out?: string;
	/** Pre-compress assets with gzip and brotli. Default true. */
	precompress?: boolean;
	/** Prefix for the runtime environment variables. Default ''. */
	envPrefix?: string;
	/** Build-time cache defaults. Every field is overridable at runtime via the
	 *  matching CACHE_* environment variable. */
	cache?: CacheOptions;
}

export default function adapter(options?: AdapterOptions): Adapter;

/**
 * Per-request cache control, exposed to routes as `event.platform.cache`.
 *
 * All methods chain. Absent on platforms other than this adapter, so guard with
 * `event.platform?.cache` if the route also builds for Cloudflare.
 */
export interface CacheControl {
	/** Tag this page for later purge-by-tag. */
	tag(...tags: (string | string[])[]): CacheControl;
	/** Seconds the page stays fresh. */
	ttl(seconds: number): CacheControl;
	/** Seconds past the TTL the page may be served stale while revalidating. */
	swr(seconds: number): CacheControl;
	/** Output is identical for every visitor — cache once, serve to all.
	 *  Honoured only for requests without auth cookies. */
	public(): CacheControl;
	/** Cache separately for logged-in users, shared across all of them. Only
	 *  safe when the page varies by login state but not by which user. */
	shared(): CacheControl;
	/** Cache privately for a single user. */
	user(id: string): CacheControl;
	/** Never store this response. */
	noStore(): CacheControl;
	/** True when this render is a background revalidation rather than a live
	 *  visitor's request. */
	readonly revalidating: boolean;
}

declare global {
	namespace App {
		interface Platform {
			cache?: CacheControl;
			buildId?: string;
		}
	}
}
