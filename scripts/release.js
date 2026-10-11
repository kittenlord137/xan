'use strict';
/*
 * One-command release: builds the Windows installer and uploads it to GitHub Releases.
 * Installed copies of xan find it on their next start and update themselves.
 *
 *   node scripts/release.js                 publish the current version (or the next patch if it is already out)
 *   node scripts/release.js minor|major     force a version bump first
 *   node scripts/release.js --yes           don't ask for confirmation
 *   node scripts/release.js --check         check the token and repository, then stop
 *   node scripts/release.js --dry-run       show what would happen, change nothing, no network
 *
 * Needs a GitHub personal access token in the GH_TOKEN environment variable (it asks if it is missing).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const root = process.env.CLIPSQUEEZE_ROOT || path.join(__dirname, '..');
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const pkgPath = path.join(root, 'package.json');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const YES = argv.includes('--yes');
const CHECK = argv.includes('--check');
const FORCE_KIND = ['major', 'minor', 'patch'].find((k) => argv.includes(k)) || null;
const PLACEHOLDER = /^YOUR-/i;

const loadPkg = () => JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const savePkg = (p) => fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2) + '\n');

function bump(v, kind) {
  const [a, b, c] = String(v).split('.').map((n) => parseInt(n, 10) || 0);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

// ---- prompts (one shared reader, so piped input works too)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const queued = [];
let waiting = null;
let closed = false;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else queued.push(l); });
rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
function ask(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    if (queued.length) resolve(queued.shift().trim());
    else if (closed) resolve('');
    else waiting = (l) => resolve(l.trim());
  });
}
const yes = (s, dflt) => (s === '' ? dflt : /^y/i.test(s));

function die(msg) {
  console.error('\n' + msg + '\n');
  process.exit(1);
}

async function gh(method, url, token, body) {
  const res = await fetch(API + url, {
    method,
    headers: Object.assign({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'clipsqueeze-release',
    }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, data };
}

const TOKEN_HELP = `
How to get a token (one time, about 2 minutes):
  1. On github.com open: your picture > Settings > Developer settings >
     Personal access tokens > Tokens (classic) > Generate new token (classic)
  2. Name it "xan releases", tick the box "public_repo", and generate it.
  3. Copy the token (it starts with ghp_) and paste it below.
  The token stays on your computer. Anyone who has it can change your public repositories,
  so keep it private; you can delete it on GitHub at any time.`;

async function main() {
  if (typeof fetch !== 'function' && !DRY) die('This needs a newer Node.js. Install the LTS version from https://nodejs.org and try again.');

  const pkg = loadPkg();
  const pub = (pkg.build.publish || [])[0];
  if (!pub || pub.provider !== 'github') die('package.json has no GitHub publish settings (build.publish).');

  // ---- 1. which GitHub repository?
  if (!pub.owner || PLACEHOLDER.test(pub.owner) || !pub.repo) {
    console.log('\nFirst time setup: where should updates be published?');
    let owner = '';
    while (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) owner = await ask('Your GitHub username: ');
    let repo = await ask('Name for the updates repository [xan]: ');
    if (!repo) repo = 'xan';
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) die('That repository name has characters GitHub does not allow.');
    pub.owner = owner;
    pub.repo = repo;
    if (!DRY) savePkg(pkg);
  }
  const slug = `${pub.owner}/${pub.repo}`;
  console.log(`\nUpdates go to https://github.com/${slug}`);

  // ---- 2. token
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token && !DRY) {
    console.log(TOKEN_HELP);
    token = await ask('\nPaste your token: ');
    if (!token) die('No token, nothing was published.');
    const keep = yes(await ask('Remember it on this computer for next time? (Windows user settings) [y/N]: '), false);
    if (keep && process.platform === 'win32') {
      const r = spawnSync('setx', ['GH_TOKEN', token], { shell: true, stdio: 'ignore' });
      console.log(r.status === 0 ? 'Saved. (It is used the next time you open a new window.)' : 'Could not save it; you will be asked again next time.');
    }
  }

  // ---- 3. check the repo and the token before the slow build
  let alreadyReleased = false;
  let headSha = null;
  if (!DRY) {
    const me = await gh('GET', '/user', token);
    if (me.status === 401) die('GitHub did not accept that token. Check that it was copied completely and has not expired.');
    if (me.status !== 200) die(`Could not talk to GitHub (status ${me.status}). Check your internet connection.`);
    const login = me.data.login;

    let repoRes = await gh('GET', `/repos/${slug}`, token);
    if (repoRes.status === 404) {
      if (login.toLowerCase() !== pub.owner.toLowerCase()) {
        die(`The repository ${slug} does not exist, and this token belongs to "${login}", not "${pub.owner}".\nFix the owner name in package.json (build.publish.owner) or create the repository yourself.`);
      }
      const make = yes(await ask(`\nThe repository ${slug} does not exist yet. Create it now as a public repository? [Y/n]: `), true);
      if (!make) die('Create it at https://github.com/new (Public, tick "Add a README"), then run this again.');
      const created = await gh('POST', '/user/repos', token, {
        name: pub.repo, private: false, auto_init: true,
        description: 'xan installers and updates',
      });
      if (created.status !== 201) {
        die(`GitHub would not let this token create the repository (status ${created.status}).\nCreate it yourself at https://github.com/new (Public, tick "Add a README"), then run this again.`);
      }
      console.log('Created it.');
      repoRes = await gh('GET', `/repos/${slug}`, token);
    }
    if (repoRes.status !== 200) die(`Could not open ${slug} (status ${repoRes.status}). Check the name and that the token can see it.`);
    if (repoRes.data.private) {
      die(`${slug} is private. Installed copies cannot download updates from a private repository.\nMake it public: repository Settings > scroll to the bottom > Change visibility. Then run this again.`);
    }
    if (repoRes.data.permissions && repoRes.data.permissions.push === false) {
      die(`This token is not allowed to write to ${slug}.`);
    }
    const commits = await gh('GET', `/repos/${slug}/commits?per_page=1`, token);
    if (commits.status === 409) die(`${slug} is completely empty. Open it on GitHub, click "Add a README" and commit it, then run this again.`);
    if (commits.status === 200 && Array.isArray(commits.data) && commits.data[0]) headSha = commits.data[0].sha;

    const rel = await gh('GET', `/repos/${slug}/releases/tags/v${pkg.version}`, token);
    alreadyReleased = rel.status === 200;
  }

  // ---- 4. version
  const oldVersion = pkg.version;
  let newVersion = oldVersion;
  if (FORCE_KIND) newVersion = bump(oldVersion, FORCE_KIND);
  else if (alreadyReleased) newVersion = bump(oldVersion, 'patch');
  if (newVersion === oldVersion) console.log(`\nVersion ${newVersion} has not been published yet, so that is the one going out.`);
  else if (FORCE_KIND) console.log(`\nBumping the version from ${oldVersion} to ${newVersion}.`);
  else console.log(`\nVersion ${oldVersion} is already out, so this release will be ${newVersion}.`);

  if (CHECK) {
    console.log('\nEverything looks good: the token works and the repository is ready. (--check: nothing was changed.)');
    return;
  }

  if (DRY) {
    console.log(`\n[dry run] Would publish v${newVersion} to ${slug} with: npx electron-builder --win nsis --publish always`);
    console.log('[dry run] Nothing was changed.');
    return;
  }
  if (!YES && !yes(await ask(`\nBuild and publish v${newVersion} now? This takes a few minutes. [Y/n]: `), true)) die('Cancelled. Nothing was published.');

  if (newVersion !== oldVersion) { pkg.version = newVersion; savePkg(pkg); }

  // ---- 5. make sure the version tag exists (GitHub refuses to publish a release without one)
  if (headSha) {
    const tag = await gh('POST', `/repos/${slug}/git/refs`, token, { ref: `refs/tags/v${newVersion}`, sha: headSha });
    if (tag.status !== 201 && tag.status !== 422) {
      if (newVersion !== oldVersion) { pkg.version = oldVersion; savePkg(pkg); }
      die(`Could not create the tag v${newVersion} on ${slug} (status ${tag.status}${tag.data && tag.data.message ? ': ' + tag.data.message : ''}).`);
    }
  }

  // ---- 6. build and upload
  console.log('\nBuilding the installer and uploading it...\n');
  const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], {
    cwd: root, stdio: 'inherit', shell: true, env: Object.assign({}, process.env, { GH_TOKEN: token }),
  });
  if (r.status !== 0) {
    if (newVersion !== oldVersion) { pkg.version = oldVersion; savePkg(pkg); }
    die('The build or upload failed (see the messages above). The version number was put back, so you can simply run this again.');
  }

  console.log(`\nDone. v${newVersion} is published:`);
  console.log(`  https://github.com/${slug}/releases/tag/v${newVersion}`);
  console.log('Installed copies of xan will update themselves the next time they start.');
  console.log('The installer is also in the "dist" folder if you want to install it on another computer.');
}

main().then(() => rl.close(), (e) => { console.error(e); process.exit(1); });
