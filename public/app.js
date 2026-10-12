const $ = id => document.getElementById(id);
let token = '', directory = '.', file = null, dirty = false, running = false;
const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
async function api(route, input) {
  const response = await fetch(route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
const join = name => directory === '.' ? name : `${directory}/${name}`;
const protect = () => !dirty || confirm('当前文件有未保存的修改，确定放弃吗？');
const action = fn => async event => { event?.preventDefault(); try { await fn(); } catch (error) { status(error.message, true); } };
async function list() {
  const { entries } = await api(`/api/files?path=${encodeURIComponent(directory)}`);
  $('directory').textContent = directory; $('command-cwd').textContent = directory;
  $('up').disabled = directory === '.';
  $('file-list').replaceChildren();
  if (!entries.length) { const li = document.createElement('li'); li.textContent = '这个文件夹是空的'; $('file-list').append(li); }
  for (const entry of entries) {
    const li = document.createElement('li'), button = document.createElement('button');
    button.textContent = `${entry.directory ? '📁' : entry.symlink ? '↗' : '📄'} ${entry.name}`;
    button.addEventListener('click', action(async () => {
      if (!protect()) return;
      const target = join(entry.name);
      if (entry.directory) { const previous = directory; directory = target; try { await list(); } catch (error) { directory = previous; throw error; } }
      else { const result = await api(`/api/file?path=${encodeURIComponent(target)}`); file = target; dirty = false; $('file-path').textContent = file; $('content').value = result.content; $('content').disabled = false; $('save').disabled = false; status('文件已打开'); }
    }));
    li.append(button); $('file-list').append(li);
  }
}
$('pair-form').addEventListener('submit', action(async () => {
  token = $('token').value.trim();
  const info = await api('/api/info');
  $('root').textContent = info.root; $('system').textContent = info.platform === 'darwin' ? 'macOS' : info.platform;
  await list(); $('pair').hidden = true; $('workspace').hidden = false; $('disconnect').hidden = false; $('token').value = ''; status('连接成功');
}));
$('disconnect').addEventListener('click', () => {
  if (!protect()) return;
  token = ''; file = null; directory = '.'; dirty = false;
  $('content').value = ''; $('content').disabled = true; $('save').disabled = true;
  $('file-path').textContent = '选择一个文本文件'; $('output').textContent = '命令结果会显示在这里。';
  $('workspace').hidden = true; $('pair').hidden = false; $('disconnect').hidden = true;
  status(running ? '页面已断开；正在运行的命令仍会运行到完成或超时。' : '页面已断开；关闭终端中的代理可停止服务。');
});
$('refresh').addEventListener('click', action(list));
$('up').addEventListener('click', action(async () => {
  if (!protect()) return;
  const previous = directory; directory = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.';
  try { await list(); } catch (error) { directory = previous; throw error; }
}));
$('content').addEventListener('input', () => { dirty = true; });
$('save').addEventListener('click', action(async () => {
  if (!file || !confirm(`保存并覆盖 ${file}？`)) return;
  const snapshot = $('content').value;
  await api('/api/file', { path: file, content: snapshot }); dirty = $('content').value !== snapshot; status('文件已保存');
}));
for (const [id, route, kind] of [['new-file', '/api/file', '文件'], ['new-directory', '/api/directory', '文件夹']]) {
  $(id).addEventListener('click', action(async () => {
    const name = prompt(`输入新${kind}名称（当前目录内）：`);
    if (name === null) return;
    if (!name.trim() || name.includes('/') || name === '.' || name === '..') throw new Error('请输入单个有效名称');
    await api(route, { path: join(name), content: '', create: true }); await list(); status(`${kind}已创建`);
  }));
}
$('command-form').addEventListener('submit', action(async () => {
  if (running) return;
  const command = $('command').value;
  if (!confirm(`将在你的电脑上执行以下命令，以你的账户权限运行：\n\n${command}\n\n执行目录：${directory}\n确认执行？`)) return;
  running = true; $('execute').disabled = true; $('command-state').textContent = '执行中…'; $('output').textContent = '等待命令结束（最多 30 秒）…';
  try {
    const result = await api('/api/command', { command, cwd: directory });
    if (!token) return;
    $('output').textContent = result.output || '（没有输出）';
    $('command-state').textContent = result.timedOut ? '已超时终止' : result.truncated ? '输出过大，已终止' : `退出状态：${result.code ?? result.signal}`;
    status(result.code === 0 ? '命令执行完成' : '命令未正常完成，请查看输出', result.code !== 0); await list();
  } finally { running = false; $('execute').disabled = false; }
}));
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
