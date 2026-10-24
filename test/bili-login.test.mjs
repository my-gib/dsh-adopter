// B站扫码登录工具的测试：只测纯逻辑（收 cookie / 写盘），**不连网、不发 QQ**。
//   node --test test/
//
// 这两条最容易被「顺手优化」改坏，所以钉死：
//   ① SESSDATA 不能被二次解码（`%2C` 变逗号，整条 cookie 就废了）
//   ② 凭证文件无 BOM、字段全小写、写之前先备份
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectCandidates, isPngFile, parseSetCookieList, writeCredential } from '../tools/bili-login.mjs';

// ── Set-Cookie 解析 ─────────────────────────────────────────────────

test('从 Set-Cookie 里只收要的 4 个字段，键统一小写', () => {
  const found = parseSetCookieList([
    'SESSDATA=abc%2C123%2Axy; Path=/; Domain=.bilibili.com; HttpOnly; Secure',
    'bili_jct=deadbeefdeadbeefdeadbeefdeadbeef; Path=/',
    'DedeUserID=1234567890; Path=/',
    'buvid3=8C57A2B1-1111-2222-3333-444455556666infoc; Path=/',
    'sid=whatever; Path=/',
  ]);
  assert.deepEqual(Object.keys(found).sort(), ['bili_jct', 'buvid3', 'dedeuserid', 'sessdata']);
  assert.equal(found.sessdata, 'abc%2C123%2Axy', '编码形态要原样保留，不能解码');
  assert.equal(found.dedeuserid, '1234567890');
  assert.equal(found.sid, undefined, '不相干的 cookie 不许混进来');
});

test('同一个 cookie 出现两次时留第一次的值', () => {
  const found = parseSetCookieList(['SESSDATA=first;Path=/', 'SESSDATA=second;Path=/']);
  assert.equal(found.sessdata, 'first');
});

// ── data.url（crossDomain 的 gourl）这条路 ──────────────────────────

// 这是 B站成功响应的真实形状：gourl 里嵌套一层，SESSDATA 的 %2C 被编码成 %252C。
const POLL_URL_WITH_GOURl =
  'https://passport.biligame.com/x/passport-login/web/crossDomain?gourl=' +
  'https%3A%2F%2Fpassport.biligame.com%2Fx%2Fpassport-login%2Fweb%2Fcookie' +
  '%3FSESSDATA%3Dabc%252C123%252Axy%26bili_jct%3Ddeadbeefdeadbeefdeadbeefdeadbeef' +
  '%26DedeUserID%3D1234567890%26buvid3%3D8C57A2B1-1111-2222-3333-444455556666infoc';

test('data.url 的 gourl 里能抠出 cookie，且 SESSDATA 保持 %2C 形态', () => {
  const candidates = collectCandidates([], POLL_URL_WITH_GOURl);
  assert.ok(candidates.length >= 1, '至少要收到一份候选');
  const raw = candidates.find((item) => item.source === 'gourl-raw');
  assert.ok(raw, '应该有一个 gourl-raw 候选');
  assert.equal(raw.sessdata, 'abc%2C123%2Axy', '关键：解一层后 %2C 必须还在，不能变逗号');
  assert.equal(raw.bili_jct, 'deadbeefdeadbeefdeadbeefdeadbeef');
  assert.equal(raw.dedeuserid, '1234567890');
});

test('Set-Cookie 排在候选第一位，并且同一个 sessdata 不重复收集', () => {
  const candidates = collectCandidates(
    ['SESSDATA=fromHeader%2C1;Path=/', 'bili_jct=aaaabbbbccccddddeeeeffff00001111;Path=/'],
    POLL_URL_WITH_GOURl,
  );
  assert.equal(candidates[0].source, 'set-cookie');
  const sessdatas = candidates.map((item) => item.sessdata);
  assert.equal(new Set(sessdatas).size, sessdatas.length, '候选之间不许有重复的 sessdata');
});

test('没有 Set-Cookie 也没有 data.url 时返回空数组，不抛错', () => {
  assert.deepEqual(collectCandidates([], ''), []);
});

// ── 写盘：无 BOM、字段顺序、先备份 ──────────────────────────────────

test('写凭证：无 BOM、字段全小写、顺序照原文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-cred-'));
  const file = join(dir, 'bili_credential.json');
  try {
    const result = writeCredential(
      { sessdata: 's1', bili_jct: 'j1', buvid3: 'b1', dedeuserid: 'd1' },
      { filePath: file },
    );
    assert.equal(result.backupPath, null, '原来没有旧文件就不该造备份');

    const raw = readFileSync(file);
    assert.notEqual(raw.subarray(0, 3).toString('hex'), 'efbbbf', '不许有 UTF-8 BOM');
    const parsed = JSON.parse(raw.toString('utf8'));
    assert.deepEqual(Object.keys(parsed), ['sessdata', 'bili_jct', 'buvid3', 'dedeuserid']);
    assert.equal(parsed.sessdata, 's1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写凭证前先备份旧文件（.bak-<时间戳>），备份内容就是旧的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-cred-bak-'));
  const file = join(dir, 'bili_credential.json');
  try {
    writeFileSync(file, '{"sessdata":"old"}', 'utf8');
    const result = writeCredential(
      { sessdata: 'new', bili_jct: 'j1', buvid3: 'b1', dedeuserid: 'd1' },
      { filePath: file },
    );
    assert.ok(result.backupPath, '应该给出备份路径');
    assert.match(result.backupPath, /\.bak-\d{8}-\d{6}$/);
    assert.ok(existsSync(result.backupPath));
    assert.equal(readFileSync(result.backupPath, 'utf8'), '{"sessdata":"old"}');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessdata, 'new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('关键字段缺了就不写盘（buvid3 可以空，其余不行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-cred-miss-'));
  const file = join(dir, 'bili_credential.json');
  try {
    assert.throws(
      () => writeCredential({ sessdata: '', bili_jct: 'j', buvid3: 'b', dedeuserid: 'd' }, { filePath: file }),
      /缺字段 sessdata/,
    );
    assert.throws(
      () => writeCredential({ sessdata: 's', bili_jct: 'j', buvid3: 'b', dedeuserid: '' }, { filePath: file }),
      /缺字段 dedeuserid/,
    );
    assert.equal(existsSync(file), false, '失败时一个字都不该写');

    // buvid3 拿不到不至于把这次扫码作废
    writeCredential({ sessdata: 's', bili_jct: 'j', buvid3: '', dedeuserid: 'd' }, { filePath: file });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).buvid3, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── PNG 识别 ────────────────────────────────────────────────────────

test('isPngFile 只认 PNG 魔数 89 50 4E 47', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-png-'));
  try {
    const png = join(dir, 'a.png');
    const txt = join(dir, 'b.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    writeFileSync(txt, Buffer.from('not a png', 'utf8'));
    assert.equal(isPngFile(png), true);
    assert.equal(isPngFile(txt), false);
    assert.equal(isPngFile(join(dir, 'missing.png')), false, '文件不存在返回 false，不抛');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
