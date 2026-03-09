import type { Configuration } from 'webpack';
import CopyPlugin from 'copy-webpack-plugin';
import * as path from 'path';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

rules.push({
  test: /\.css$/,
  use: [
    { loader: 'style-loader' },
    { loader: 'css-loader' },
    { loader: 'postcss-loader' },
  ],
});

// Font files used by KaTeX for math rendering
rules.push({
  test: /\.(woff|woff2|eot|ttf|otf)$/,
  type: 'asset/resource',
});

export const rendererConfig: Configuration = {
  module: {
    rules,
  },
  plugins: [
    ...plugins,
    // Copy the pdfjs worker into the renderer output so we can load it
    // with a relative URL (avoids webpack bundling ESM .mjs as CJS).
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(
            __dirname,
            'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
          ),
          // Forge's webpack plugin serves the renderer from the main_window/
          // subdirectory (where index.html lives).  The worker must be co-located
          // so that new URL('pdf.worker.min.mjs', window.location.href) resolves
          // to http://localhost:3000/main_window/pdf.worker.min.mjs in dev and
          // the correct file:// path in production.
          to: 'main_window/pdf.worker.min.mjs',
        },
        {
          from: path.resolve(__dirname, 'assets/axiom-logo.png'),
          to: 'main_window/axiom-logo.png',
        },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
