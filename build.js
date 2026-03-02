const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const distPublic = path.join(__dirname, 'dist/public');

// Ensure dist/public exists
fs.mkdirSync(distPublic, { recursive: true });

// Copy static assets
fs.copyFileSync(
  path.join(__dirname, 'src/client/index.html'),
  path.join(distPublic, 'index.html')
);
fs.copyFileSync(
  path.join(__dirname, 'src/client/styles.css'),
  path.join(distPublic, 'styles.css')
);
fs.copyFileSync(
  path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'),
  path.join(distPublic, 'xterm.css')
);
fs.copyFileSync(
  path.join(__dirname, 'src/client/login.html'),
  path.join(distPublic, 'login.html')
);

// Bundle TypeScript client
esbuild.build({
  entryPoints: [path.join(__dirname, 'src/client/app.ts')],
  bundle: true,
  outfile: path.join(distPublic, 'app.js'),
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
}).then(() => {
  console.log('Client bundle built successfully');
}).catch((err) => {
  console.error('Client build failed:', err);
  process.exit(1);
});
