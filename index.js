import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const runtime_dir = fileURLToPath(new URL('./src/runtime', import.meta.url));

/**
 * SvelteKit adapter targeting Knative Serving with a Redis-backed page cache.
 *
 * The output is a single bundled `index.js` plus `client/` and `prerendered/`
 * asset directories — the same shape adapter-node produces, so the existing
 * Dockerfile (`COPY --from=build /app/build ./build`) keeps working unchanged.
 *
 * @param {import('./types/index.js').AdapterOptions} [options]
 * @returns {import('@sveltejs/kit').Adapter}
 */
export default function adapter(options = {}) {
	const {
		out = 'build',
		precompress = true,
		envPrefix = '',
		cache = {}
	} = options;

	return {
		name: '@weeb-vip/adapter-knative',

		async adapt(builder) {
			const tmp = builder.getBuildDirectory('adapter-knative');

			// Resolved up front, and passed to esbuild along with absWorkingDir.
			// esbuild's working directory defaults to the cwd at the time its
			// service starts rather than at build() time, so a relative outfile can
			// silently land somewhere other than the project root.
			const out_dir = path.resolve(out);

			builder.rimraf(out_dir);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			const base = builder.config.kit.paths.base;

			builder.log.minor('Copying assets');
			builder.writeClient(`${out_dir}/client${base}`);
			builder.writePrerendered(`${out_dir}/prerendered${base}`);

			builder.log.minor('Building server');
			builder.writeServer(`${tmp}/server`);

			fs.writeFileSync(
				`${tmp}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './server' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const base = ${JSON.stringify(base)};`
				].join('\n') + '\n'
			);

			// The build id namespaces every cache key. It MUST change whenever the
			// rendered output could change, otherwise a deploy serves HTML from the
			// previous build — including references to /_app/immutable chunks that
			// no longer exist in the new image. kit.version.name defaults to a build
			// timestamp, which is exactly the semantics we want. CACHE_VERSION at
			// runtime overrides it (the Helm chart sets it from the image tag so the
			// SSR pods and the edge proxy flip together).
			const build_id = builder.config.kit.version.name;
			builder.log.minor(`Cache namespace (build id): ${build_id}`);

			fs.writeFileSync(
				`${tmp}/entry.js`,
				[
					`import { Server } from './server/index.js';`,
					`import { manifest, prerendered, base } from './manifest.js';`,
					`import { start } from '@weeb-vip/adapter-knative/runtime';`,
					``,
					`start({`,
					`  Server,`,
					`  manifest,`,
					`  prerendered,`,
					`  base,`,
					`  buildId: ${JSON.stringify(build_id)},`,
					`  envPrefix: ${JSON.stringify(envPrefix)},`,
					`  cache: ${JSON.stringify(cache)}`,
					`});`,
					``
				].join('\n')
			);

			builder.log.minor('Bundling');
			await esbuild.build({
				entryPoints: [`${tmp}/entry.js`],
				outfile: `${out_dir}/index.js`,
				absWorkingDir: out_dir,
				bundle: true,
				format: 'esm',
				platform: 'node',
				target: 'node20',
				sourcemap: 'linked',
				logLevel: 'warning',
				// ioredis and its transitive deps are CJS; bundling them into ESM
				// leaves bare `require` calls in a few lazy paths. Shim it.
				banner: {
					js: [
						`import { createRequire as __adapterCreateRequire } from 'node:module';`,
						`import { fileURLToPath as __adapterFileURLToPath } from 'node:url';`,
						`import { dirname as __adapterDirname } from 'node:path';`,
						`const require = __adapterCreateRequire(import.meta.url);`,
						`const __filename = __adapterFileURLToPath(import.meta.url);`,
						`const __dirname = __adapterDirname(__filename);`
					].join('\n')
				},
				alias: {
					'@weeb-vip/adapter-knative/runtime': path.join(runtime_dir, 'index.js')
				}
			});

			if (precompress) {
				builder.log.minor('Compressing assets');
				await Promise.all([
					builder.compress(`${out_dir}/client`),
					builder.compress(`${out_dir}/prerendered`)
				]);
			}

			// Written so CI can tag the image with the same id the cache uses, and
			// so `docker run ... cat build/.build-id` is a quick sanity check.
			fs.writeFileSync(`${out_dir}/.build-id`, `${build_id}\n`);

			builder.log.success(`Built to ${out}/ — run with: node ${out}/index.js`);
		}
	};
}
