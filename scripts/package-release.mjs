/**
 * 分发包打包脚本
 *
 * 目标：产出一个"免安装双击即用"的文件夹（可再压成 zip 发给老师），
 * 老师解压后双击 .bat 即启动，无需装 Node、无需 pnpm。
 *
 * 布局：
 *   dist-release/
 *   ├─ node.exe                     (从本机 node 官方分发复制，88MB)
 *   ├─ server/server.js             (esbuild 单文件产物)
 *   ├─ client/dist/…                (vite 构建产物)
 *   ├─ data/                        (空目录，运行时写入 SQLite)
 *   └─ 启动辩论赛系统.bat
 *
 * 关键：分发包的 server.js 相对 import.meta.url 无法可靠定位 data/ 与 client/dist
 * （打包后层级变了），因此由 .bat 显式设 DB_PATH 与 CLIENT_DIST 环境变量，
 * 这是最稳的做法，不依赖任何相对路径层级假设。
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-release');

// 0. 清空并重建输出目录
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'server'), { recursive: true });
mkdirSync(join(outDir, 'client'), { recursive: true });
mkdirSync(join(outDir, 'data'), { recursive: true });

// 1. 复制 node.exe（老师机器免装 Node 的关键）
const nodeExe = process.execPath; // 当前运行的 node.exe 绝对路径
if (!existsSync(nodeExe)) {
  console.error('找不到 node.exe，无法打包。');
  process.exit(1);
}
cpSync(nodeExe, join(outDir, 'node.exe'));
console.log(`[package] node.exe ← ${nodeExe}`);

// 2. 复制 server bundle
const serverBundle = join(root, 'server/dist/server.js');
if (!existsSync(serverBundle)) {
  console.error('找不到 server/dist/server.js，请先运行 build:server。');
  process.exit(1);
}
cpSync(serverBundle, join(outDir, 'server/server.js'));
console.log('[package] server/server.js ← server/dist/server.js');

// 声明 ESM，消除 node 的 MODULE_TYPELESS_PACKAGE_JSON 警告（server.js 是 ESM 产物）
writeFileSync(
  join(outDir, 'server/package.json'),
  JSON.stringify({ name: 'debate-server-runtime', private: true, type: 'module' }, null, 2),
  'utf8',
);
console.log('[package] server/package.json 已生成（type: module）');

// 3. 复制 client/dist
const clientDist = join(root, 'client/dist');
if (!existsSync(join(clientDist, 'index.html'))) {
  console.error('找不到 client/dist/index.html，请先运行 build:client。');
  process.exit(1);
}
cpSync(clientDist, join(outDir, 'client/dist'), { recursive: true });
console.log('[package] client/dist ← client/dist');

// 4. 生成启动脚本
//    - DB_PATH / CLIENT_DIST 显式指向包内路径，避免依赖 import.meta.url 层级
//    - 端口预检，被占用时提示并 pause，不让窗口一闪而过
//    - 末尾 pause，node 崩溃时窗口也能留住错误信息
//    - 用 GBK(936) 编码写入：cmd 双击时用系统默认代码页解析整个文件，
//      UTF-8 中文会在 chcp 生效前就导致 cmd 语法错误、窗口一闪而过。
//      故：去掉 chcp 65001，中文按 GBK 写，cmd 原生解析最稳。
const bat = `@echo off
title 鲸思云辩 · 辩论赛全流程系统
cd /d "%~dp0"

rem 端口预检：7369 被占用则给出提示并退出（保留窗口）
netstat -ano | findstr /r ":7369 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo.
  echo   [提示] 端口 7369 已被占用，无法启动。
  echo   请先关闭占用该端口的程序，再重新双击本脚本。
  echo.
  pause
  exit /b 1
)

rem 显式指定包内路径，避免相对 import.meta.url 的层级假设
set OPEN_BROWSER=1
set PORT=7369
set DB_PATH=%~dp0data\\debate.db
set CLIENT_DIST=%~dp0client\\dist

echo.
echo   鲸思云辩 · 辩论赛全流程系统 正在启动...
echo   启动后会自动打开浏览器；评委/大屏地址将显示在本窗口。
echo   关闭本窗口即停止比赛服务。
echo.

"%~dp0node.exe" "%~dp0server\\server.js"

echo.
echo   服务已停止。
pause
`;
// GBK 编码写入：cmd 双击时用系统默认代码页解析整个文件，UTF-8 中文会让 cmd
// 在 chcp 生效前就语法错误、窗口一闪而过。做法：先写 UTF-8 临时文件，
// 再用 PowerShell 按 UTF-8 读入、以 ANSI/GBK(Default) 存出，内容零丢失。
const batPath = join(outDir, '启动辩论赛系统.bat');
const batTmp = join(outDir, '.bat.tmp');
writeFileSync(batTmp, bat.replace(/\r?\n/g, '\r\n'), 'utf8');
execSync(
  `powershell.exe -NoProfile -Command "$t = [System.IO.File]::ReadAllText('${batTmp.replace(/\\/g, '/')}', [System.Text.Encoding]::UTF8); [System.IO.File]::WriteAllText('${batPath.replace(/\\/g, '/')}', $t, [System.Text.Encoding]::Default); Remove-Item '${batTmp.replace(/\\/g, '/')}' -Force"`,
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
console.log('[package] 启动辩论赛系统.bat 已生成（GBK 编码，cmd 双击兼容）');

// 5. 打 zip（可选，用 PowerShell 的 Compress-Archive）
try {
  const zipPath = join(root, 'dist-release.zip');
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  execSync(
    `powershell.exe -NoProfile -Command "Compress-Archive -Path '${outDir.replace(/\\/g, '/')}' -DestinationPath '${zipPath.replace(/\\/g, '/')}' -Force"`,
    { stdio: 'inherit' },
  );
  const kb = Math.round(readdirSync(outDir).length);
  console.log(`[package] 已生成 dist-release.zip（可直接发给老师）`);
} catch (err) {
  console.warn('[package] 打 zip 失败（不影响文件夹产物）：', err.message);
}

console.log('\n[package] 完成。分发包内容：');
console.log('  dist-release/');
console.log('  ├─ node.exe                  ← 老师免装 Node');
console.log('  ├─ server/server.js          ← 后端单文件');
console.log('  ├─ client/dist/              ← 前端静态资源');
console.log('  ├─ data/                     ← 运行时写入 SQLite');
console.log('  └─ 启动辩论赛系统.bat        ← 双击启动');
