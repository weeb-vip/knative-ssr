import Redis from 'ioredis';
import { lock_key, tag_key } from './key.js';

/**
 * Redis-backed entry store.
 *
 * Fail-open is the whole design brief: Redis being down must degrade the site
 * to "uncached SSR", never to "down". Every method swallows its errors and
 * reports a miss, and a breaker stops us paying the connect/command timeout on
 * every request once Redis is clearly unhealthy.
 */
export class CacheStore {
	/** @param {ReturnType<import('./config.js').resolve_config>['cache']} config */
	constructor(config) {
		this.config = config;
		this.enabled = config.enabled;
		this.failures = 0;
		this.open_until = 0;

		this.stats = {
			hit: 0,
			miss: 0,
			stale: 0,
			bypass: 0,
			stored: 0,
			purged: 0,
			errors: 0,
			revalidations: 0
		};

		if (!this.enabled) {
			this.redis = null;
			return;
		}

		this.redis = new Redis(config.redisUrl, {
			lazyConnect: true,
			// Never queue commands while disconnected — a queued command is latency
			// we are adding to a request that could have been served by rendering.
			enableOfflineQueue: false,
			maxRetriesPerRequest: 1,
			connectTimeout: 1000,
			commandTimeout: config.commandTimeout,
			retryStrategy: (times) => Math.min(times * 200, 5000),
			reconnectOnError: () => true
		});

		this.redis.on('error', (err) => {
			this.#record_failure();
			// ioredis is chatty while a pod waits for Redis to come up; one line per
			// transition is enough to diagnose without drowning the logs.
			if (this.failures <= 1 || this.failures % 50 === 0) {
				console.warn(`[cache] redis error (${this.failures}): ${err.message}`);
			}
		});

		this.redis.on('ready', () => {
			if (this.failures) console.log('[cache] redis recovered');
			this.failures = 0;
			this.open_until = 0;
		});

		this.redis.connect().catch(() => {
			// Connection failures are handled by the error handler and the breaker;
			// startup must not block on Redis being reachable.
		});
	}

	#record_failure() {
		this.stats.errors++;
		this.failures++;
		if (this.failures >= this.config.breakerThreshold) {
			this.open_until = Date.now() + this.config.breakerResetMs;
		}
	}

	/** True when we should skip Redis entirely right now. */
	get tripped() {
		return !this.enabled || !this.redis || Date.now() < this.open_until;
	}

	get status() {
		if (!this.enabled) return 'disabled';
		if (Date.now() < this.open_until) return 'breaker-open';
		return this.redis?.status ?? 'unknown';
	}

	/**
	 * Fetch the first present entry among `keys`, preserving priority order.
	 * One MGET, so checking both the `pub` and segment-specific key costs the
	 * same as checking one.
	 */
	async get(keys) {
		if (this.tripped) return null;

		try {
			const raw = await this.redis.mget(...keys);
			for (let i = 0; i < raw.length; i++) {
				if (!raw[i]) continue;
				const entry = this.#deserialise(raw[i]);
				if (entry) return { key: keys[i], entry };
			}
			return null;
		} catch (err) {
			this.#record_failure();
			return null;
		}
	}

	#deserialise(raw) {
		try {
			const parsed = JSON.parse(raw);
			parsed.body = Buffer.from(parsed.body, 'base64');
			return parsed;
		} catch {
			// A corrupt entry is a miss, not an error worth failing the request over.
			return null;
		}
	}

	/**
	 * Store an entry and index its tags.
	 *
	 * The key lives for ttl+swr so stale-while-revalidate has something to serve;
	 * freshness within that window is decided by the caller from storedAt.
	 */
	async set(key, entry) {
		if (this.tripped) return false;

		const total_ms = (entry.ttl + entry.swr) * 1000;

		try {
			const payload = JSON.stringify({
				...entry,
				body: Buffer.from(entry.body).toString('base64')
			});

			const pipeline = this.redis.pipeline();
			pipeline.set(key, payload, 'PX', total_ms);

			for (const tag of entry.tags ?? []) {
				const tk = tag_key(this.config.keyPrefix, this.config.version, tag);
				pipeline.sadd(tk, key);
				// Tag sets outlive their members slightly; without this a tag set for
				// a hot page would accumulate dead keys forever.
				pipeline.pexpire(tk, Math.max(total_ms, 60_000));
			}

			await pipeline.exec();
			this.stats.stored++;
			return true;
		} catch (err) {
			this.#record_failure();
			return false;
		}
	}

	/**
	 * Single-flight guard. The winner renders; losers fall through to rendering
	 * themselves rather than blocking, because a stuck holder must never turn
	 * into a stalled request.
	 */
	async acquire_lock(key) {
		if (this.tripped) return false;
		try {
			const result = await this.redis.set(lock_key(key), '1', 'PX', this.config.lockTtl, 'NX');
			return result === 'OK';
		} catch {
			this.#record_failure();
			return false;
		}
	}

	async release_lock(key) {
		if (this.tripped) return;
		try {
			await this.redis.del(lock_key(key));
		} catch {
			this.#record_failure();
		}
	}

	/** Purge every key carrying any of `tags`. Returns the number removed. */
	async purge_tags(tags) {
		if (this.tripped) return 0;

		let removed = 0;
		try {
			for (const tag of tags) {
				const tk = tag_key(this.config.keyPrefix, this.config.version, tag);
				const keys = await this.redis.smembers(tk);
				if (keys.length) {
					// UNLINK reclaims memory on a background thread — purging a tag
					// covering thousands of pages shouldn't stall Redis for everyone.
					removed += await this.redis.unlink(...keys);
				}
				await this.redis.unlink(tk);
			}
			this.stats.purged += removed;
			return removed;
		} catch (err) {
			this.#record_failure();
			return removed;
		}
	}

	/** Purge specific paths across every segment. */
	async purge_keys(keys) {
		if (this.tripped || !keys.length) return 0;
		try {
			const removed = await this.redis.unlink(...keys);
			this.stats.purged += removed;
			return removed;
		} catch {
			this.#record_failure();
			return 0;
		}
	}

	/** Drop the entire namespace for the current build. Scans rather than using
	 *  KEYS so a large cache doesn't block Redis. */
	async purge_all() {
		if (this.tripped) return 0;

		const pattern = `${this.config.keyPrefix}:${this.config.version}:*`;
		let removed = 0;

		try {
			let cursor = '0';
			do {
				const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
				cursor = next;
				if (keys.length) removed += await this.redis.unlink(...keys);
			} while (cursor !== '0');

			this.stats.purged += removed;
			return removed;
		} catch {
			this.#record_failure();
			return removed;
		}
	}

	async close() {
		if (!this.redis) return;
		try {
			await this.redis.quit();
		} catch {
			this.redis.disconnect();
		}
	}
}
