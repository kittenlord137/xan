'use strict';
// Runs scripts/release.js against a fake local GitHub API to check every message and decision.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const gitSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

const script = path.join(__dirname, '..', 'scripts', 'release.js');
const realPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + String(detail).slice(0, 300) : ''}`); }
};

// scenario = how the fake GitHub behaves
function startServer(sc) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj || {})); };
      const auth = req.headers.authorization === 'Bearer good-token';
      if (!auth) return send(401, { message: 'Bad credentials' });
      const u = req.url;
      if (u === '/user') return send(200, { login: sc.login || 'victor' });
      if (u === '/user/repos' && req.method === 'POST') {
        if (sc.createFails) return send(403, {});
        sc.exists = true; return send(201, {});
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(u)) {
        if (!sc.exists) return send(404, {});
        return send(200, { private: !!sc.private, default_branch: 'main', permissions: sc.noPush ? { push: false } : { push: true } });
      }
      if (/\/commits\?/.test(u)) return sc.empty ? send(409, { message: 'Git Repository is empty.' }) : send(200, [{ sha: sc.head || 'c0' }]);
      // git data API (just enough to test the source push)
      sc.remote = sc.remote || {};
      sc.blobs = sc.blobs || {};
      sc.tags = sc.tags || {};
      if (/\/git\/trees\/[^?]+\?recursive=1$/.test(u)) {
        return send(200, { sha: 'tree-' + (sc.head || 'c0'), truncated: false, tree: Object.entries(sc.remote).map(([p, sha]) => ({ path: p, type: 'blob', sha })) });
      }
      if (/\/git\/blobs$/.test(u) && req.method === 'POST') {
        if (sc.blobFails) return send(500, {});
        const buf = Buffer.from(JSON.parse(body).content, 'base64');
        const sha = gitSha(buf); sc.blobs[sha] = buf.toString('utf8');
        return send(201, { sha });
      }
      if (/\/git\/trees$/.test(u) && req.method === 'POST') {
        const b = JSON.parse(body);
        sc.pending = Object.assign({}, sc.remote);
        for (const e of b.tree) { if (e.sha === null) delete sc.pending[e.path]; else sc.pending[e.path] = e.sha; }
        sc.treeBase = b.base_tree;
        return send(201, { sha: 'tree-new' });
      }
      if (/\/git\/commits$/.test(u) && req.method === 'POST') {
        const b = JSON.parse(body);
        sc.lastCommit = b; return send(201, { sha: 'c' + (sc.commits = (sc.commits || 0) + 1) + 'abcdef0' });
      }
      if (/\/git\/refs\/heads\/main$/.test(u) && req.method === 'PATCH') {
        sc.remote = sc.pending; sc.head = JSON.parse(body).sha; return send(200, {});
      }
      if (/\/git\/refs$/.test(u) && req.method === 'POST') {
        const b = JSON.parse(body); sc.tags[b.ref] = b.sha; return send(201, {});
      }
      if (/\/releases\/tags\/v/.test(u)) return sc.released ? send(200, {}) : send(404, {});
      return send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

function runScript({ port, args = [], input = '', token = 'good-token', owner = 'victor', version = '1.1.0', files = null, full = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-release-'));
  const pkg = JSON.parse(JSON.stringify(realPkg));
  pkg.version = version;
  pkg.build.publish[0].owner = owner;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [name, content] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { CLIPSQUEEZE_ROOT: dir, GITHUB_API_URL: `http://127.0.0.1:${port}`, GH_TOKEN: token });
    if (full) env.XAN_RELEASE_NO_BUILD = '1';
    if (!token) delete env.GH_TOKEN, delete env.GITHUB_TOKEN;
    const p = spawn(process.execPath, [script, ...(full ? [] : ['--check']), ...args], { env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.stdin.end(input);
    p.on('close', (code) => {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, saved });
    });
  });
}

