import { defineConfig } from 'vite';

import Inline from '../../src/index.js';

export default defineConfig({
  plugins: [
    Inline()
  ]
});
