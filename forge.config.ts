import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import * as path from 'path';
import * as fs from 'fs';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

// Top-level modules that webpack treats as externals.
// copyModuleWithDeps will recursively pull in ALL their transitive
// dependencies (production, peer, and installed optional), so we only
// need to list the roots here.
const EXTERNAL_MODULES = [
  'better-sqlite3',
  'vectordb',
  '@xenova/transformers',
  'onnxruntime-node',
  'pdfjs-dist',
];

/**
 * Recursively copy a module and every production / peer / installed-optional
 * dependency from the project node_modules into the packaged build path.
 */
function copyModuleWithDeps(mod: string, buildPath: string, visited = new Set<string>()): void {
  if (visited.has(mod)) return;
  visited.add(mod);

  const src = path.join(__dirname, 'node_modules', mod);
  const dst = path.join(buildPath, 'node_modules', mod);
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }

  const pkgPath = path.join(src, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      // Only copy optional deps that are actually installed
      ...Object.keys(pkg.optionalDependencies ?? {}).filter(
        (d: string) => fs.existsSync(path.join(__dirname, 'node_modules', d)),
      ),
    ];
    for (const dep of allDeps) {
      copyModuleWithDeps(dep, buildPath, visited);
    }
  } catch { /* ignore parse errors */ }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/*.{node,dll}',
    },
    icon: './assets/axiom-logo',
  },
  rebuildConfig: {
    onlyModules: ['better-sqlite3', 'vectordb'],
  },
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const visited = new Set<string>();
      for (const mod of EXTERNAL_MODULES) {
        copyModuleWithDeps(mod, buildPath, visited);
      }
    },
  },
  publishers: [
    new PublisherGithub({
      repository: { owner: 'RahulRR-10', name: 'Axiom' },
      prerelease: false,
      draft: true,
    }),
  ],
  makers: [
    new MakerSquirrel({ setupIcon: './assets/axiom-logo.ico' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({ options: { icon: './assets/axiom-logo.png' } }),
    new MakerDeb({ options: { icon: './assets/axiom-logo.png' } }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/index.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
