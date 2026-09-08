type Target = string | string[] | undefined;

const helperExpressions = new Map<string, Promise<string>>();

async function buildHelper(source: string, target: Target): Promise<string> {
  const vite = await import('vite');
  const entry = '\0vite-plugin-inline/helper.js';
  const result = await vite.build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'vite-plugin-inline-helper',
        resolveId(id) {
          if (id === entry) return id;
        },
        load(id) {
          if (id === entry) return `export { default } from ${JSON.stringify(source)}`;
        }
      }
    ],
    build: {
      write: false,
      minify: false,
      target: target ?? 'esnext',
      lib: { entry, name: '_inlineHelper', formats: ['iife'] },
      rolldownOptions: { input: entry }
    }
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!('output' in output)) throw new Error(`Failed to inline Oxc helper ${source}`);
  const chunk = output.output.find((file) => file.type === 'chunk' && file.isEntry);
  if (!chunk || chunk.type !== 'chunk') throw new Error(`Missing bundled Oxc helper ${source}`);
  const { program } = vite.parseSync('helper.js', chunk.code);
  const declaration = program.body[0];
  const expression =
    declaration?.type === 'VariableDeclaration' && declaration.declarations.length === 1
      ? declaration.declarations[0].init
      : undefined;
  if (program.body.length !== 1 || !expression) {
    throw new Error(`Unexpected bundled Oxc helper ${source}`);
  }
  return chunk.code.slice(expression.start, expression.end);
}

function helperExpression(source: string, target: Target): Promise<string> {
  const key = JSON.stringify([source, target]);
  let expression = helperExpressions.get(key);
  if (!expression) {
    expression = buildHelper(source, target).catch((error) => {
      helperExpressions.delete(key);
      throw error;
    });
    helperExpressions.set(key, expression);
  }
  return expression;
}

export async function inlineOxcHelpers(
  code: string,
  filename: string,
  helpersUsed: Record<string, string>,
  target: Target
): Promise<string> {
  const sources = new Set(Object.values(helpersUsed));
  if (sources.size === 0) return code;
  const vite = await import('vite');
  const { program } = vite.parseSync(filename, code);
  const replacements: { start: number; end: number; code: string }[] = [];
  for (const node of program.body) {
    if (
      node.type === 'ImportDeclaration' &&
      sources.has(node.source.value) &&
      node.specifiers.length === 1 &&
      node.specifiers[0].type === 'ImportDefaultSpecifier'
    ) {
      const expression = await helperExpression(node.source.value, target);
      replacements.push({
        start: node.start,
        end: node.end,
        code: `var ${node.specifiers[0].local.name} = ${expression};`
      });
    } else if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        const call = declaration.init;
        if (
          declaration.id.type !== 'Identifier' ||
          call?.type !== 'CallExpression' ||
          call.callee.type !== 'Identifier' ||
          call.callee.name !== 'require' ||
          call.arguments.length !== 1
        )
          continue;
        const source = call.arguments[0];
        if (
          source.type !== 'Literal' ||
          typeof source.value !== 'string' ||
          !sources.has(source.value)
        )
          continue;
        replacements.push({
          start: call.start,
          end: call.end,
          code: await helperExpression(source.value, target)
        });
      }
    }
  }
  // Only replace generated helper bindings; user imports and script scope stay intact.
  for (const replacement of replacements.reverse()) {
    code = code.slice(0, replacement.start) + replacement.code + code.slice(replacement.end);
  }
  return code;
}
