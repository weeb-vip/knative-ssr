/**
 * Generates test/key-vectors.json from the JavaScript key builder.
 *
 * The Go edge proxy asserts against the same file (edge/key_test.go), which is
 * what keeps the two implementations honest. If you change the key format,
 * regenerate with `node scripts/gen-key-vectors.mjs` and run `go test ./edge`.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { build_key, normalise_query, vary_hash, is_authenticated } from '../src/runtime/key.js';

const IGNORED = ['utm_source', 'utm_medium', 'gclid', 'fbclid', 'ref'];

const cases = [
	{ name: 'root', pathname: '/', query: '' },
	{ name: 'simple path', pathname: '/airing', query: '' },
	{ name: 'show detail', pathname: '/show/12345', query: '' },
	{ name: 'sorted params', pathname: '/search', query: 'z=1&a=2&m=3' },
	{ name: 'duplicate keys sorted by value', pathname: '/search', query: 'tag=b&tag=a&tag=c' },
	{ name: 'tracking params stripped', pathname: '/', query: 'utm_source=twitter&q=naruto&gclid=xyz' },
	{ name: 'only tracking params', pathname: '/', query: 'utm_source=x&fbclid=y' },
	{ name: 'space encoding', pathname: '/search', query: 'q=cowboy bebop' },
	{ name: 'plus is a space', pathname: '/search', query: 'q=cowboy+bebop' },
	{ name: 'punctuation unreserved by encodeURIComponent', pathname: '/search', query: "q=a!b~c*d'e(f)g" },
	{ name: 'reserved punctuation', pathname: '/search', query: 'q=a/b:c@d,e;f=g' },
	{ name: 'unicode japanese', pathname: '/search', query: 'q=カウボーイビバップ' },
	{ name: 'emoji', pathname: '/search', query: 'q=🍿' },
	{ name: 'empty value', pathname: '/search', query: 'q=' },
	{ name: 'ampersand in value', pathname: '/search', query: 'q=fate%26stay' },
	{ name: 'path with encoded chars', pathname: '/show/some%20title', query: '' }
];

const vectors = cases.flatMap((c) => {
	const params = new URLSearchParams(c.query);
	const query = normalise_query(params, IGNORED);

	return ['pub', 'anon', 'auth'].map((segment) => ({
		name: `${c.name} [${segment}]`,
		input: {
			prefix: 'ssr',
			version: '1.98.0',
			segment,
			host: 'staging.weeb.vip',
			method: 'GET',
			pathname: c.pathname,
			rawQuery: c.query,
			ignored: IGNORED
		},
		normalisedQuery: query,
		key: build_key({
			prefix: 'ssr',
			version: '1.98.0',
			segment,
			host: 'staging.weeb.vip',
			method: 'GET',
			pathname: c.pathname,
			query,
			varyHash: '0'
		})
	}));
});

// Vary hashing is part of the contract too.
const varyCases = [
	{ headers: {}, varyHeaders: [] },
	{ headers: { 'accept-language': 'en-GB' }, varyHeaders: ['accept-language'] },
	{ headers: { 'accept-language': 'ja' }, varyHeaders: ['accept-language'] },
	{ headers: {}, varyHeaders: ['accept-language'] },
	{
		headers: { 'accept-language': 'en', 'x-device': 'mobile' },
		varyHeaders: ['X-Device', 'accept-language']
	}
];

const varyVectors = varyCases.map((c, i) => ({
	name: `vary ${i}`,
	headers: c.headers,
	varyHeaders: c.varyHeaders,
	hash: vary_hash(new Headers(c.headers), c.varyHeaders)
}));

// Auth detection must agree exactly — a disagreement here is the difference
// between a cache miss and serving the wrong person's page.
const AUTH_COOKIES = ['auth_token', 'access_token', 'refresh_token', 'authToken', 'session'];

const authCases = [
	{ cookie: '', expected: false },
	{ cookie: 'theme=dark', expected: false },
	{ cookie: 'auth_token=abc123', expected: true },
	{ cookie: 'theme=dark; auth_token=abc123', expected: true },
	{ cookie: 'auth_token=', expected: false },
	{ cookie: 'auth_token=null', expected: false },
	{ cookie: 'auth_token=undefined', expected: false },
	{ cookie: 'auth_token=deleted', expected: false },
	{ cookie: 'guest_access_token=x', expected: false },
	{ cookie: 'session=xyz', expected: true },
	{ cookie: '  refresh_token = spaced  ', expected: true },
	{ cookie: 'malformed;;;auth_token=ok', expected: true }
];

const authVectors = authCases.map((c) => ({
	cookie: c.cookie,
	authCookies: AUTH_COOKIES,
	authenticated: is_authenticated(c.cookie, AUTH_COOKIES),
	expected: c.expected
}));

const mismatched = authVectors.filter((v) => v.authenticated !== v.expected);
if (mismatched.length) {
	console.error('JS auth detection disagrees with expectations:', mismatched);
	process.exit(1);
}

mkdirSync(new URL('../test', import.meta.url), { recursive: true });
writeFileSync(
	new URL('../test/key-vectors.json', import.meta.url),
	JSON.stringify({ keys: vectors, vary: varyVectors, auth: authVectors }, null, 2) + '\n'
);

console.log(
	`wrote ${vectors.length} key, ${varyVectors.length} vary, ${authVectors.length} auth vectors`
);
