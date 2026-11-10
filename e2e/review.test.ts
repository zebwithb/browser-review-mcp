import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  findComment, imageDifference, launchReviewBrowser, openPanel, pickElement, pngs,
  reloadExtension, sendComment, startAgent, startDemo, text, thread, waitFor,
  type Agent, type ReviewBrowser,
} from './fixtures.ts';

let demo: { url: string; close(): Promise<void> };
let agent: Agent;
let browser: ReviewBrowser | undefined;

before(async () => {
  agent = await startAgent();
  demo = await startDemo();
});

after(async () => {
  try { await demo?.close(); } finally { await agent?.close(); }
});

beforeEach(async () => { browser = await launchReviewBrowser(demo.url); });
afterEach(async (t) => {
  const current = browser;
  browser = undefined;
  await current?.close(t.passed ? undefined : t.name);
});

describe('the built Chromium extension and MCP server', { concurrency: false }, () => {
  it('sends a picked element comment and PNG to the agent', async () => {
    const b = browser!;
    const body = 'Please correct the headline typo.';
    const id = await sendComment(b, agent, body);
    const list = text(await agent.tool('list_comments', { origin: new URL(demo.url).origin }));
    assert.match(list, new RegExp(`#${id} \\[Open\\]`));
    assert.ok(list.includes(body));
    const comment = await agent.tool('get_comment', { id });
    assert.ok(text(comment).includes(body));
    assert.ok(text(comment).includes(`Page: ${demo.url}`));
    assert.match(text(comment), /Tag: <h1>/);
    pngs(comment);
    await b.page.getByTitle(`#${id} Open`, { exact: true }).waitFor();
  });

  it('shows the agent status, reply and solution in the sidebar, then accepts', async () => {
    const b = browser!;
    const body = 'Make the headline clearer.';
    const id = await sendComment(b, agent, body);
    const panel = await openPanel(b);
    const card = thread(panel, id);
    await card.getByText('Open', { exact: true }).waitFor();
    await card.getByText(body, { exact: true }).waitFor();

    await agent.tool('start_work', { id });
    await card.getByText('In progress', { exact: true }).waitFor();
    const reply = 'I am checking the headline in Hero.';
    await agent.tool('reply', { id, message: reply });
    await card.getByText(reply, { exact: true }).waitFor();
    // Replying must leave the task in progress.
    await card.getByText('In progress', { exact: true }).waitFor();

    const note = 'Verification-only solution: no source files were changed.';
    await agent.tool('submit_solution', { id, note, files: ['demo/src/components/Hero.tsx'] });
    await card.getByText('Review ready', { exact: true }).waitFor();
    await card.locator('.brm-solution').getByText(note, { exact: true }).waitFor();
    await card.getByText('demo/src/components/Hero.tsx', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Accept solution', exact: true }).click();
    await panel.getByRole('combobox').selectOption('all');
    await card.getByText('Accepted', { exact: true }).waitFor();
    assert.match(text(await agent.tool('get_comment', { id, with_screenshot: false })), /Comment, Accepted/);
  });

  it('previews an edit and undo restores both text and CSS', async () => {
    const b = browser!;
    const heading = b.page.locator('h1');
    const original = await heading.textContent();
    const color = await heading.evaluate((el) => getComputedStyle(el).color);
    const composer = await pickElement(b.page, heading);
    await composer.getByRole('tab', { name: 'Edit', exact: true }).click();
    await composer.getByLabel('Text', { exact: true }).fill('Notes your team will actually read');
    await composer.getByLabel('CSS', { exact: true }).fill('color: rgb(255, 0, 255)');
    await waitFor(async () => (await heading.textContent()) === 'Notes your team will actually read' &&
      await heading.evaluate((el) => getComputedStyle(el).color) === 'rgb(255, 0, 255)', 'Draft edit did not appear');
    await composer.getByLabel('Note (optional)', { exact: true }).fill('Correct the typo and color.');
    await composer.getByRole('button', { name: 'Save edit', exact: true }).click();
    await composer.waitFor({ state: 'detached' });
    const id = await findComment(agent, demo.url, 'Correct the typo and color.');
    await waitFor(async () => (await heading.textContent()) === 'Notes your team will actually read' &&
      await heading.evaluate((el) => getComputedStyle(el).color) === 'rgb(255, 0, 255)', 'Saved text and CSS preview disappeared');
    const panel = await openPanel(b);
    await thread(panel, id).getByRole('button', { name: 'Undo edit', exact: true }).click();
    await waitFor(async () => (await heading.textContent()) === original &&
      await heading.evaluate((el) => getComputedStyle(el).color) === color, 'Undo did not restore text and CSS');
    await thread(panel, id).waitFor({ state: 'hidden' });
    assert.ok(!text(await agent.tool('list_comments')).includes('Correct the typo and color.'));
  });

  it('previews a removal and undo restores the element', async () => {
    const b = browser!;
    const banner = b.page.locator('.banner');
    const original = await banner.textContent();
    const composer = await pickElement(b.page, banner);
    await composer.getByRole('tab', { name: 'Remove', exact: true }).click();
    await banner.waitFor({ state: 'hidden' });
    await composer.getByLabel('Why? (optional)', { exact: true }).fill('Remove the beta banner.');
    await composer.getByRole('button', { name: 'Remove element', exact: true }).click();
    await composer.waitFor({ state: 'detached' });
    const id = await findComment(agent, demo.url, 'Remove the beta banner.');
    assert.equal(await banner.isVisible(), false);
    const panel = await openPanel(b);
    await thread(panel, id).getByRole('button', { name: 'Undo removal', exact: true }).click();
    await banner.waitFor({ state: 'visible' });
    assert.equal(await banner.textContent(), original);
    await thread(panel, id).waitFor({ state: 'hidden' });
    assert.ok(!text(await agent.tool('list_comments')).includes('Remove the beta banner.'));
  });

  it('lists comments at the panel URL and focuses a thread and its element', async () => {
    const b = browser!;
    const first = await sendComment(b, agent, 'Headline thread.');
    const second = await sendComment(b, agent, 'Banner thread.', b.page.locator('.banner'));
    const panel = await openPanel(b);
    assert.equal(panel.url(), `chrome-extension://${b.extensionId}/panel.html`);
    await thread(panel, first).getByText('Headline thread.', { exact: true }).waitFor();
    await thread(panel, second).getByText('Banner thread.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Collapse all', exact: true }).click();
    // A real pin focuses and expands the matching panel card, not another thread.
    await b.page.getByTitle(`#${first} Open`, { exact: true }).click();
    await thread(panel, first).getByText('Headline thread.', { exact: true }).waitFor();
    assert.equal(await thread(panel, first).locator('.brm-thread-head').getAttribute('aria-expanded'), 'true');
    assert.equal(await thread(panel, second).locator('.brm-thread-head').getAttribute('aria-expanded'), 'false');

    await b.page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await thread(panel, first).getByRole('button', { name: 'Go to', exact: true }).click();
    await b.page.locator('.brm-outline.is-flash').waitFor();
    await waitFor(async () => b.page.locator('h1').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }), 'Go to did not scroll the target into view');
  });

  it('captures original pixels during an edit and restores the preview afterwards', async () => {
    const b = browser!;
    const heading = b.page.locator('h1');
    const composer = await pickElement(b.page, heading);
    await composer.getByRole('tab', { name: 'Edit', exact: true }).click();
    await composer.getByLabel('Text', { exact: true }).fill('A completely different preview');
    await composer.getByLabel('CSS', { exact: true }).fill('background: rgb(255, 0, 255); color: rgb(0, 255, 0)');
    await composer.getByLabel('Note (optional)', { exact: true }).fill('Screenshot preview isolation.');
    await composer.getByRole('button', { name: 'Save edit', exact: true }).click();
    await composer.waitFor({ state: 'detached' });
    const id = await findComment(agent, demo.url, 'Screenshot preview isolation.');
    const initial = pngs(await agent.tool('get_comment', { id }))[0]!;
    await waitFor(async () => (await heading.textContent()) === 'A completely different preview' &&
      await heading.evaluate((el) => getComputedStyle(el).backgroundColor) === 'rgb(255, 0, 255)', 'Saved edit preview is not active');

    const captured = pngs(await agent.tool('capture_screenshot', { id }));
    assert.equal(captured.length, 2, 'Fresh capture must include the page and element crop');
    const difference = await imageDifference(b.page, initial, captured[1]!);
    assert.ok(difference < 0.02, `Captured element must match its original pixels (different fraction: ${difference})`);
    await waitFor(async () => (await heading.textContent()) === 'A completely different preview' &&
      await heading.evaluate((el) => getComputedStyle(el).backgroundColor) === 'rgb(255, 0, 255)', 'Capture did not restore the edit preview');
    await b.page.getByRole('toolbar', { name: 'Browser Review' }).waitFor();
  });

  it('reloading the extension tears down the overlay and shows the reload notice', async () => {
    const b = browser!;
    await b.page.getByRole('toolbar', { name: 'Browser Review' }).waitFor();
    await reloadExtension(b.worker);
    const notice = b.page.getByRole('status').filter({ hasText: 'Browser Review was reloaded' });
    await notice.waitFor();
    assert.equal(await b.page.getByRole('toolbar', { name: 'Browser Review' }).count(), 0);
    assert.equal(await b.page.locator('.brm-pin, .brm-composer, .brm-sidebar').count(), 0);
  });
});
