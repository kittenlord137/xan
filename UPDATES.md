# Updating xan

The installed app updates itself. On start (and every few hours while it is open) it looks for a newer version on GitHub, downloads it in the background, and shows **Restart to update** in the top bar. If you ignore that, the update installs the next time you close the app. **Help > Check for updates** checks right away.

Only the **installed** version updates itself. Running from the folder with `Start xan.bat`, or using the portable exe, does not.

## One-time setup

1. **GitHub account.** Sign up free at https://github.com if you don't have one.
2. **A token**, so the release script can upload for you:
   on github.com click your picture > **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)** > **Generate new token (classic)**.
   Name it "xan releases", tick **public_repo**, generate it, and copy the token (it starts with `ghp_`).
3. **Double-click `Publish update.bat`.** It asks for:
   - your GitHub username, and a name for the repository (press Enter for `xan`),
   - the token (it can remember it for you).

   If the repository doesn't exist yet it offers to create it as a **public** repository. (It must be public: installed apps can't download from a private one.)
4. When it finishes, your installer is in the `dist` folder and on your GitHub Releases page. **Install that one by hand, once.** If you installed an older xan with the earlier setup program, uninstall it first (Windows Settings > Apps) so you don't end up with two.

## Every update after that

1. Change the app however you like.
2. Double-click `Publish update.bat`. It pushes your source code to the repository, picks the next version number, builds the installer, and uploads it.
3. Everyone with xan installed gets it the next time the app starts.

Options (run in a terminal as `npm run release -- <option>`):

| Option | What it does |
| --- | --- |
| `minor` or `major` | Bump the middle or first number instead of the last |
| `--check` | Test the token and repository, change nothing |
| `--dry-run` | Show what would happen, no network, change nothing |
| `--yes` | Don't ask for confirmation |
| `--sync` | Only push the source code to GitHub (no version change, no build) |
| `--no-sync` | Publish without pushing the source code first |

## The source code goes to GitHub automatically

Every time you publish, the script first uploads the files of this folder to the repository as one commit named `Release vX.Y.Z` (only the files that changed), and the version tag points at that commit. `node_modules`, `dist`, `.env` files and logs are never uploaded. If that step fails (for example, the token can't write code), the update still goes out and the script says so.

## If something goes wrong

- **"GitHub did not accept that token"**: the token was copied incompletely, has expired, or was deleted. Make a new one.
- **"is private"**: on the repository's page open Settings, scroll to the bottom and click **Change visibility**.
- **"completely empty"**: open the repository on GitHub and click **Add a README**, then run it again.
- **An installed app never updates**: it was probably not the installed version (see above), or the release was saved as a draft. Open the repository's Releases page and check the newest release is published, not a draft.
- Updates are not code-signed, which is fine for updating. Windows may still show a SmartScreen warning on the very first install.
