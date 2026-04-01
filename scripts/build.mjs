import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');
const distFirefoxDir = path.join(rootDir, 'dist-firefox');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const cleanDir = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
};

const copyFile = (from, to) => {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
};

cleanDir(distDir);
cleanDir(distFirefoxDir);

await esbuild.build({
  entryPoints: {
    background: path.join(srcDir, 'extension', 'background.js'),
    popup: path.join(srcDir, 'extension', 'popup.js'),
  },
  outdir: distDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'firefox128',
  sourcemap: true,
  entryNames: '[name]',
  define: {
    __DORAEMON_VERSION__: JSON.stringify('0.1.0'),
  },
});

copyFile(path.join(srcDir, 'cli.js'), path.join(distDir, 'cli.js'));
copyFile(path.join(srcDir, 'daemon.js'), path.join(distDir, 'daemon.js'));

copyFile(path.join(srcDir, 'extension', 'manifest.firefox.json'), path.join(distFirefoxDir, 'manifest.json'));
copyFile(path.join(srcDir, 'extension', 'popup.html'), path.join(distFirefoxDir, 'popup.html'));
copyFile(path.join(srcDir, 'extension', 'icons', 'doraemon.svg'), path.join(distFirefoxDir, 'icons', 'doraemon.svg'));
copyFile(path.join(distDir, 'background.js'), path.join(distFirefoxDir, 'background.js'));
copyFile(path.join(distDir, 'background.js.map'), path.join(distFirefoxDir, 'background.js.map'));
copyFile(path.join(distDir, 'popup.js'), path.join(distFirefoxDir, 'popup.js'));
copyFile(path.join(distDir, 'popup.js.map'), path.join(distFirefoxDir, 'popup.js.map'));
