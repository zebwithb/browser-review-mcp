# Browser Review

Review your own dev app in Brave, Chrome or Firefox the way you would
in Figma, and let your coding agent fix it. Works with Claude Code, Codex and
any other agent that supports MCP.

- **Comment** on the whole page or on one element. A numbered pin marks it.
- **Remove** an element (like an adblocker's element picker). It disappears right
  away, stays gone after a reload, and can be undone.
- **Edit** an element's text and CSS, with a live preview.
- Every comment, removal and edit becomes a task your agent reads over **MCP**, with
  selectors, HTML, React component names, the source file and screenshots.
- The agent marks a task **in progress**, fixes it in the code, and marks it
  **review ready** with a short note on how it solved it. You **accept** it or
  **reopen** it in the browser.

```
Brave extension  <---- WebSocket ---->  browser-review-mcp  <-- MCP (stdio) -->  your agent
(overlay, sidebar,                      127.0.0.1:4777                           (starts it per session)
 comments in IndexedDB)                 (npx, a bridge)
```

You never start a server yourself: your agent starts `browser-review-mcp` with
each session (like Browser MCP), and the extension connects to it. Comments live
in the extension, so you can review while no agent session is open.

Runs by itself on local addresses (`localhost`, `127.0.0.1`) and dev domains
like `*.test` (Herd, Valet) or `*.ddev.site`; on any other site (a dev server,
staging) once you turn it on with the extension icon. A strict mode keeps it to
localhost only. Everything stays on your machine. See
[Where it works](#where-it-works).

## See it

The toolbar sits at the bottom of your app: pick an element, comment on the
whole page, or open the threads.

**Tip:** hold down **Left Alt** and the element picker starts right away. Click
an element while you hold it, or let go of Alt to stop. (Change the key or turn
it off on the help page.)

<img src="docs/screenshots/toolbar.png" alt="The Pebble demo app with the Browser Review toolbar at the bottom right" width="800">

**Comment on an element.** Pick it (**Pick element**, or hold Left Alt), say what should change, send.

<img src="docs/screenshots/comment-on-an-element.gif" alt="Picking the Start for free button and writing a comment" width="800">

**Edit text or CSS, with a live preview.** Here the typo "acutally" becomes
"actually". The agent gets the before and after, and fixes it in the code.

<img src="docs/screenshots/edit-text-live.gif" alt="Picking the headline and fixing a typo in the Edit tab" width="800">

**Comment on the whole page, then follow the threads** in the browser's side
panel. The page gets narrower instead of being covered.

<img src="docs/screenshots/page-comment-and-side-panel.gif" alt="Writing a page comment, then the side panel opens with the threads" width="800">

**Your agent picks them up.** Each thread shows its screenshot, the change, and
the agent's progress. When the agent is done it marks the thread review ready; you
accept it or reopen it.

<img src="docs/screenshots/side-panel-claude-working.png" alt="The side panel next to the page, with three threads Claude is working on" width="800">

## Sponsor

<a href="https://stabiloworld.com/"><img src="docs/sponsors/stabilo-international.png" alt="Stabilo International B.V." width="300"></a>

Browser Review was made possible by [Stabilo International B.V.](https://stabiloworld.com/),
which needed a tool like this and supported its development. Thank you!

## Setup

### 1. Install the extension

**Brave, Chrome, Edge.** Until it is in the Chrome Web Store, load it unpacked:

1. Get the extension folder: extract a release zip (`browser-review-<version>-chrome.zip`, also for Brave and Edge; from the GitHub Releases page)
   into a folder you keep, for example `~/extensions/browser-review`, or build it
   from this repo (`extension/dist`, see Development).
2. Go to `brave://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick that folder.
4. Pin the icon (puzzle icon in the toolbar).

**Firefox (140 or newer).** Download `browser-review-<version>-firefox.xpi`
from the GitHub release (signed by Mozilla) and open it in Firefox. That installs
it for good. Without a signed release:

- To try it: `about:debugging`, **This Firefox**, **Load Temporary Add-on**, and
  pick the Firefox zip (`browser-review-<version>-firefox.zip`) or
  `extension/dist-firefox/manifest.json`. Firefox removes temporary add-ons
  (and their comments) when it closes.
- To keep it: it must be signed by Mozilla. Self-distribution works without a
  public listing: `npx web-ext sign --channel=unlisted --source-dir
  extension/dist-firefox` with API keys from addons.mozilla.org gives a signed
  `.xpi` you install by opening it in Firefox. (Firefox Developer Edition and
  Nightly can also run unsigned add-ons with `xpinstall.signatures.required`
  set to false in `about:config`.)

Comments are per browser: Brave and Firefox each keep their own.

The **help page** opens on install. It's also under right-click on the icon,
**Options** (Firefox: **Manage Extension**, **Preferences**), and behind the **?**
in the overlay. It shows the setup command and
whether an agent is connected.

Brave asks for access to all sites. Chrome only allows the screenshot API with
that permission, and it lets the overlay run on the sites you turn on. The
overlay only runs where you allow it: see [Where it works](#where-it-works).

### 2. Connect your coding agent (once)

Browser Review is a plain MCP server over stdio, so any agent that supports MCP
can use it. It needs Node.js 20 or newer for `npx`.

**Claude Code.** Run this in a terminal (not inside Claude Code):

```sh
claude mcp add --scope user browser-review -- npx -y browser-review-mcp@latest
```

`--scope user` makes it available in every project. Check with
`claude mcp list`: `browser-review` should say **Connected**.

**Codex.**

```sh
codex mcp add browser-review -- npx -y browser-review-mcp@latest
```

Check with `codex mcp list`.

**Other agents** (Cursor, Gemini CLI and others that use an `mcpServers`
config): add this to the agent's MCP config file.

```json
{
  "mcpServers": {
    "browser-review": {
      "command": "npx",
      "args": ["-y", "browser-review-mcp@latest"]
    }
  }
}
```

Start a session in your agent and the dot in the overlay (and on the help page)
turns green.

Optional for Claude Code, no permission prompt for every tool: add this to
`~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__browser-review"]
  }
}
```

To remove it: `claude mcp remove --scope user browser-review`.

## Use it

1. Open your dev app, for example `http://localhost:5173`, and click the
   extension icon. The review sidebar opens in the browser's side panel, next to
   the page: the page gets narrower, like with DevTools docked to the side.
2. Leave comments, removals and edits.
3. Start your agent in your **app's** project folder and say:

   > Check the review comments.

   The agent calls `list_comments`, then for each one `get_comment` (with the
   screenshot), `start_work` (shows **In progress**), fixes it in the code,
   optionally `capture_screenshot` to look at the result in your tab, and
   `submit_solution` with a short note (shows **Review ready**).

   More specific: *"Fix review comment #12."* or *"Check the review comments for
   http://localhost:5173 only."*
4. In the sidebar, **Accept solution** or write what is still wrong and **Reopen**.

### Try it on the demo app

No app of your own at hand, or want to show it to someone? The repo has a small
made-up product site (Vite + React) with a few flaws on purpose: a banner to
remove, a typo, a button that hardly stands out, a misaligned icon.

```sh
pnpm install
pnpm demo        # http://localhost:5173
```

Review it, then ask your agent to "fix the review comments" in this repo. The list
of flaws is in [demo/README.md](demo/README.md); `git checkout demo/` resets it.

### The overlay

| Action | How |
|---|---|
| Show the overlay with the Threads sidebar open (click again to hide) | the extension icon, or Alt+Shift+R. The sidebar is the browser's side panel (Firefox: its sidebar), so the page gets narrower instead of being covered |
| Comment on an element | **Pick element** (Alt+Shift+P), click the element, write, **Add comment** |
| Pick while holding a key | hold **Left Alt**, click the element; release Alt to stop. Change the key (or turn it off) on the help page. **Pick element** and its shortcut keep the picker on until you pick or press Esc |
| Pick the parent element | mouse wheel up or arrow up while picking (down goes back) |
| Remove an element | pick it, **Remove** tab, **Remove element**. It disappears |
| Edit text and CSS | pick it, **Edit** tab, change the texts, add CSS, **Save edit** |
| See the new thread right after sending | tick **Open thread** in the comment box (remembered). Off: only the Threads count goes up |
| Make the comment box taller | drag its bottom-right corner; the size is remembered |
| Make the Threads sidebar wider or narrower | drag its edge; the browser remembers the width |
| Comment on the page | **Page comment** (Alt+Shift+C) |
| See all threads | **Threads** (Alt+Shift+T): this page or the whole site. **Show** picks the status: not accepted yet (open, in progress and review ready together), one status, or all. Threads start expanded; **Collapse all** gives an overview (remembered), **Expand all** opens them again. The browser may refuse to open its side panel from the **Threads** button or a pin (it only allows that from its own controls); the toolbar then says to use the extension icon or Alt+Shift+T. Once open, pins and **Open thread** show their thread in it |
| Jump to a thread's element | **Go to** in the thread. On another page it opens that page first. If the element is gone, you land on the page. **Open page** always opens the page itself. |
| Help | **?** in the toolbar or the sidebar |
| Change the shortcuts | they are browser shortcuts: help page, **Change shortcuts** (`brave://extensions/shortcuts`; Firefox: about:addons, gear, Manage Extension Shortcuts) |
| Send a comment or reply | Enter (Shift+Enter for a new line). Prefer Enter for new lines? On the help page, set **Send** to Ctrl+Enter |
| Cancel | Esc |

After the extension is reloaded or updated, a page that was already open shows
"Browser Review was reloaded" with a **Reload page** button: browsers don't put
the new version into open tabs by themselves.

What you type survives a reload of your app (dev server restart, full HMR reload,
F5): an unsent comment, removal or edit reopens on the same element with your
text, and so do unsent replies. Drafts are kept per tab until you save, cancel
or close the tab.

On a site that is not on yet, the first click on the extension icon turns
Browser Review on there (the side panel also has a **Turn on for this site**
button). Where it can't run (browser pages, or other sites in strict mode) the
icon opens a short note instead, with buttons to switch to the tabs where it
runs. On a tab that was open before you loaded the extension, it asks you to
reload the page.

### Where it works

| Where | Runs |
|---|---|
| `localhost`, `127.0.0.1`, `[::1]` (http or https, any port) | by itself |
| Dev domains: `*.test` (Herd, Valet), `*.localhost`, `*.local`, `*.internal`, `*.ddev.site`, `*.lndo.site` | by itself |
| Any other site: a dev server on your network, staging | once you click the extension icon there (that exact address and port); remembered |

The help page, **Where it works**, lists the sites you turned on, with a
**Remove** button each, and has the **strict mode** setting: only `localhost`,
`127.0.0.1` and `[::1]`, no dev domains, and the icon doesn't turn on other
sites.

### Statuses

| Status | Set by | Meaning |
|---|---|---|
| Open | you | waiting for your agent |
| In progress | agent | your agent is working on it |
| Review ready | agent | fixed, with a note on how; waiting for you |
| Accepted | you | done |

The agent can only set **In progress** and **Review ready**. Removals and edits are
shown as a preview while the status is Open or In progress. Saving an edit keeps
both its text and CSS preview in place. When the agent marks it Review ready the
preview turns off, so you see what the code really does now.
**Undo removal** / **Undo edit** brings the element back and drops the task.

### MCP tools

| Tool | What it does |
|---|---|
| `list_comments` | List comments. Default: open and in progress. Filter by status or site. |
| `get_comment` | Everything about one comment: page, selectors, HTML, React components, source file, requested change, thread, solution, plus the screenshot. |
| `get_screenshot` | The stored page or element screenshot. |
| `capture_screenshot` | A fresh screenshot from the open tab, with previews switched off, to check a fix. |
| `start_work` | Set to In progress. |
| `reply` | Write in the thread, for example to ask a question. |
| `submit_solution` | Set to Review ready with a note and the changed files. |

## Where the data lives

Comments, threads and screenshots are stored in the extension (IndexedDB in your
browser profile). Reloading or updating the extension keeps them; **removing the
extension deletes them**.

`browser-review-mcp` stores nothing. It listens on `ws://127.0.0.1:4777` and
passes the agent's tool calls to the extension. With several agent sessions,
the first one holds the port and the others go through it; when it closes,
another takes over.

## Security

- The bridge listens on 127.0.0.1 only and checks the `Host` header (no DNS
  rebinding).
- Only the extension (a `chrome-extension://` or `moz-extension://` origin) may
  connect as the extension, and only local non-browser processes (other agent sessions)
  as peers. Websites, including other localhost apps, get a 403.
- The overlay only runs where you allow it (see [Where it works](#where-it-works)).
  Where it runs, it can read the page: that is how it picks elements, takes
  screenshots and finds React components. So it doesn't run anywhere by
  default except local addresses and dev domains, and you can make it stricter:
  localhost only.
- Nothing leaves your machine: comments and screenshots stay in the browser and
  only go to the agent sessions on this computer.

## Development

Needs Node 26 (`nvm use` reads `.nvmrc`) and pnpm.

### Run the extension from source (hot reload)

1. Install once:

   ```sh
   pnpm install
   ```

2. Start the watch and leave it running in a terminal:

   ```sh
   pnpm dev
   ```

   It builds the extension into `extension/dist` and rebuilds on every save.
   When it is ready it prints the folder to load and the `claude mcp add`
   command for the MCP server in this repo (step 5), with your paths filled in.

3. Load it in the browser, once:
   1. Open `brave://extensions` (or `chrome://extensions`) and turn on
      **Developer mode** (top right).
   2. If a release version of Browser Review is loaded, turn it off, so you
      don't get two overlays.
   3. Click **Load unpacked** and pick the `extension/dist` folder of this repo.

4. Open your app on `http://localhost:<port>` and work on the code. On every
   save the extension reloads itself, then reloads your localhost tabs so they
   get the new overlay. What you were typing in a comment box comes back.
   Changes in `extension/static/` (manifest, help page) reload it too.
   Reloading the extension by hand (the reload icon on its card) reloads the
   localhost tabs as well.

5. To also use the MCP server from this repo instead of npm (no publish needed),
   run the command `pnpm dev` printed, once, then restart Claude Code:

   ```sh
   claude mcp remove --scope user browser-review
   claude mcp add --scope user browser-review -- node /path/to/repo/server/src/cli.ts
   ```

   Changes to the server take effect when Claude Code restarts it (`/mcp`,
   reconnect). To go back to npm: remove it again and add it with
   `npx -y browser-review-mcp@latest` (see Setup).

Good to know:

- **Stop the watch** (Ctrl+C) and nothing reloads anymore; the last build keeps
  working. `pnpm build` makes a normal build without hot reload, into the same
  `extension/dist`: while `pnpm dev` runs, save any file afterwards so the watch
  puts its own build back.
- **Separate comments.** An unpacked extension's ID, and with it its stored
  comments, depends on its folder. So `extension/dist` has its own comments,
  apart from a release folder you loaded before.
- **A build error** keeps the last good build running; fix it and save again.
- **Changed `extension/build.ts`** (new entry point, new static file)? Restart
  `pnpm dev`; the watch says so.
- **Not reloading?** Check the watch is running and that port 4778 is free (it
  says so when it isn't). The extension's errors are under **Inspect views:
  service worker** on its card in `brave://extensions`.
- **How it works:** the watch serves its build number on `127.0.0.1:4778`; the
  dev build's background asks for it, and reloads when it changes
  (`extension/src/dev-reload.ts`). Normal and release builds leave that code out.

### Firefox

```sh
pnpm dev:firefox
```

Then `about:debugging`, **This Firefox**, **Load Temporary Add-on**, and pick
`extension/dist-firefox/manifest.json`. Hot reload works the same (port 4779,
so Chrome and Firefox watches can run side by side). Firefox drops temporary
add-ons, and their comments, when it closes; load it again after a restart.

### Checks

Run these before committing (CI runs the same):

```sh
pnpm typecheck
pnpm test               # fast unit and stdio tests; no browser needed
pnpm build              # extension/dist, extension/dist-firefox, server/dist/cli.js
```

### End-to-end tests (Chromium)

```sh
pnpm install
pnpm --dir e2e exec playwright install chromium
pnpm build
pnpm e2e
```

The separate `node --test` suite uses the Playwright library to load the real built
extension into full Chromium, serve the demo on a free loopback port, and connect
a real MCP stdio client to `server/dist/cli.js`. It covers picking and sending a
comment with a PNG, the agent reply/solution/acceptance round trip, edit/removal
previews and undo, panel listing and focus, screenshots without previews, and the
extension reload notice. `pnpm test` does not run it.

Port **127.0.0.1:4777 must be free**: stop other Browser Review MCP sessions first.
The suite fails rather than using another session's bridge. Cases run serially,
each with a fresh temporary browser profile; the browser, demo and MCP process
are closed afterwards. It never uses your normal browser profile or port 5173.

Chromium runs headless by default; set `E2E_HEADED=1` to watch it. On Linux,
`pnpm --dir e2e exec playwright install --with-deps chromium` also installs the
system libraries. CI runs this as a separate job. Failures save screenshots,
Playwright traces and MCP stderr under `e2e/results/` (uploaded by CI); inspect a
trace with `pnpm --dir e2e exec playwright show-trace results/<case>/trace.zip`.

The panel is loaded directly at its `chrome-extension://` URL in a background tab,
so the demo remains the active tab it follows. This exercises the real panel UI,
not Chromium's native side-panel opening gesture. Firefox is out of scope for
this suite and is checked by hand.

## License

[MIT](LICENSE): free for everyone to use, change and share, also commercially.
Keep the copyright notice.
