import fs from 'node:fs';
import path from 'node:path';

import type { Plugin, ResolvedConfig } from 'vite';

import { getTsconfig } from 'get-tsconfig';

export default function Inline(): Plugin {
  let config!: ResolvedConfig;

  const inlines = new Map<string, Set<string>>();

  return {
    name: 'vite-plugin-inline',
    enforce: 'pre',
    configResolved(c) {
      config = c;
    },
    async load(id) {
      if (id.endsWith('?inline&raw') || id.endsWith('?raw&inline') || id.endsWith('?inline-ts')) {
        const filename = id.slice(0, id.lastIndexOf('?'));

        const ext = path.extname(filename).slice(1);
        if (!['ts', 'tsx', 'mts', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
          return;
        }

        const code = await fs.promises.readFile(filename, 'utf-8');

        this.addWatchFile(filename);
        if (inlines.has(filename)) {
          inlines.get(filename)!.add(id);
        } else {
          inlines.set(filename, new Set([id]));
        }

        // Keep the CommonJS entry compatible with Vite's ESM-only Node API.
        const vite = await import('vite');
        const lang =
          ext === 'ts' || ext === 'mts'
            ? 'ts'
            : ext === 'tsx'
              ? 'tsx'
              : ext === 'jsx'
                ? 'jsx'
                : 'js';
        const minify = config.command !== 'serve' && config.build.minify !== false;
        const target = config.build.target || undefined;
        let transformed: string;

        if (typeof vite.transformWithOxc === 'function') {
          // Oxc defaults to automatic JSX; preserve esbuild's classic default
          // without overriding an explicit (possibly inherited) tsconfig setting.
          const jsx =
            lang === 'tsx' ? getTsconfig(filename)?.config.compilerOptions?.jsx : undefined;
          const result = await vite.transformWithOxc(code, filename, {
            lang,
            target,
            sourcemap: false,
            jsx: jsx ? undefined : { runtime: 'classic' }
          });
          for (const warning of result.warnings) {
            this.warn(warning);
          }
          transformed = result.code;

          // Oxc's transform API does not minify; Vite 8 exposes its minifier separately.
          if (minify) {
            // Avoid treating .mjs/.mts/.cjs filenames as permission to drop script globals.
            const result = await vite.minify(
              ext === 'cjs' ? filename : `${filename}.js`,
              transformed,
              {
                module: false,
                compress: {
                  target,
                  dropDebugger: false,
                  // CommonJS permits top-level return, but treats globals as removable.
                  unused: ext === 'cjs' ? false : undefined
                },
                mangle: { toplevel: false },
                codegen: { legalComments: 'inline' }
              }
            );
            if (result.errors.length > 0) {
              this.error(result.errors.map((error) => error.message).join('\n'));
            }
            transformed = result.code;
          }
        } else {
          const result = await vite.transformWithEsbuild(code, filename, {
            loader: lang,
            minify,
            target
          });
          transformed = result.code;
        }

        return {
          code: `export default ${JSON.stringify(transformed.trimEnd())}`,
          map: null
        };
      }
    },
    handleHotUpdate({ file, server }) {
      const related = inlines.get(file);
      if (related && related.size > 0) {
        let changed = false;
        for (const id of related) {
          const module = server.moduleGraph.getModuleById(id);
          if (module) {
            server.moduleGraph.invalidateModule(module);
            changed = true;
          }
        }
        // Reload client
        if (changed) {
          server.ws.send({
            type: 'full-reload'
          });
        }
      }
    }
  };
}
