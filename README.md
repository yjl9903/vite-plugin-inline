# vite-plugin-inline

[![version](https://img.shields.io/npm/v/vite-plugin-inline?label=vite-plugin-inline)](https://www.npmjs.com/package/vite-plugin-inline)
[![GitHub License](https://img.shields.io/github/license/yjl9903/vite-plugin-inline)](https://github.com/yjl9903/vite-plugin-inline/blob/main/LICENSE)
[![CI](https://github.com/yjl9903/vite-plugin-inline/actions/workflows/ci.yml/badge.svg)](https://github.com/yjl9903/vite-plugin-inline/actions/workflows/ci.yml)

Inline raw TypeScript code as a string.

Add `?raw&inline` (or `?inline&raw`) import url suffix support for Vite.

## Installation

```bash
npm i vite-plugin-inline
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';

import Inline from 'vite-plugin-inline';

export default defineConfig({
  plugins: [
    Inline()
  ]
});
```

**TypeScript** support:

```ts
// env.d.ts

/// <reference path="vite-plugin-inline/client" />
```

## Usage

For example, you want to get the transformed TypeScript file `inline.ts`.

```ts
// inline.ts
const hello: string = 'hello'
```

```ts
// main.ts

import code from './inline.ts?raw&inline'

console.log(code) // Print: "const hello = 'hello'"
```

## License

MIT License © 2025 [XLor](https://github.com/yjl9903)
