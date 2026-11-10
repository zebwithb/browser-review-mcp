import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium, type BrowserContext, type Locator, type Page, type Worker } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
export const results = join(root, 'e2e/results');

export interface Agent {
  client: Client;
  tool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface ReviewBrowser {
  context: BrowserContext;
  page: Page;
  worker: Worker;
  extensionId: string;
  close(failure?: string): Promise<void>;
}

/** Poll observable state, never use a fixed sleep as readiness. */
export async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(50);
  }
}

export async function startDemo() {
  // Let the OS choose a port; 5173 may belong to an app or a WSL port proxy.
  const server = await createServer({
    root: join(root, 'demo'),
    configFile: join(root, 'demo/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    return { url: `http://127.0.0.1:${address.port}/`, close: () => server.close() };
  } catch (err) {
    await server.close();
    throw err;
  }
}

export async function startAgent(): Promise<Agent> {
  const cli = join(root, 'server/dist/cli.js');
  await access(cli).catch(() => { throw new Error('Build the extension and MCP server first: pnpm build'); });
  // The extension expects 4777. Never silently join somebody else's MCP hub.
  const reservation = createTcpServer();
  const listening = Promise.withResolvers<void>();
  reservation.once('error', (err) => listening.reject(new Error('E2E needs exclusive use of 127.0.0.1:4777. Stop the other MCP server/program first.', { cause: err })));
  reservation.listen(4777, '127.0.0.1', listening.resolve);
  await listening.promise;
  const closed = Promise.withResolvers<void>();
  reservation.close((err) => err ? closed.reject(err) : closed.resolve());
  await closed.promise;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: { ...process.env, BRM_PORT: '4777' } as Record<string, string>,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'browser-review-e2e', version: '0' });
  const close = async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
      await mkdir(results, { recursive: true });
      await writeFile(join(results, 'mcp-stderr.log'), stderr);
    }
  };
  try {
    await client.connect(transport);
    await waitFor(() => {
      assert.doesNotMatch(stderr, /another agent session|Port 4777 is in use/, 'Lost ownership of bridge port 4777');
      return stderr.includes('listening on 127.0.0.1:4777 for the extension');
    }, `MCP server did not own port 4777. ${stderr}`);
  } catch (err) {
    await close();
    throw err;
  }
  return {
    client,
    close,
    async tool(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
      return result;
    },
  };
}

export function text(result: CallToolResult): string {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export function pngs(result: CallToolResult): string[] {
  const images = result.content.filter((c) => c.type === 'image');
  assert.ok(images.length > 0, 'MCP response must attach a screenshot');
  return images.map((image) => {
    assert.equal(image.mimeType, 'image/png');
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    return image.data;
  });
}

export async function launchReviewBrowser(url: string): Promise<ReviewBrowser> {
  const extension = join(root, 'extension/dist');
  await access(join(extension, 'manifest.json')).catch(() => { throw new Error('Build the extension first: pnpm build'); });
  const profile = await mkdtemp(join(tmpdir(), 'browser-review-e2e-'));
  try {
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', // Full Chromium supports extensions in headless mode; headless-shell does not.
      headless: process.env.E2E_HEADED !== '1',
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.setDefaultTimeout(15_000);
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      const page = await context.newPage();
      await page.goto(url);
      await page.locator('h1').filter({ hasText: 'Notes your team' }).waitFor();
      await page.getByRole('toolbar', { name: 'Browser Review' }).waitFor();
      await page.getByTitle('A coding agent is connected', { exact: true }).waitFor();
      return {
        context, page, worker, extensionId,
        async close(failure?: string) {
          try {
            if (failure) {
              const dir = join(results, failure.replace(/[^a-z0-9]+/gi, '-'));
              await mkdir(dir, { recursive: true });
              for (const [i, tab] of context.pages().entries()) {
                await tab.screenshot({ path: join(dir, `page-${i}.png`) }).catch(() => {});
              }
              await context.tracing.stop({ path: join(dir, 'trace.zip') });
            } else {
              await context.tracing.stop();
            }
          } finally {
            await context.close();
            await rm(profile, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      await context.close();
      throw err;
    }
  } catch (err) {
    await rm(profile, { recursive: true, force: true });
    throw err;
  }
}

export async function pickElement(page: Page, target: Locator): Promise<Locator> {
  await page.bringToFront();
  await target.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Pick element', exact: true }).click();
  await target.click();
  const composer = page.locator('.brm-composer');
  await composer.waitFor();
  await composer.getByRole('checkbox', { name: 'Open thread', exact: true }).uncheck();
  return composer;
}

export async function sendComment(browser: ReviewBrowser, agent: Agent, body: string, target = browser.page.locator('h1')): Promise<number> {
  const composer = await pickElement(browser.page, target);
  await composer.getByPlaceholder('What should change here?', { exact: true }).fill(body);
  await composer.getByRole('button', { name: 'Add comment', exact: true }).click();
  // Capture temporarily hides the composer before the comment has been stored.
  await composer.waitFor({ state: 'detached' });
  return findComment(agent, browser.page.url(), body);
}

export async function findComment(agent: Agent, url: string, body: string): Promise<number> {
  const list = text(await agent.tool('list_comments', { origin: new URL(url).origin }));
  const line = list.split('\n').find((line) => line.startsWith('#') && line.includes(body));
  assert.ok(line, `Comment not listed: ${body}\n${list}`);
  const id = Number(/^#(\d+)/.exec(line)?.[1]);
  assert.ok(id > 0, `Missing comment ID: ${line}`);
  return id;
}

/** Load the actual panel page without making it the active tab it follows. */
export async function openPanel(browser: ReviewBrowser): Promise<Page> {
  await browser.page.bringToFront();
  const created = browser.context.waitForEvent('page', (page) => page.url().startsWith(`chrome-extension://${browser.extensionId}/panel.html`));
  await browser.worker.evaluate(async (url) => {
    await chrome.tabs.create({ url, active: false });
  }, `chrome-extension://${browser.extensionId}/panel.html`);
  const panel = await created;
  await panel.getByRole('complementary', { name: 'Review threads' }).waitFor();
  return panel;
}

export function thread(panel: Page, id: number): Locator {
  return panel.getByRole('article').filter({ has: panel.locator('.brm-id').getByText(`#${id}`, { exact: true }) });
}

/** A real browser reload invalidates the content script; don't simulate its notice. */
export async function reloadExtension(worker: Worker): Promise<void> {
  // Scheduling lets evaluate acknowledge before its own execution context disappears.
  await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); });
}

/** Compare decoded pixels, not PNG compression or metadata. No checked-in golden images. */
export async function imageDifference(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(async ({ a, b }) => {
    async function decode(data: string) {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, pixels: ctx.getImageData(0, 0, image.width, image.height).data };
    }
    const [left, right] = await Promise.all([decode(a), decode(b)]);
    if (left.width !== right.width || left.height !== right.height) return 1;
    let different = 0;
    for (let i = 0; i < left.pixels.length; i += 4) {
      if ([0, 1, 2].some((c) => Math.abs(left.pixels[i + c]! - right.pixels[i + c]!) > 8)) different++;
    }
    return different / (left.width * left.height);
  }, { a, b });
}
