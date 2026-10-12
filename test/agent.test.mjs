import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../server.mjs';
import { request as httpRequest } from 'node:http';

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'local-control-'));
  const root = path.join(base, 'root'); await fs.mkdir(root);
  const agent = await createAgent({ root, ...options });
  await new Promise(resolve => agent.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${agent.server.address().port}`;
  t.after(async () => { await new Promise(resolve => agent.server.close(resolve)); await fs.rm(base, { recursive: true, force: true }); });
  const request = (route, input, headers = {}) => fetch(origin + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${agent.token}`, ...(input === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  return { base, root, origin, request };
}

test('UI, authentication, origin and Host protection', async t => {
  const f = await fixture(t);
  const page = await fetch(f.origin);
  assert.equal(page.status, 200); assert.match(await page.text(), /本地控制台/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(f.origin + '/api/info')).status, 401);
  assert.equal((await f.request('/api/info', undefined, { Origin: 'https://evil.example' })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin + '/api/info', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await (await f.request('/api/info')).json()).root, f.root);
});
test('lists, creates, reads and edits real files without replacing on create', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/directory', { path: 'documents' })).status, 201);
  assert.equal((await f.request('/api/file', { path: 'documents/note.txt', content: '你好', create: true })).status, 200);
  assert.equal((await (await f.request('/api/file?path=documents/note.txt')).json()).content, '你好');
  assert.equal((await f.request('/api/file', { path: 'documents/note.txt', content: 'overwrite', create: true })).status, 409);
  assert.equal((await f.request('/api/file', { path: 'documents/note.txt', content: '修改' })).status, 200);
  assert.equal(await fs.readFile(path.join(f.root, 'documents/note.txt'), 'utf8'), '修改');
  assert.equal((await (await f.request('/api/files?path=documents')).json()).entries[0].name, 'note.txt');
});
test('blocks traversal, external symlinks and dangling symlink writes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.base, 'outside'), 'private');
  await fs.symlink(f.base, path.join(f.root, 'external'));
  await fs.symlink(path.join(f.base, 'missing'), path.join(f.root, 'dangling'));
  for (const route of ['/api/file?path=../outside', '/api/file?path=external/outside', '/api/files?path=/tmp']) {
    assert.ok([400, 403].includes((await f.request(route)).status));
  }
  assert.equal((await f.request('/api/file', { path: 'external/new', content: 'x' })).status, 403);
  assert.equal((await f.request('/api/file', { path: 'dangling', content: 'x' })).status, 403);
  await assert.rejects(fs.stat(path.join(f.base, 'missing')), { code: 'ENOENT' });
});
test('requires same-origin verification for mutations', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/file', { path: 'x', content: 'x' }, { Origin: '' })).status, 403);
  assert.equal((await f.request('/api/command', { command: 'pwd' }, { Origin: 'https://evil.example' })).status, 403);
});
test('commands use selected directory and capture output and failure status', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'sub'));
  const result = await (await f.request('/api/command', { command: "pwd; printf 'ok' > result.txt; printf 'stderr' >&2; exit 7", cwd: 'sub' })).json();
  assert.equal(result.code, 7); assert.match(result.output, /sub/); assert.match(result.output, /stderr/);
  assert.equal(await fs.readFile(path.join(f.root, 'sub/result.txt'), 'utf8'), 'ok');
  assert.equal((await f.request('/api/command', { command: 'pwd', cwd: '..' })).status, 403);
});
test('terminates timeout and runs subsequent commands', async t => {
  const f = await fixture(t, { timeout: 150 });
  const result = await (await f.request('/api/command', { command: 'sleep 10' })).json();
  assert.equal(result.timedOut, true); assert.notEqual(result.code, 0);
  const next = await (await f.request('/api/command', { command: 'printf ready' })).json();
  assert.equal(next.output, 'ready'); assert.equal(next.code, 0);
});
test('limits output and rejects parallel execution', async t => {
  const f = await fixture(t);
  const large = await (await f.request('/api/command', { command: 'yes x' })).json();
  assert.equal(large.truncated, true); assert.ok(Buffer.byteLength(large.output) <= 1024 * 1024);
  const first = f.request('/api/command', { command: 'sleep 0.3' });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal((await f.request('/api/command', { command: 'pwd' })).status, 409);
  assert.equal((await (await first).json()).code, 0);
});
test('rejects binary, invalid UTF-8, oversized files and requests', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'binary'), Buffer.from([0, 1]));
  await fs.writeFile(path.join(f.root, 'invalid'), Buffer.from([255]));
  await fs.writeFile(path.join(f.root, 'large'), Buffer.alloc(1024 * 1024 + 1, 65));
  assert.equal((await f.request('/api/file?path=binary')).status, 400);
  assert.equal((await f.request('/api/file?path=invalid')).status, 400);
  assert.equal((await f.request('/api/file?path=large')).status, 413);
  assert.equal((await f.request('/api/file', { path: 'new', content: 'x'.repeat(1024 * 1024) })).status, 413);
});
