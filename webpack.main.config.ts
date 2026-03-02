import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const mainConfig: Configuration = {
  entry: './src/main/index.ts',
  // Preserve __dirname / __filename so native modules (.node files) resolve
  // their binary paths correctly at runtime inside the webpack bundle.
  node: {
    __dirname:  false,
    __filename: false,
  },
  // Do NOT bundle native add-ons — require them at runtime from node_modules.
  // This is the only reliable way to avoid path-resolution failures with
  // .node binaries (better-sqlite3, vectordb, etc.) inside a webpack bundle.
  externals: {
    'better-sqlite3':      'commonjs better-sqlite3',
    'vectordb':            'commonjs vectordb',
    '@xenova/transformers':'commonjs @xenova/transformers',
  },
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
