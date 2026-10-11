'use strict';
// Runs scripts/release.js against a fake local GitHub API to check every message and decision.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

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
        return send(200, { private: !!sc.private, permissions: sc.noPush ? { push: false } : { push: true } });
      }
      if (/\/commits\?/.test(u)) return sc.empty ? send(409, { message: 'Git Repository is empty.' }) : send(200, [{}]);
      if (/\/releases\/tags\/v/.test(u)) return sc.released ? send(200, {}) : send(404, {});
      return send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

function runScript({ port, args = [], input = '', token = 'good-token', owner = 'victor', version = '1.1.0' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-release-'));
  const pkg = JSON.parse(JSON.stringify(realPkg));
  pkg.version = version;
  pkg.build.publish[0].owner = owner;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { CLIPSQUEEZE_ROOT: dir, GITHUB_API_URL: `http://127.0.0.1:${port}`, GH_TOKEN: token });
    if (!token) delete env.GH_TOKEN, delete env.GITHUB_TOKEN;
    const p = spawn(process.execPath, [script, '--check', ...args], { env });
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
