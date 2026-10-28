import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png` });

// What a screen reader announces for each element: its label, else its text.
const names = (items: Locator) => items.evaluateAll((els) => els.map((el) => el.ariaLabel ?? el.textContent));

async function connectJira(page: Page) {
  await page.goto('/');
  await page.getByPlaceholder('Enter your name').fill('Alice');
  await page.getByPlaceholder('Jira personal access token').fill('test-token');
  await page.getByRole('button', { name: 'Connect Jira' }).click();
}

// Alice copies the invite link; Bob opens it and joins with his name.
async function invite(alice: Page, bob: Page, joinShot: string) {
  await alice.getByRole('button', { name: 'Invite a teammate' }).click();
  await alice.getByRole('button', { name: 'Copy URL' }).click();
  await expect(alice.getByRole('button', { name: 'Copied!' })).toBeVisible();
  await bob.goto(await alice.evaluate(() => navigator.clipboard.readText()));
  await expect(bob.getByText('Join the session:')).toBeVisible();
  await shot(bob, joinShot);
  await bob.getByPlaceholder('Enter your name').fill('Bob');
  await bob.getByRole('button', { name: 'Enter' }).click();
  await expect(bob.getByRole('heading', { name: 'Sprint planning' })).toBeVisible();
}

async function expectNoModeratorControls(page: Page) {
  const controls = /^(Start|Add Stories|Flip Cards|Finish Voting|Reset Timer|Clear Votes|Skip Story|Next Story|Add Tickets|Sync|Export|End session|Delete story|Story details|Retry|Push|Revert to .+|Edit .+|Save .+)$/;
  await expect(page.getByRole('button', { name: controls })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
}

test('the start screen checks its fields and reports a rejected token', async ({ page }) => {
  await page.goto('/');
  await shot(page, 'start');
  const connect = page.getByRole('button', { name: 'Connect Jira' });
  await connect.click();
  await expect(page.getByText('Please enter your name')).toBeVisible();
  await page.getByPlaceholder('Enter your name').fill('Alice');
  await connect.click();
  await expect(page.getByText('Please paste your Jira token')).toBeVisible();
  await page.getByPlaceholder('Jira personal access token').fill('bad-token');
  await connect.click();
  await expect(page.getByText(/^Jira rejected the token:/)).toBeVisible();
  await expect(page).toHaveURL('/');
  await shot(page, 'start-bad-token');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'start-bad-token-390');
});

test('a point range narrows the session cards', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Enter your name').fill('Alice');
  await page.getByRole('combobox', { name: 'Card deck' }).selectOption('fibonacci');
  await page.getByRole('combobox', { name: 'Points from' }).selectOption('1');
  await page.getByRole('combobox', { name: 'Points to' }).selectOption('13');
  const cards = ['1', '2', '3', '5', '8', '13', '?', 'Coffee'];
  await shot(page, 'start-range');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'start-range-390');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('button', { name: 'Use custom tickets' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Custom Tickets' });
  await dialog.getByRole('textbox').fill('Login page');
  await dialog.getByRole('button', { name: 'Add Tickets' }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login page' })).toBeVisible();
  await expect.poll(() => names(page.locator('.deck-card'))).toEqual(cards);
  await shot(page, 'room-range');
});

test('Jira session: pick tickets, invite, vote, save to Jira, change and revert in the index', async ({ page: alice, browser }) => {
  await connectJira(alice);
  const picker = alice.getByRole('dialog', { name: 'Add Tickets from Jira' });
  await picker.getByRole('combobox', { name: 'Sprint' }).selectOption('7001');
  for (const key of ['FAKE-1', 'FAKE-2', 'FAKE-3']) await picker.getByRole('checkbox', { name: new RegExp(`^${key} `) }).check();
  await shot(alice, 'jira-picker-alice');
  await picker.getByRole('button', { name: 'Add 3 Tickets' }).click();
  await expect(alice.getByRole('row')).toHaveText([/^FAKE-3 /, /^FAKE-1 /, /^FAKE-2 /]); // the sprint's rank order

  const bob = await browser.newPage();
  await invite(alice, bob, 'jira-join-bob');
  await expect(bob.getByText(/to start the session/)).toBeVisible();
  await expectNoModeratorControls(bob);
  await shot(bob, 'jira-waiting-bob');

  await alice.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(bob.getByRole('heading', { name: /^FAKE-3 / })).toBeVisible();
  await expect(bob.getByRole('button', { name: '5', exact: true })).toBeEnabled();
  await alice.getByRole('button', { name: 'Skip Story' }).click();
  await alice.getByRole('alertdialog').getByRole('button', { name: 'Skip' }).click();
  await expect(bob.getByRole('heading', { name: 'FAKE-1 Summarize the sprint for stakeholders' })).toBeVisible();
  await expect(bob.locator('.story-description strong')).toHaveText(['As a', 'I want']); // read while voting, formatted

  await alice.getByRole('button', { name: '5', exact: true }).click();
  for (const page of [alice, bob]) await expect(page.getByText('Waiting for Bob to vote')).toBeVisible();
  const aliceForBob = bob.locator('.player', { hasText: 'Alice' });
  await expect(aliceForBob.locator('.player-name svg')).toBeVisible();
  await expect(aliceForBob.locator('.player-vote')).toHaveCount(0);
  await expectNoModeratorControls(bob);
  await shot(alice, 'jira-voting-alice');
  await shot(bob, 'jira-voting-bob');

  // Moving to another story asks first, from the list or from Story Details (both work from the keyboard): it would drop
  // this round's votes.
  const stop = alice.getByRole('alertdialog', { name: 'Stop the current vote and vote on this story?' });
  await alice.getByRole('button', { name: 'Update sprint picker' }).press('Enter');
  await expect(stop).toBeVisible();
  await shot(alice, 'jira-vote-confirm-alice');
  await stop.getByRole('button', { name: 'Cancel' }).click();
  await alice.getByRole('row', { name: /Update sprint picker/ }).getByRole('button', { name: 'Story details' }).press('Enter');
  const details = alice.getByRole('dialog', { name: 'Story Details' });
  await details.getByRole('button', { name: 'Vote on this story' }).click();
  await expect(stop).toBeVisible();
  await stop.getByRole('button', { name: 'Cancel' }).click();
  await details.getByRole('button', { name: 'Close' }).click();
  await expect(alice.getByRole('heading', { name: /^FAKE-1 / })).toBeVisible();
  await expect(alice.getByRole('button', { name: '5', exact: true, pressed: true })).toBeVisible();

  await bob.getByRole('button', { name: '8', exact: true }).click();
  for (const page of [alice, bob]) {
    await expect(page.getByText('2 Players')).toBeVisible();
    await expect(page.getByText(/Avg/)).toHaveCount(0);
  }
  await expect(aliceForBob.locator('.player-vote')).toHaveText('5');
  await expect(alice.getByRole('complementary').getByRole('combobox')).toHaveValue('8');
  await expectNoModeratorControls(bob);
  await shot(alice, 'jira-results-alice');
  await shot(bob, 'jira-results-bob');

  await alice.getByRole('button', { name: 'Finish Voting' }).click();
  await expect(alice.getByText('✓ Saved 8 to FAKE-1')).toBeVisible();
  await expect(bob.getByText('Story voting completed')).toBeVisible();
  await shot(alice, 'jira-saved-alice');

  for (const page of [alice, bob]) await page.getByRole('button', { name: /^Completed/ }).click();
  const row = alice.getByRole('row', { name: /^FAKE-1 / });
  await expect(row.getByRole('combobox')).toHaveValue('8');
  await expect(row.getByText('✓ In Jira')).toBeVisible();

  await row.getByRole('combobox').selectOption('3');
  await expect(alice.getByText('Jira updated: FAKE-1 = 3')).toBeVisible();
  await alice.getByRole('button', { name: 'Sync' }).click();
  await expect(alice.getByText('Synced with Jira')).toBeVisible();
  await expect(row.getByText('✓ In Jira')).toBeVisible();
  await row.getByText('Story · Done').click();
  await expect(details.locator('dt:has-text("Jira points:") + dd')).toHaveText('3');
  await expect(details.locator('.history > li')).toContainText(['8 → 3 · Alice', '3 → 8 · Alice']);
  await expect(details.getByText('✓ Saved to Jira')).toHaveCount(2);
  await expect(details.getByRole('button', { name: /^Revert/ })).toHaveText(['Revert to 8']); // 3 is the estimate already
  await shot(alice, 'jira-details-alice');

  await details.getByRole('button', { name: 'Revert to 8' }).click();
  await expect(alice.getByText('Jira updated: FAKE-1 = 8')).toBeVisible();
  await expect(details.locator('.history > li')).toHaveCount(3);
  await expect(details.locator('.history > li').first()).toContainText('3 → 8 · Alice');
  await details.getByRole('button', { name: 'Close' }).click();
  await expect(row.getByRole('combobox')).toHaveValue('8');
  await expect(row.getByText('✓ In Jira')).toBeVisible();
  await expect(bob.getByRole('row', { name: /^FAKE-1 / }).getByRole('cell')).toHaveText([/^FAKE-1 /, '8', '✓ In Jira']);
  // The picker reads the sprint from Jira afresh: FAKE-1 (3 before this test) now holds 8.
  await alice.getByRole('button', { name: 'Add Tickets' }).click();
  await expect(picker.getByRole('checkbox', { name: /^FAKE-1 .*Jira: 8$/ })).toBeDisabled();
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expectNoModeratorControls(bob);
  await shot(alice, 'jira-completed-alice');
  await shot(bob, 'jira-completed-bob');
  await bob.close();
});

test('the moderator edits the current ticket in Jira and everyone sees it at once', async ({ page: alice, browser }) => {
  await connectJira(alice);
  const picker = alice.getByRole('dialog', { name: 'Add Tickets from Jira' });
  await picker.getByRole('checkbox', { name: /^FAKE-4 / }).check();
  await picker.getByRole('button', { name: 'Add 1 Ticket' }).click();
  const bob = await browser.newPage();
  await invite(alice, bob, 'edit-join-bob');
  await alice.getByRole('button', { name: 'Start', exact: true }).click();

  const toasts = alice.getByText('Jira updated: FAKE-4');

  // The pen in the description box above the cards: raw markup (Enter is a new line), ✓ saves, shown formatted.
  const box = alice.locator('.story-description');
  await box.getByRole('button', { name: 'Edit description' }).click();
  expect((await box.getByRole('textbox').boundingBox())!.height).toBeGreaterThanOrEqual(240); // room to read the markup
  await expect(box.getByRole('textbox')).toHaveCSS('font-size', '14px'); // the viewer's text size
  await alice.keyboard.type('h3. Notes\n* *short* first\n** then offer details\n||Field||Value||\n|Guide|[style guide|https://example.com/guide]|');
  await shot(alice, 'edit-alice');
  await box.getByRole('button', { name: 'Save description' }).click();
  await expect(toasts).toHaveCount(1);
  await expect(box.locator('.wiki strong')).toHaveText('short');

  // The pen beside the title above the cards edits the summary: Enter saves.
  const head = alice.locator('.story-head');
  await head.getByRole('button', { name: 'Edit summary' }).click();
  await expect(head.getByRole('textbox', { name: 'Summary' })).toHaveValue('Document results chart');
  await alice.keyboard.press('ControlOrMeta+A');
  await alice.keyboard.type('Results chart for the sprint');
  await shot(alice, 'edit-title-alice');
  await alice.keyboard.press('Enter');
  await expect(toasts).toHaveCount(2);
  await expect(bob.getByRole('heading', { name: 'FAKE-4 Results chart for the sprint' })).toBeVisible();

  // The story dialog has the same pens.
  await alice.getByRole('heading', { name: /^FAKE-4 / }).getByRole('button').click();
  const details = alice.getByRole('dialog', { name: 'Story Details' });
  await details.getByRole('button', { name: 'Edit summary' }).click();
  await alice.keyboard.press('ControlOrMeta+A');
  await alice.keyboard.type('Sprint summary in 40 words');
  await alice.keyboard.press('Enter');
  await expect(toasts).toHaveCount(3);
  await expect(details.getByText('Sprint summary in 40 words')).toBeVisible();

  // ✕ and Escape drop a draft; Escape doesn't close the dialog.
  await details.getByRole('button', { name: 'Edit description' }).click();
  await expect(details.getByRole('textbox', { name: 'Description' })).toHaveValue(/^h3\. Notes\n\* \*short\* first/);
  await alice.keyboard.type('draft');
  await details.getByRole('button', { name: 'Cancel' }).click();
  await details.getByRole('button', { name: 'Edit summary' }).click();
  await alice.keyboard.type(' draft');
  await alice.keyboard.press('Escape');
  await expect(details.getByText('Sprint summary in 40 words')).toBeVisible();
  await expect(details.locator('.wiki strong')).toHaveText('short');
  await expect(toasts).toHaveCount(3);

  await expect(bob.getByRole('heading', { name: 'FAKE-4 Sprint summary in 40 words' })).toBeVisible();
  await bob.getByRole('heading', { name: /^FAKE-4 / }).getByRole('button').click();
  const bobDetails = bob.getByRole('dialog', { name: 'Story Details' });
  const about = bob.locator('.story-description'); // read while voting, formatted
  await expect(about.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(about.locator('ul ul li')).toHaveText('then offer details');
  await expect(about.getByRole('cell', { name: 'style guide' }).getByRole('link')).toHaveAttribute('href', 'https://example.com/guide');
  await expect(bobDetails.locator('.wiki strong')).toHaveText('short');
  await expect(bobDetails.getByRole('textbox')).toHaveCount(0);
  await expectNoModeratorControls(bob);
  await shot(bob, 'edit-bob');

  // Everyone sizes the description's text for themselves with a and A, within limits; their browser remembers it.
  await bobDetails.getByRole('button', { name: 'Close' }).click();
  const larger = about.getByRole('button', { name: 'Larger text' });
  const smaller = about.getByRole('button', { name: 'Smaller text' });
  await expect(about).toHaveCSS('font-size', '14px');
  await larger.click();
  await expect(about).toHaveCSS('font-size', '16px');
  await expect(box).toHaveCSS('font-size', '14px'); // Alice's is her own
  for (let i = 0; i < 4; i++) await larger.click();
  await expect(about).toHaveCSS('font-size', '24px');
  await expect(larger).toBeDisabled();
  await shot(bob, 'text-size-bob');
  await bob.reload();
  await expect(about).toHaveCSS('font-size', '24px');
  for (let i = 0; i < 6; i++) await smaller.click();
  await expect(about).toHaveCSS('font-size', '12px');
  await expect(smaller).toBeDisabled();

  // The handle beside them resizes the box, by dragging or with the arrow keys, within limits; it is remembered too.
  const height = (page: Page) => page.locator('.story-text').evaluate((el) => (el as HTMLElement).offsetHeight);
  const resize = about.getByRole('button', { name: 'Resize box' });
  async function drag(by: number) {
    const at = (await resize.boundingBox())!;
    await bob.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await bob.mouse.down();
    await bob.mouse.move(at.x + at.width / 2, at.y + at.height / 2 + by, { steps: 5 });
    await bob.mouse.up();
  }
  const start = await height(bob);
  await drag(100);
  await expect.poll(() => height(bob)).toBe(start + 100);
  await resize.press('ArrowUp');
  await expect.poll(() => height(bob)).toBe(start + 80);
  await shot(bob, 'resize-bob');
  await bob.reload();
  await expect.poll(() => height(bob)).toBe(start + 80);
  await drag(-(start + 80));
  await expect.poll(() => height(bob)).toBe(60);
  await bob.close();

  // Editing opens the whole editor, whatever the box's height.
  await details.getByRole('button', { name: 'Close' }).click();
  const before = await height(alice);
  await box.getByRole('button', { name: 'Resize box' }).press('ArrowUp');
  await expect.poll(() => height(alice)).toBe(before - 20);
  await box.getByRole('button', { name: 'Edit description' }).click();
  expect(await height(alice)).toBeGreaterThanOrEqual(240);
});

test('the moderator moves everyone to any story from the lists, ahead or back', async ({ page: alice, browser }) => {
  await alice.goto('/');
  await alice.getByPlaceholder('Enter your name').fill('Alice');
  await alice.getByRole('button', { name: 'Use custom tickets' }).click();
  const dialog = alice.getByRole('dialog', { name: 'Add Custom Tickets' });
  await dialog.getByRole('textbox').fill('Login page\nVoting cards\nResults chart\nExport CSV');
  await dialog.getByRole('button', { name: 'Add Tickets' }).click();
  const bob = await browser.newPage();
  await invite(alice, bob, 'jump-join-bob');

  const title = (page: Page) => page.locator('.story-title');
  const row = (name: string) => alice.getByRole('row', { name });
  const stop = alice.getByRole('alertdialog', { name: 'Stop the current vote and vote on this story?' });

  // Before the start, and while nobody has voted, a click starts voting on that story at once.
  await row('Results chart').click();
  await expect(title(bob)).toHaveText('Results chart');
  await row('Export CSV').click();
  await expect(title(bob)).toHaveText('Export CSV');
  await expect(row('Export CSV')).toHaveClass('current');
  await shot(alice, 'jump-voting-alice');
  await alice.getByRole('button', { name: '3', exact: true }).click();
  await bob.getByRole('button', { name: '5', exact: true }).click();
  await alice.getByRole('button', { name: 'Finish Voting' }).click();
  await expect(alice.getByText('Story estimate was saved')).toBeVisible();

  // Back to the first story from All Stories.
  await alice.getByRole('button', { name: /^All/ }).click();
  await row('Login page').click();
  await expect(title(bob)).toHaveText('Login page');

  // Once someone has voted, moving on asks first; Vote drops those votes.
  await alice.getByRole('button', { name: '2', exact: true }).click();
  await row('Voting cards').click();
  await stop.getByRole('button', { name: 'Vote' }).click();
  await expect(title(bob)).toHaveText('Voting cards');
  await expect(alice.getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-pressed', 'false');

  // Back to an estimated story from Completed Stories: a new vote replaces its estimate.
  await alice.getByRole('button', { name: /^Completed/ }).click();
  await row('Export CSV').getByRole('cell').first().click();
  await expect(title(bob)).toHaveText('Export CSV');
  await alice.getByRole('button', { name: '8', exact: true }).click();
  await bob.getByRole('button', { name: '8', exact: true }).click();
  await alice.getByRole('button', { name: 'Finish Voting' }).click();
  await expect(row('Export CSV').getByRole('combobox')).toHaveValue('8');

  // The current story, the ⓘ button, and a teammate's click open Story Details instead.
  await row('Export CSV').getByRole('cell').first().click();
  const details = alice.getByRole('dialog', { name: 'Story Details' });
  await expect(details.locator('.history > li')).toContainText(['5 → 8 · Alice', '— → 5 · Alice']);
  await details.getByRole('button', { name: 'Close' }).click();
  await alice.getByRole('button', { name: /^All/ }).click();
  await row('Results chart').getByRole('button', { name: 'Story details' }).click();
  await expect(details.locator('dt:has-text("Summary:") + dd')).toHaveText('Results chart');
  await details.getByRole('button', { name: 'Close' }).click();
  await bob.getByRole('row', { name: 'Login page' }).click();
  await expect(bob.getByRole('dialog', { name: 'Story Details' })).toContainText('Login page');
  await expect(title(alice)).toHaveText('Export CSV');
  await expectNoModeratorControls(bob);

  // An unsaved summary draft stays behind with its story.
  await alice.locator('.story-head').getByRole('button', { name: 'Edit summary' }).click();
  await alice.keyboard.type(' draft');
  await row('Results chart').click();
  await expect(title(alice)).toHaveText('Results chart');
  await expect(alice.locator('.story-head').getByRole('textbox')).toHaveCount(0);
  await shot(alice, 'jump-all-alice');
  await bob.close();
});

test('the invite link asks for a name and adds a player, even in a tab of the moderator browser', async ({ page: alice }) => {
  await alice.goto('/');
  await alice.getByPlaceholder('Enter your name').fill('Alice');
  await alice.getByRole('button', { name: 'Use custom tickets' }).click();
  const dialog = alice.getByRole('dialog', { name: 'Add Custom Tickets' });
  await dialog.getByRole('textbox').fill('Login page');
  await dialog.getByRole('button', { name: 'Add Tickets' }).click();

  const tab = await alice.context().newPage(); // same browser: it holds Alice's moderator cookie
  await invite(alice, tab, 'invite-same-browser');
  await expect(alice.locator('.player', { hasText: 'Bob' })).toBeVisible();
  await expect(tab.locator('.player', { hasText: 'Alice' })).toBeVisible();
  await expectNoModeratorControls(tab);
  await tab.reload(); // the tab keeps being Bob
  await expect(tab.locator('.player', { hasText: 'Bob' })).toBeVisible();
  await expectNoModeratorControls(tab);
  await expect(alice.getByRole('button', { name: 'Start', exact: true })).toBeVisible(); // Alice is still the moderator
});

test('a Jira write that fails shows Failed with Retry', async ({ page }) => {
  await connectJira(page);
  const picker = page.getByRole('dialog', { name: 'Add Tickets from Jira' });
  await picker.getByRole('checkbox', { name: /^FAKE-13 / }).check();
  await picker.getByRole('button', { name: 'Add 1 Ticket' }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: '3', exact: true }).click();
  await page.getByRole('button', { name: 'Finish Voting' }).click();

  const error = "Field 'customfield_10106' cannot be set. It is not on the appropriate screen, or unknown.";
  const panel = page.getByRole('complementary');
  await expect(panel.getByText(`Jira update failed: ${error}`)).toBeVisible();
  await expect(page.locator('.toast-error')).toContainText(`Jira update failed: ${error}`);
  expect(await page.getByText('Story estimate was saved').count()).toBe(0); // not retried: toasts fade out on their own
  await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.getByRole('button', { name: /^Completed/ }).click();
  const row = page.getByRole('row', { name: /^FAKE-13 / });
  await expect(row.getByText('Failed', { exact: true })).toHaveAttribute('title', error);
  await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
  await shot(page, 'jira-failed-alice');
});

test('custom session: tickets, vote, observer, export, end', async ({ page: alice, browser }) => {
  await alice.goto('/');
  await alice.getByPlaceholder('Enter your name').fill('Alice');
  await alice.getByRole('combobox', { name: 'Card deck' }).selectOption('fibonacci');
  await alice.getByRole('button', { name: 'Use custom tickets' }).click();
  const dialog = alice.getByRole('dialog', { name: 'Add Custom Tickets' });
  await dialog.getByRole('textbox').fill('Login page\n\nVoting cards\n=Fix "results", chart\n');
  await shot(alice, 'custom-dialog-alice');
  await dialog.getByRole('button', { name: 'Add Tickets' }).click();
  await expect(alice.getByRole('row')).toHaveText(['Login page', 'Voting cards', '=Fix "results", chart']);

  const bob = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await invite(alice, bob, 'custom-join-bob-390');
  await expectNoModeratorControls(bob);

  await alice.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(bob.getByRole('heading', { name: 'Login page' })).toBeVisible();
  await expect(bob.getByRole('button', { name: '21', exact: true })).toBeVisible();
  await alice.getByRole('button', { name: '3', exact: true }).click();
  await bob.getByRole('button', { name: '5', exact: true }).click();
  for (const page of [alice, bob]) await expect(page.getByText('2 Players')).toBeVisible();
  await shot(bob, 'custom-results-bob-390');
  await expect(alice.getByRole('complementary').getByRole('combobox')).toHaveValue('5');
  await alice.getByRole('button', { name: 'Finish Voting' }).click();

  await alice.getByRole('button', { name: /^Completed/ }).click();
  await expect(alice.getByRole('columnheader')).toHaveText(['Title', 'Est.', '']);
  await expect(alice.getByRole('row', { name: 'Login page' }).getByRole('combobox')).toHaveValue('5');
  await alice.getByRole('row', { name: 'Login page' }).getByRole('cell').first().click();
  const details = alice.getByRole('dialog', { name: 'Story Details' });
  await expect(details).toContainText('— → 5 · Alice');
  for (const page of [alice, bob]) await expect(page.locator('body')).not.toContainText(/jira/i);
  await shot(alice, 'custom-details-alice');
  await details.getByRole('button', { name: 'Close' }).click();

  await alice.getByRole('button', { name: 'Next Story' }).click();
  await expect(bob.getByRole('heading', { name: 'Voting cards' })).toBeVisible();
  await bob.getByTitle('Player - Click to change').click();
  await bob.getByRole('button', { name: 'Observer', exact: true }).click();
  await expect(bob.getByTitle('Observer - Click to change')).toBeVisible();
  await expect(alice.getByText('Waiting for Alice to vote')).toBeVisible();
  await bob.getByRole('button', { name: '8', exact: true }).click();
  await expect(bob.getByText('Observers cannot vote')).toBeVisible();
  await shot(bob, 'custom-observer-bob-390');
  await alice.getByRole('button', { name: '8', exact: true }).click();
  await expect(alice.getByText('1 Player', { exact: true })).toBeVisible();
  await alice.getByRole('button', { name: 'Finish Voting' }).click();
  await expect(alice.getByRole('row', { name: 'Voting cards' }).getByRole('combobox')).toHaveValue('8');
  await bob.getByTitle('Observer - Click to change').click();
  await bob.getByRole('button', { name: 'Player', exact: true }).click();
  await expect(bob.getByTitle('Player - Click to change')).toBeVisible();
  await shot(alice, 'custom-completed-alice');

  const download = alice.waitForEvent('download');
  await alice.getByRole('button', { name: 'Export' }).click();
  expect((await download).suggestedFilename()).toBe('sprint-planning-estimates.csv');
  expect(readFileSync(await (await download).path(), 'utf8')).toBe('\uFEFFKey,Summary,Estimate\n,Login page,5\n,Voting cards,8\n,"\'=Fix ""results"", chart",');

  await alice.getByRole('button', { name: 'End session' }).click();
  await alice.getByRole('alertdialog', { name: 'End this session for everyone?' }).getByRole('button', { name: 'End session' }).click();
  await expect(alice).toHaveURL('/');
  await expect(alice.getByRole('heading', { name: "Let's start!" })).toBeVisible();
  await expect(bob.getByRole('heading', { name: 'This session has ended.' })).toBeVisible();
  await shot(bob, 'custom-ended-bob-390');
  await bob.reload();
  await expect(bob.getByRole('heading', { name: 'This session has ended.' })).toBeVisible();
  await bob.getByRole('button', { name: 'Start a new session' }).click();
  await expect(bob.getByRole('heading', { name: "Let's start!" })).toBeVisible();
  await bob.close();
});
