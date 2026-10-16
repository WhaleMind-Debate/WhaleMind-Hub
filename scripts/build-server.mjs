/**
 * server 打包成单文件 ESM（esbuild）
 *
 * 目标：把 server/src/index.ts（含 shared 源码内联、express、socket.io）
 * 打成一个 server/dist/server.js，供分发包用 `node server.js` 单命令启动。
 *
 * 设计要点：
 * - platform=node 让 esbuild 自动把 node: 内置模块（含 node:sqlite 的运行时
 *   createRequire 调用）external 化，不打进产物；
 * - format=esm，保持 server 源码的 ESM 语义与 import.meta.url（DB 路径定位）；
 * - resolveTsJs 插件：把 `./x.js` 这种 TS NodeNext 惯例 import 解析到对应的
 *   `./x.ts` 源文件，否则 esbuild 找不到 .js 实体。
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 把 `from './foo.js'` 解析到 `./foo.ts`（TS NodeNext 产物走 ESM 的惯例写法） */
const resolveTsJs = {
  name: 'resolve-ts-js',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      const target = args.path.replace(/\.js$/, '.ts');
      const abs = join(args.resolveDir, target);
      if (existsSync(abs)) return { path: abs };
      return null; // 回退到默认解析
    });
  },
};

await build({
  entryPoints: [join(root, 'server/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(root, 'server/dist/server.js'),
  plugins: [resolveTsJs],
  logLevel: 'info',
  // 运行时才存在的动态 require（如 createRequire('node:sqlite')）不打断包
  external: [],
  banner: {
    // esbuild 打成 ESM 后，某些 CJS 依赖可能用到 require；补一个 shim
    js: `import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);`,
  },
});
