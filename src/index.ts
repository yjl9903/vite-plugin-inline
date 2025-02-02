import fs from 'node:fs';
import path from 'node:path';

import type { Plugin, ResolvedConfig } from 'vite';

import { transformWithEsbuild } from 'vite';

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
      if (id.endsWith('?inline&raw') || id.endsWith('?raw&inline')) {
        const filename = id.slice(0, id.length - '?inline&raw'.length);
        const ext = path.extname(filename);
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

        const result = await transformWithEsbuild(code, filename, {
          loader:
            ext === 'ts' || ext === 'mts'
              ? 'ts'
              : ext === 'tsx'
                ? 'tsx'
                : ext === 'jsx'
                  ? 'jsx'
                  : 'js',
          minify:
            config.command === 'serve'
              ? false
              : typeof config.build.minify === 'boolean'
                ? config.build.minify
                : true,
          target: config.build.target || undefined
        });

        return {
          code: `export default ${JSON.stringify(result.code.trimEnd())}`,
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
          console.log(module);
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