async function scenario(sc, runOpts) {
  const s = await startServer(sc);
  const r = await runScript(Object.assign({ port: s.port }, runOpts));
  s.server.close();
  r.calls = s.calls;
  r.sc = sc;
  return r;
}

(async () => {
  console.log('release script against a fake GitHub');

  let r = await scenario({ exists: true }, {});
  check('good repo, version not out yet: keeps 1.1.0', r.code === 0 && /1\.1\.0 has not been published yet/.test(r.out) && /Everything looks good/.test(r.out), r.out);
  check('--check never writes the version', r.saved.version === '1.1.0');

  r = await scenario({ exists: true, released: true }, {});
  check('version already out: moves to 1.1.1', r.code === 0 && /already out, so this release will be 1\.1\.1/.test(r.out), r.out);

  r = await scenario({ exists: true }, { args: ['minor'] });
  check('"minor" forces 1.2.0', /1\.1\.0 to 1\.2\.0/.test(r.out), r.out);

  r = await scenario({ exists: true }, { token: 'wrong' });
  check('rejected token is explained', r.code === 1 && /did not accept that token/.test(r.out), r.out);

  r = await scenario({ exists: true, private: true }, {});
  check('private repo is refused with the fix', r.code === 1 && /is private/.test(r.out) && /Change visibility/.test(r.out), r.out);

  r = await scenario({ exists: true, noPush: true }, {});
  check('read-only token is refused', r.code === 1 && /not allowed to write/.test(r.out), r.out);

  r = await scenario({ exists: true, empty: true }, {});
  check('empty repo is refused with the fix', r.code === 1 && /completely empty/.test(r.out) && /README/.test(r.out), r.out);

  r = await scenario({ exists: false }, { input: 'y\n' });
  check('missing repo: offers to create, creates it, carries on', r.code === 0 && /Created it/.test(r.out) && r.calls.includes('POST /user/repos'), r.out);

  r = await scenario({ exists: false }, { input: 'n\n' });
  check('missing repo, answer no: stops with instructions', r.code === 1 && /github\.com\/new/.test(r.out) && !r.calls.includes('POST /user/repos'), r.out);

  r = await scenario({ exists: false, createFails: true }, { input: '\n' });
  check('missing repo, token cannot create: manual instructions', r.code === 1 && /create it yourself/i.test(r.out), r.out);

  r = await scenario({ exists: false, login: 'someone-else' }, {});
  check('owner is not the token account: explained, nothing created', r.code === 1 && /belongs to "someone-else"/.test(r.out) && !r.calls.includes('POST /user/repos'), r.out);

  r = await scenario({ exists: true }, { owner: 'YOUR-GITHUB-USERNAME', input: 'victor\n\n' });
  check('placeholder owner: asks and saves it', r.code === 0 && r.saved.build.publish[0].owner === 'victor' && r.saved.build.publish[0].repo === 'xan', JSON.stringify(r.saved.build.publish));

  r = await scenario({ exists: true }, { token: '', input: 'good-token\nn\n' });
  check('no token set: asks for it and explains how to get one', r.code === 0 && /public_repo/.test(r.out) && /Everything looks good/.test(r.out), r.out);


  console.log('\npushing the source on every release');
  const src = {
    'main.js': 'console.log(1)\n', 'README.md': '# xan\n', 'renderer/app.js': 'x\n', 'lib/ffmpeg.js': 'y\n',
    'node_modules/dep/index.js': 'no\n', 'dist/xan Setup.exe': 'no\n', '.env': 'SECRET=1\n', 'debug.log': 'no\n',
  };
  r = await scenario({ exists: true }, { full: true, args: ['--yes'], files: src });
  check('release pushes the source, then tags the new commit', r.code === 0 && /Source pushed: 5 files changed/.test(r.out), r.out);
  const pushed = Object.keys(r.sc.remote).sort();
  check('source files are on GitHub', ['README.md', 'lib/ffmpeg.js', 'main.js', 'package.json', 'renderer/app.js'].every((f) => pushed.includes(f)), pushed.join());
  check('node_modules, dist, secrets and logs are never pushed', !pushed.some((f) => /node_modules|dist|\.env|\.log/.test(f)), pushed.join());
  check('uploaded content is right', r.sc.remote['main.js'] === gitSha(Buffer.from('console.log(1)\n')));
  check('commit is named after the release and has the old head as parent', r.sc.lastCommit.message === 'Release v1.1.0' && r.sc.lastCommit.parents[0] === 'c0', JSON.stringify(r.sc.lastCommit));
  check('the tag points at the new commit, not the old one', r.sc.tags['refs/tags/v1.1.0'] === r.sc.head && r.sc.head !== 'c0', JSON.stringify(r.sc.tags));
  check('the version in the pushed package.json is the released one', r.sc.blobs[r.sc.remote['package.json']].includes('"version": "1.1.0"'));

  // second release with one changed file and one removed file: only the changes go up
  const remote0 = {};
  for (const [n, c] of Object.entries({ 'main.js': 'console.log(1)\n', 'README.md': '# xan\n', 'renderer/app.js': 'x\n', 'lib/old.js': 'gone\n', 'notes-from-github.txt': 'mine\n' })) remote0[n] = gitSha(Buffer.from(c));
  r = await scenario({ exists: true, released: true, remote: remote0 }, { full: true, args: ['--yes'], files: Object.assign({}, src, { 'renderer/app.js': 'changed\n' }) });
  check('already released: version moves up and source goes with it', r.code === 0 && /already out, so this release will be 1\.1\.1/.test(r.out) && r.sc.lastCommit.message === 'Release v1.1.1', r.out);
  check('only changed files are uploaded', Object.keys(r.sc.blobs).length === 3, Object.keys(r.sc.blobs).length);   // app.js, lib/ffmpeg.js and package.json; main.js and README are unchanged
  check('a file deleted from a source folder is deleted on GitHub', !('lib/old.js' in r.sc.remote), Object.keys(r.sc.remote).join());
  check('files only GitHub has (outside the source folders) are left alone', 'notes-from-github.txt' in r.sc.remote);

  // package.json differs from what GitHub has, so even a one-file project pushes it
  const same = {};
  for (const [n, c] of Object.entries({ 'main.js': 'console.log(1)\n' })) same[n] = gitSha(Buffer.from(c));
  r = await scenario({ exists: true, remote: Object.assign({}, same) }, { full: true, args: ['--yes'], files: { 'main.js': 'console.log(1)\n' } });
  check('a changed package.json alone is still pushed', /Source pushed: 1 file changed/.test(r.out), r.out);

  r = await scenario({ exists: true }, { full: true, args: ['--yes', '--no-sync'], files: src });
  check('--no-sync skips the source push', r.code === 0 && !r.calls.some((c) => /git\/blobs|git\/commits/.test(c)) && /Done\. v1\.1\.0 is published/.test(r.out), r.out);

  r = await scenario({ exists: true }, { full: true, args: ['--sync'], files: src });
  check('--sync pushes only the source: no tag, no build, no version change', r.code === 0 && /Source pushed/.test(r.out) && !r.calls.some((c) => /git\/refs$/.test(c)) && r.saved.version === '1.1.0' && !/Done\./.test(r.out), r.out);
  check('--sync names the commit after the version', r.sc.lastCommit.message === 'Update source (v1.1.0)', r.sc.lastCommit && r.sc.lastCommit.message);

  r = await scenario({ exists: true, blobFails: true }, { full: true, args: ['--yes'], files: src });
  check('if the source push fails the release still goes out, with a clear message', r.code === 0 && /Could not push the source code/.test(r.out) && /Done\. v1\.1\.0 is published/.test(r.out), r.out);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
