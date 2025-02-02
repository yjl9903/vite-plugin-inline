import { defineConfig } from 'vite';

import Inline from '../../src/';

export default defineConfig({
  plugins: [
    Inline()
  ]
});