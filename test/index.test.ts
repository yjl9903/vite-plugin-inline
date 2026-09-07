import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { InlineConfig } from 'vite';

import { build, createServer, resolveConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Inline from '../src/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vite-plugin-inline-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function getHook<T>(hook: T | { handler: T }): T {
  return typeof hook === 'object' && hook !== null && 'handler' in hook
    ? hook.handler
    : (hook as T);
}

async function createLoader(command: 'serve' | 'build' = 'serve', options: InlineConfig = {}) {
  const plugin = Inline();
  const config = await resolveConfig(
    { configFile: false, root, logLevel: 'silent', ...options },
    command
  );
  const configResolved = getHook(plugin.configResolved!);
  await configResolved.call({} as ThisParameterType<typeof configResolved>, config);
  const load = getHook(plugin.load!);
  const addWatchFile = vi.fn();
  const context = { addWatchFile } as unknown as ThisParameterType<typeof load>;

  return {
    plugin,
    addWatchFile,
    load: (id: string) => load.call(context, id),
    async transform(source: string, filename = 'inline.ts', suffix = '?inline-ts') {
      const file = path.join(root, filename);
      await writeFile(file, source);
      const result = await load.call(context, file + suffix);
      if (!result || typeof result === 'string' || !('code' in result)) {
        throw new Error(`Expected an inline module for ${file + suffix}`);
      }
      expect(result.map).toBeNull();
      return JSON.parse(result.code!.slice('export default '.length)) as string;
    }
  };
}

function run(code: string) {
  const report = vi.fn();
  const React = {
    createElement: (tag: string, props: unknown, ...children: unknown[]) => ({
      tag,
      props,
      children
    })
  };
  new Function('report', 'React', code)(report, React);
  return report;
}

describe('inline imports', () => {
  it.each(['ts', 'mts', 'js', 'mjs', 'cjs'])(
    'transpiles .%s files to executable strings',
    async (ext) => {
      const loader = await createLoader();
      const annotation = ext === 'ts' || ext === 'mts' ? ': string' : '';
      const code = await loader.transform(
        `const message${annotation} = 'hello'; report(message);`,
        `inline.${ext}`
      );

      expect(run(code)).toHaveBeenCalledWith('hello');
      expect(loader.addWatchFile).toHaveBeenCalledWith(path.join(root, `inline.${ext}`));
    }
  );

  it.each(['tsx', 'jsx'])('preserves the classic JSX default for .%s', async (ext) => {
    const loader = await createLoader();
    const annotation = ext === 'tsx' ? ': string' : '';
    const code = await loader.transform(
      `const message${annotation} = 'hello'; report(<span>{message}</span>);`,
      `inline.${ext}`
    );

    expect(run(code)).toHaveBeenCalledWith({ tag: 'span', props: null, children: ['hello'] });
  });

  it('respects an automatic JSX runtime and import source inherited from tsconfig', async () => {
    await writeFile(
      path.join(root, 'tsconfig.base.json'),
      JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'custom-jsx' } })
    );
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ extends: './tsconfig.base.json' })
    );
    const loader = await createLoader();
    const code = await loader.transform(
      "const message: string = 'hello'; report(<span>{message}</span>);",
      'inline.tsx'
    );

    expect(code).toContain('custom-jsx/jsx-runtime');
    expect(code).not.toContain('React.createElement');
    expect(code).not.toContain('<span>');
    expect(code).not.toContain(': string');
  });

  it('respects custom classic JSX element and fragment factories from tsconfig', async () => {
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          jsx: 'react',
          jsxFactory: 'customCreateElement',
          jsxFragmentFactory: 'customFragment'
        }
      })
    );
    const loader = await createLoader();
    const code = await loader.transform('report(<><span>Hello</span></>);', 'inline.tsx');
    const report = vi.fn();
    const customCreateElement = (tag: string, props: unknown, ...children: unknown[]) => ({
      tag,
      props,
      children
    });

    new Function('report', 'customCreateElement', 'customFragment', code)(
      report,
      customCreateElement,
      'fragment'
    );

    expect(report).toHaveBeenCalledWith({
      tag: 'fragment',
      props: null,
      children: [{ tag: 'span', props: null, children: ['Hello'] }]
    });
  });

  it.each(['?inline-ts', '?inline&raw', '?raw&inline'])(
    'supports the %s suffix',
    async (suffix) => {
      const loader = await createLoader();
      const code = await loader.transform(
        'const value: number = 42; report(value);',
        'inline.ts',
        suffix
      );

      expect(run(code)).toHaveBeenCalledWith(42);
    }
  );

  it.each(['missing.css?inline&raw', 'missing.json?inline-ts', 'missing.ts?raw', 'missing.ts'])(
    'leaves %s to other plugins',
    async (filename) => {
      const loader = await createLoader();

      expect(await loader.load(path.join(root, filename))).toBeUndefined();
      expect(loader.addWatchFile).not.toHaveBeenCalled();
    }
  );

  it('invalidates every inline variant and reloads when its source changes', async () => {
    const loader = await createLoader();
    const file = path.join(root, 'inline.ts');
    const modules = ['?inline-ts', '?raw&inline'].map((suffix) => ({ id: file + suffix }));
    for (const suffix of ['?inline-ts', '?raw&inline']) {
      await loader.transform('const value: number = 42;', 'inline.ts', suffix);
    }
    const invalidateModule = vi.fn();
    const send = vi.fn();
    const handleHotUpdate = getHook(loader.plugin.handleHotUpdate!);
    const context = {
      file,
      server: {
        moduleGraph: {
          getModuleById: (id: string) => modules.find((module) => module.id === id),
          invalidateModule
        },
        ws: { send }
      }
    } as unknown as Parameters<typeof handleHotUpdate>[0];

    await handleHotUpdate.call({} as ThisParameterType<typeof handleHotUpdate>, context);

    expect(invalidateModule.mock.calls).toEqual(modules.map((module) => [module]));
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'full-reload' });
  });
});

