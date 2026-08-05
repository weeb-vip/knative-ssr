package main

import (
	"context"
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Entry is the wire format written by the SvelteKit adapter's CacheStore.
// Field names and the base64 body encoding must match src/runtime/store.js.
type Entry struct {
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	Body     []byte            `json:"body"` // base64 in JSON, decoded by encoding/json
	Segment  string            `json:"segment"`
	TTL      int64             `json:"ttl"`
	SWR      int64             `json:"swr"`
	Tags     []string          `json:"tags"`
	StoredAt int64             `json:"storedAt"` // ms since epoch
	Build    string            `json:"build"`
}

type Freshness int

const (
	Fresh Freshness = iota
	Stale
	Expired
)

func (e *Entry) freshness(now time.Time) Freshness {
	age := (now.UnixMilli() - e.StoredAt) / 1000
	switch {
	case age <= e.TTL:
		return Fresh
	case age <= e.TTL+e.SWR:
		return Stale
	default:
		return Expired
	}
}

// mayServe mirrors policy.js. Segment isolation already makes a wrong-segment
// entry unreachable by key; this is the check that turns a future key-format
// bug into a cache miss rather than a data leak.
func (e *Entry) mayServe(authenticated bool) bool {
	switch {
	case e.Segment == SegmentPublic:
		return true
	case e.Segment == SegmentAnon:
		return !authenticated
	case e.Segment == SegmentAuth:
		return authenticated
	case len(e.Segment) > 5 && e.Segment[:5] == "user:":
		// The proxy has no user identity to compare against, so it never serves
		// per-user entries. Those requests fall through to the SSR pod, which does.
		return false
	default:
		return false
	}
}

// Cache is a read-mostly view of Redis. The proxy never writes entries — the
// adapter is the only writer, because it is the only side that knows the tags
// and the TTL. The proxy only takes revalidation locks.
type Cache struct {
	rdb       *redis.Client
	cfg       Config
	failures  atomic.Int64
	openUntil atomic.Int64 // unix ms; breaker is open until then
}

func NewCache(cfg Config) (*Cache, error) {
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, err
	}

	// Fail fast and fail open. A slow Redis must not be worse than no Redis:
	// every millisecond spent waiting here is added to a request we could
	// already have proxied upstream.
	opts.DialTimeout = time.Second
	opts.ReadTimeout = cfg.RedisTimeout
	opts.WriteTimeout = cfg.RedisTimeout
	opts.PoolSize = 50
	opts.MinIdleConns = 5

	return &Cache{rdb: redis.NewClient(opts), cfg: cfg}, nil
}

const breakerThreshold = 5
const breakerReset = 10 * time.Second

func (c *Cache) tripped() bool {
	return time.Now().UnixMilli() < c.openUntil.Load()
}

func (c *Cache) recordFailure(err error) {
	if err == redis.Nil {
		return
	}
	n := c.failures.Add(1)
	if n >= breakerThreshold {
		c.openUntil.Store(time.Now().Add(breakerReset).UnixMilli())
	}
	if n == 1 || n%50 == 0 {
		log.Printf("[cache] redis error (%d): %v", n, err)
	}
}

func (c *Cache) recordSuccess() {
	if c.failures.Swap(0) >= breakerThreshold {
		log.Print("[cache] redis recovered")
	}
	c.openUntil.Store(0)
}

// Get returns the first present entry among keys, preserving priority order.
func (c *Cache) Get(ctx context.Context, keys []string) (*Entry, bool) {
	if c.tripped() {
		return nil, false
	}

	ctx, cancel := context.WithTimeout(ctx, c.cfg.RedisTimeout)
	defer cancel()

	vals, err := c.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		c.recordFailure(err)
		return nil, false
	}
	c.recordSuccess()

	for _, v := range vals {
		s, ok := v.(string)
		if !ok || s == "" {
			continue
		}
		var e Entry
		if err := json.Unmarshal([]byte(s), &e); err != nil {
			// A corrupt entry is a miss, not something to fail the request over.
			continue
		}
		return &e, true
	}
	return nil, false
}

// Set stores an entry and indexes its tags.
//
// Only used when the origin has no adapter of its own — an adapter writes
// directly to Redis with better information than the proxy can infer from
// headers. The key lives for ttl+swr so stale-while-revalidate has something to
// serve; freshness inside that window is decided from StoredAt.
func (c *Cache) Set(ctx context.Context, key string, e *Entry) error {
	if c.tripped() {
		return nil
	}

	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}

	total := time.Duration(e.TTL+e.SWR) * time.Second

	ctx, cancel := context.WithTimeout(ctx, c.cfg.RedisTimeout)
	defer cancel()

	pipe := c.rdb.Pipeline()
	pipe.Set(ctx, key, payload, total)

	for _, tag := range e.Tags {
		tk := tagKey(c.cfg.KeyPrefix, c.cfg.Version, tag)
		pipe.SAdd(ctx, tk, key)
		// Tag sets outlive their members slightly; without this the set for a hot
		// page accumulates dead keys forever.
		expiry := total
		if expiry < time.Minute {
			expiry = time.Minute
		}
		pipe.PExpire(ctx, tk, expiry)
	}

	if _, err := pipe.Exec(ctx); err != nil {
		c.recordFailure(err)
		return err
	}
	c.recordSuccess()
	return nil
}

// AcquireLock takes the single-flight lock so only one proxy replica wakes the
// SSR pod for a given stale page.
func (c *Cache) AcquireLock(ctx context.Context, key string) bool {
	if c.tripped() {
		return false
	}

	ctx, cancel := context.WithTimeout(ctx, c.cfg.RedisTimeout)
	defer cancel()

	ok, err := c.rdb.SetNX(ctx, lockKey(key), "1", c.cfg.LockTTL).Result()
	if err != nil {
		c.recordFailure(err)
		return false
	}
	return ok
}

func (c *Cache) ReleaseLock(ctx context.Context, key string) {
	if c.tripped() {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, c.cfg.RedisTimeout)
	defer cancel()
	if err := c.rdb.Del(ctx, lockKey(key)).Err(); err != nil {
		c.recordFailure(err)
	}
}

func (c *Cache) Status() string {
	if c.tripped() {
		return "breaker-open"
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RedisTimeout)
	defer cancel()
	if err := c.rdb.Ping(ctx).Err(); err != nil {
		return "unreachable"
	}
	return "ready"
}

func (c *Cache) Close() error { return c.rdb.Close() }
