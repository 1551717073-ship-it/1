import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const LIMIT = 1024 * 1024;
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) fail(413, '请求超过 1 MB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { fail(400, '请求必须是 JSON'); }
}

export async function createAgent({ root, token = randomBytes(24).toString('hex'), timeout = 30000 }) {
  root = await fs.realpath(root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('工作目录必须是文件夹');
  const inside = candidate => { const relative = path.relative(root, candidate); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
  async function resolve(relative = '.', create = false) {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) fail(400, '请使用工作目录内的相对路径');
    const target = path.resolve(root, relative);
    if (!inside(target)) fail(403, '路径超出工作目录');
    let real;
    try { real = await fs.realpath(target); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      const parent = await fs.realpath(path.dirname(target));
      if (!inside(parent)) fail(403, '路径超出工作目录');
      // A dangling symlink must never be followed when creating a file.
      try { await fs.lstat(target); fail(403, '不能写入失效的符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      real = path.join(parent, path.basename(target));
    }
    if (!inside(real)) fail(403, '符号链接指向工作目录之外');
    return real;
  }
  let active = false, activeChild;
  const stop = () => { if (activeChild?.pid) { try { process.kill(-activeChild.pid, 'SIGKILL'); } catch {} } };
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== host) fail(403, '无效的访问地址，请使用 127.0.0.1');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) fail(403, '不允许其他网站访问本地代理');
      const url = new URL(req.url, `http://${host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') fail(405, '不支持的方法');
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        const asset = assets[url.pathname];
        if (!asset) fail(404, '页面不存在');
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
        res.end(await fs.readFile(path.join(publicDir, asset[0]))); return;
      }
      const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail(401, '配对码无效');
      if (req.method === 'GET' && url.pathname === '/api/info') {
        json(200, { root, platform: process.platform, timeoutSeconds: timeout / 1000 }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        const directory = await resolve(url.searchParams.get('path') || '.');
        const entries = await fs.readdir(directory, { withFileTypes: true });
        json(200, { entries: entries.map(e => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const file = await resolve(url.searchParams.get('path'));
        const stat = await fs.stat(file);
        if (!stat.isFile()) fail(400, '请选择文本文件');
        if (stat.size > LIMIT) fail(413, '仅支持不超过 1 MB 的文本文件');
        const data = await fs.readFile(file);
        if (data.includes(0)) fail(400, '不支持二进制文件');
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
        catch { fail(400, '仅支持 UTF-8 文本文件'); }
        json(200, { content }); return;
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== `http://${host}`) fail(403, '缺少同源验证');
        if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '请发送 JSON');
        const input = await body(req);
        if (!input || typeof input !== 'object') fail(400, '无效的请求');
        if (url.pathname === '/api/file') {
          if (typeof input.content !== 'string') fail(400, '缺少文本内容');
          const file = await resolve(input.path, true);
          await fs.writeFile(file, input.content, { flag: input.create === true ? 'wx' : 'w' });
          json(200, { saved: true }); return;
        }
        if (url.pathname === '/api/directory') {
          const directory = await resolve(input.path, true);
          await fs.mkdir(directory); json(201, { created: true }); return;
        }
        if (url.pathname === '/api/command') {
          if (active) fail(409, '已有命令正在执行');
          if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 10000) fail(400, '请输入有效命令');
          const cwd = await resolve(input.cwd || '.');
          if (!(await fs.stat(cwd)).isDirectory()) fail(400, '执行目录必须是文件夹');
          active = true;
          try {
            const result = await new Promise((accept, reject) => {
              const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
              const child = spawn(shell, ['-c', input.command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
              activeChild = child;
              let output = '', bytes = 0, timedOut = false, truncated = false, forceTimer;
              const signal = sig => { try { process.kill(-child.pid, sig); } catch {} };
              const stop = () => { signal('SIGTERM'); forceTimer ??= setTimeout(() => signal('SIGKILL'), 1000); };
              const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
              const collect = chunk => {
                const remaining = Math.max(0, LIMIT - bytes);
                output += chunk.subarray(0, remaining).toString(); bytes += chunk.length;
                if (bytes > LIMIT) { truncated = true; stop(); }
              };
              child.stdout.on('data', collect); child.stderr.on('data', collect);
              child.once('error', error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
              child.once('close', (code, sig) => { clearTimeout(timer); clearTimeout(forceTimer); signal('SIGKILL'); accept({ output, code, signal: sig, timedOut, truncated }); });
            });
            json(200, result); return;
          } finally { active = false; activeChild = undefined; }
        }
      }
      fail(404, '接口不存在');
    } catch (error) {
      const status = error.status || ({ ENOENT: 404, EEXIST: 409, EACCES: 403, ENOTDIR: 400, EISDIR: 400 }[error.code]) || 500;
      json(status, { error: status === 500 ? '本地操作失败，请检查目录权限和请求参数' : error.message });
    }
  });
  server.on('close', stop);
  return { server, token, root, stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('用法: node server.mjs [--root 工作目录] [--port 4317]');
  } else {
    if (args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--root', '--port'].includes(arg))) throw new Error('参数无效；使用 --help 查看用法');
    const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const port = Number(value('--port') || 4317);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535');
    const agent = await createAgent({ root: value('--root') || process.cwd() });
    agent.server.on('error', error => { console.error(`启动失败: ${error.message}`); process.exitCode = 1; });
    const shutdown = () => { agent.stop(); agent.server.closeAllConnections(); agent.server.close(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    agent.server.listen(port, '127.0.0.1', () => {
      console.log(`本地控制台: http://127.0.0.1:${port}\n工作目录: ${agent.root}\n临时配对码: ${agent.token}\n按 Control+C 关闭代理。请勿分享配对码。`);
    });
  }
}
