import fs from 'node:fs';
import path from 'node:path';

import type { TsConfigResult } from 'get-tsconfig';

import { createFilesMatcher, getTsconfig, parseTsconfig } from 'get-tsconfig';

export function getSourceTsconfig(filename: string): TsConfigResult | null {
  const nearest = getTsconfig(filename);
  if (!nearest) return null;

  // Like Oxc, prefer the first direct reference that includes the source file.
  // References are not traversed recursively, so cyclic project graphs are safe.
  for (const reference of nearest.config.references ?? []) {
    let configPath = path.resolve(path.dirname(nearest.path), reference.path);
    if (fs.statSync(configPath).isDirectory()) {
      configPath = path.join(configPath, 'tsconfig.json');
    }
    const referenced = { path: configPath, config: parseTsconfig(configPath) };
    if (createFilesMatcher(referenced)(filename)) {
      return referenced;
    }
  }

  return nearest;
}