describe('transform settings', () => {
  const source =
    "const descriptiveMessage: string = 'hello';\nreport(descriptiveMessage);\nreport('world');";

  it('keeps development code unminified regardless of build.minify', async () => {
    const code = await (await createLoader('serve', { build: { minify: true } })).transform(source);

    expect(code).toContain('descriptiveMessage');
    expect(code.split('\n').length).toBeGreaterThan(1);
    expect(run(code).mock.calls).toEqual([['hello'], ['world']]);
  });

  it.each([true, 'oxc', 'terser'] as const)('honors build.minify: %s and false', async (minify) => {
    const unminified = await (
      await createLoader('build', { build: { minify: false } })
    ).transform(source);
    const minified = await (await createLoader('build', { build: { minify } })).transform(source);

    expect(unminified).toContain('descriptiveMessage');
    expect(unminified.split('\n').length).toBeGreaterThan(1);
    expect(minified.length).toBeLessThan(unminified.length);
    expect(run(minified).mock.calls).toEqual([['hello'], ['world']]);
  });

  it.each(['ts', 'mts', 'tsx', 'js', 'mjs', 'cjs', 'jsx'])(
    'keeps standalone .%s top-level declarations when minifying',
    async (ext) => {
      const loader = await createLoader('build', { build: { minify: true } });
      const annotation = ['ts', 'mts', 'tsx'].includes(ext) ? ': string' : '';
      const code = await loader.transform(
        `const standaloneValue${annotation} = 'hello';`,
        `inline.${ext}`
      );

      expect(new Function(`${code}\nreturn standaloneValue;`)()).toBe('hello');
    }
  );

  it('preserves CommonJS top-level returns when minifying', async () => {
    const loader = await createLoader('build', { build: { minify: true } });
    const code = await loader.transform(
      'if (stop) return; const standaloneValue = 42;',
      'inline.cjs'
    );
    const execute = new Function('stop', `${code}\nreturn standaloneValue;`);

    expect(execute(true)).toBeUndefined();
    expect(execute(false)).toBe(42);
  });

  it.each([false, true])('honors an older build target with minify: %s', async (minify) => {
    const loader = await createLoader('build', { build: { target: 'es2015', minify } });
    const code = await loader.transform(
      'function read(value: { answer: number } | undefined) { return value?.answer ?? 0; } report(read({ answer: 42 })); report(read(undefined));'
    );

    expect(code).not.toContain('?.');
    expect(code).not.toContain('??');
    expect(run(code).mock.calls).toEqual([[42], [0]]);
  });

  it.each([false, 'esnext'] as const)(
    'preserves modern syntax for build.target: %s',
    async (target) => {
      const loader = await createLoader('build', { build: { target, minify: false } });
      const code = await loader.transform(
        'function read(value: { answer: number }) { return value?.answer; } report(read({ answer: 42 }));'
      );

      expect(code).toContain('?.');
      expect(run(code)).toHaveBeenCalledWith(42);
    }
  );
});

describe('Vite integration', () => {
  it('builds inline imports with the default Vite target and minifier', async () => {
    await writeFile(
      path.join(root, 'inline.ts'),
      "const message: string = 'hello'; report(message);"
    );
    await writeFile(
      path.join(root, 'main.ts'),
      "import code from './inline.ts?inline&raw'; export default code;"
    );

    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [Inline()],
      build: {
        write: false,
        lib: { entry: path.join(root, 'main.ts'), formats: ['es'], fileName: 'main' }
      }
    });
    const bundle = Array.isArray(result) ? result[0] : result;
    if (!('output' in bundle)) throw new Error('Expected a build result');
    const entry = bundle.output.find((output) => output.type === 'chunk' && output.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Expected the entry chunk');
    const module = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`
    );

    expect(typeof module.default).toBe('string');
    expect(run(module.default)).toHaveBeenCalledWith('hello');
  });

  it('serves transpiled inline strings through the dev server', async () => {
    await writeFile(path.join(root, 'inline.ts'), 'const value: number = 42; report(value);');
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [Inline()],
      appType: 'custom',
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true, include: [] }
    });

    try {
      const result = await server.transformRequest('/inline.ts?raw&inline');
      expect(result).not.toBeNull();
      const module = await import(
        /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(result!.code).toString('base64')}`
      );

      expect(run(module.default)).toHaveBeenCalledWith(42);
    } finally {
      await server.close();
    }
  });
});
