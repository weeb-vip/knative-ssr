import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import adapter from '../index.js';

/**
 * Exercises the build step against a mock SvelteKit builder.
 *
 * This is where the fiddly parts live — the generated entry point, the esbuild
 * alias that resolves the runtime, and bundling CJS dependencies (ioredis) into
 * an ESM output. All of those fail at deploy time rather than build time if
 * they're wrong, so they're worth pinning down here.
 */

function mock_builder(root) {
	const written = { client: null, prerendered: null, server: null };

	return {
		written,
		log: { minor() {}, success() {}, warn() {} },
		config: {
			kit: {
				paths: { base: '' },
				version: { name: 'test-build-id' }
			}
		},
		prerendered: { paths: ['/about'] },

		getBuildDirectory: (name) => path.join(root, '.svelte-kit', name),
		rimraf: (dir) => fs.rmSync(path.resolve(root, dir), { recursive: true, force: true }),
		mkdirp: (dir) => fs.mkdirSync(path.resolve(root, dir), { recursive: true }),

		writeClient(dest) {
			written.client = dest;
			fs.mkdirSync(path.join(dest, '_app/immutable'), { recursive: true });
			fs.writeFileSync(path.join(dest, '_app/immutable/chunk.js'), 'export const x = 1;');
			fs.writeFileSync(path.join(dest, 'favicon.png'), 'not-really-a-png');
		},

		writePrerendered(dest) {
			written.prerendered = dest;
			fs.mkdirSync(dest, { recursive: true });
			fs.writeFileSync(path.join(dest, 'about.html'), '<html>about</html>');
		},

		writeServer(dest) {
			written.server = dest;
			fs.mkdirSync(dest, { recursive: true });
			// Stands in for SvelteKit's generated server bundle.
			fs.writeFileSync(
				path.join(dest, 'index.js'),
				`export class Server {
					constructor(manifest) { this.manifest = manifest; }
					async init() {}
					async respond() { return new Response('ok'); }
				}\n`
			);
		},

		generateManifest: () => '{ routes: [], assets: new Set() }',

		async compress() {}
	};
}

test('adapt() produces a runnable bundle', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-knative-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const cwd = process.cwd();
	process.chdir(root);
	t.after(() => process.chdir(cwd));

	const builder = mock_builder(root);
	await adapter({ out: 'build', precompress: false }).adapt(builder);

	const out = path.join(root, 'build');

	assert.ok(fs.existsSync(path.join(out, 'index.js')), 'bundle written');
	assert.ok(fs.existsSync(path.join(out, 'client/_app/immutable/chunk.js')), 'client assets');
	assert.ok(fs.existsSync(path.join(out, 'prerendered/about.html')), 'prerendered pages');

	// The build id is what namespaces every cache key; it must survive into the
	// output, and be recorded for CI to read.
	assert.equal(fs.readFileSync(path.join(out, '.build-id'), 'utf8').trim(), 'test-build-id');

	const bundle = fs.readFileSync(path.join(out, 'index.js'), 'utf8');
	assert.match(bundle, /test-build-id/, 'build id baked into the bundle');

	// Bundled, not left as bare imports — the production image installs only
	// production deps, and @sveltejs/kit is a devDependency of the app.
	assert.doesNotMatch(bundle, /^import .* from ["']ioredis["']/m, 'ioredis bundled');
	assert.doesNotMatch(bundle, /^import .* from ["']@sveltejs\/kit\/node["']/m, 'kit bundled');
	assert.doesNotMatch(bundle, /^import .* from ["']sirv["']/m, 'sirv bundled');
});

test('the bundle boots, serves, and shuts down on SIGTERM', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-knative-run-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const cwd = process.cwd();
	process.chdir(root);
	await adapter({ out: 'build', precompress: false }).adapt(mock_builder(root));
	process.chdir(cwd);

	// Run it the way the container does, rather than importing it — the entry
	// calls start() at module scope, and the point is to exercise the real boot
	// and drain path.
	const port = 39000 + Number(process.hrtime.bigint() % 1000n);
	const child = spawn(process.execPath, [path.join(root, 'build/index.js')], {
		env: {
			...process.env,
			// No Redis needed: this is about the server booting and answering.
			CACHE_ENABLED: 'false',
			PORT: String(port),
			HOST: '127.0.0.1'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (d) => (stdout += d));
	child.stderr.on('data', (d) => (stderr += d));

	const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
	t.after(() => child.kill('SIGKILL'));

	// Wait for the listening line rather than sleeping a fixed interval.
	const deadline = Date.now() + 15_000;
	while (!stdout.includes('[ssr] listening') && Date.now() < deadline) {
		if (child.exitCode !== null) {
			assert.fail(`server exited early (${child.exitCode}):\n${stdout}\n${stderr}`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.match(stdout, /\[ssr] listening/, `server never listened:\n${stdout}\n${stderr}`);
	assert.match(stdout, /build test-build-id/, 'logs the build id it is caching under');

	const res = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), 'ok');

	// Static assets come off disk, not through SvelteKit.
	const asset = await fetch(`http://127.0.0.1:${port}/_app/immutable/chunk.js`);
	assert.equal(asset.status, 200);
	assert.equal(
		asset.headers.get('cache-control'),
		'public, max-age=31536000, immutable',
		'hashed assets are immutable'
	);

	// Knative sends SIGTERM and waits for the drain; a pod that ignores it gets
	// killed mid-request on every scale-down.
	child.kill('SIGTERM');
	const { code } = await exited;
	assert.equal(code, 0, `expected a clean exit:\n${stdout}\n${stderr}`);
	assert.match(stdout, /drained, exiting/);
});
