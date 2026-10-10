import { expect, test } from '@playwright/test';

for (const design of ['Quiet Ledger', 'Return Observatory', 'Field Notes']) {
  test(`${design}: approval stays with its saved evidence and purchase`, async ({ page }, testInfo) => {
    // API setup is synthetic and the Playwright server uses a fresh temporary DB.
    const health = await (await page.request.get('/api/health')).json();
    expect(health.provider).toBe('deterministic_fake_tool_simulation');
    const createdResponse = await page.request.post('/api/cases', { data: {
      order_id: 'NS-DEMO-1001', receipt_reviewed: true, accessories_complete: true,
    } });
    expect(createdResponse.ok()).toBeTruthy();
    const created = await createdResponse.json();
    const caseId = created.case_id;
    const offerResponse = await page.request.post(`/api/cases/${caseId}/offers`);
    expect(offerResponse.ok()).toBeTruthy();
    const offered = (await offerResponse.json()).case;
    const approvalResponse = await page.request.post(`/api/cases/${caseId}/approve`, { data: {
      offer_id: offered.offer.offer_id, terms_hash: offered.offer.options[0].terms_hash,
      expected_revision: offered.revision,
    } });
    expect(approvalResponse.ok()).toBeTruthy();
    const approved = await approvalResponse.json();

    await page.goto('/');
    await page.getByRole('radio', { name: new RegExp(design) }).check();
    const savedCase = page.locator('.saved-case').filter({ hasText: caseId });
    await savedCase.click();
    const confirm = page.getByRole('button', { name: 'Confirm simulated return' });
    await expect(confirm).toBeEnabled();
    const purchase = page.getByRole('radio', { name: /NS-DEMO-1001/ });
    await purchase.click(); // Already-selected purchase must preserve the reviewed snapshot.
    const receipt = page.getByRole('checkbox', { name: /I reviewed the synthetic receipt/ });
    const date = page.getByLabel(/Delivery date from this synthetic receipt/);
    await expect(receipt).toBeChecked();
    await expect(receipt).toBeDisabled();
    await expect(date).toBeDisabled();
    const options = page.getByRole('radiogroup', { name: 'Return options' }).getByRole('radio');
    expect(await options.count()).toBeGreaterThan(0);
    for (const option of await options.all()) await expect(option).toBeDisabled();
    await expect(page.getByText('To choose a different option, refresh the offer and approve it again.')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('approved-evidence.png'), fullPage: true });
    await page.locator('.options-card').screenshot({ path: testInfo.outputPath('approved-options.png') });
    if (design === 'Return Observatory') {
      for (const selector of ['.order-price', '.offer-amount', '.receipt-review-check', '.offer-refresh small', '.confirm-panel > p', '.confirm-panel > small']) {
        const contrast = await page.locator(selector).first().evaluate((element) => {
          const rgb = (color) => color.match(/[\d.]+/g).map(Number);
          const luminance = (channels) => channels.slice(0, 3).map((channel) => {
            const scaled = channel / 255;
            return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
          let parent = element;
          let background;
          while (parent) {
            const color = rgb(getComputedStyle(parent).backgroundColor);
            if (color.length === 3 || color[3] === 1) { background = color; break; }
            parent = parent.parentElement;
          }
          if (!background) throw new Error('No opaque background found for contrast check');
          const foregroundLuminance = luminance(rgb(getComputedStyle(element).color));
          const backgroundLuminance = luminance(background);
          return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
        });
        expect(contrast, `${selector} text contrast`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(await page.locator('body').evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(testInfo.project.use.viewport.width);

    // Hold a read-only request while exercising the common action lock.
    let release;
    let started;
    const held = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    await page.route('**/api/chat', async (route) => {
      started();
      await held;
      await route.continue();
    });
    const chat = page.getByRole('textbox', { name: 'Ask the demo guide' });
    await chat.fill('Can I return this sample order?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await entered;
    try {
      await expect(purchase).toBeDisabled();
      await expect(savedCase).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Refresh saved progress' })).toBeDisabled();
      await expect(page.locator('.confirm-panel button')).toBeDisabled();
    } finally { release(); }
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeEnabled();
    await page.unroute('**/api/chat');

    // A network failure must not erase the displayed, still-persisted approval.
    await page.route(`**/api/cases/${caseId}/offers`, (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic test failure' }),
    }));
    await page.getByRole('button', { name: 'Refresh offer and require new approval' }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic test failure');
    await expect(confirm).toBeEnabled();
    await expect(page.getByText(/Option approved/)).toBeVisible();
    await page.unroute(`**/api/cases/${caseId}/offers`);

    await purchase.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /NS-DEMO-1002/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('heading', { name: 'Here are your options' })).toHaveCount(0);
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('.active-case-summary')).toHaveCount(0);
    await expect(page.locator('.tool-trace')).toHaveCount(0);
    await expect(receipt).not.toBeChecked();
    await expect(date).toBeEnabled();
    const stored = await (await page.request.get(`/api/cases/${caseId}`)).json();
    expect(stored.approval).toEqual(approved.approval);
    expect(stored.return).toBeNull();

    await savedCase.click();
    await expect(confirm).toBeEnabled();
    await expect(purchase).toHaveAttribute('aria-checked', 'true');
    await chat.fill('Prepare a return proposal for this sample order.');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('.tool-trace code')).toHaveText('prepare_return_proposal');
    await expect(page.getByText(/Option approved/)).toHaveCount(0);
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve this option' })).toBeDisabled();
    await expect(page.locator('.approval-check input')).not.toBeChecked();

    // The new proposal is newest; refreshing the older saved case must keep its ID.
    await savedCase.click();
    await expect(confirm).toBeEnabled();
    await page.getByRole('button', { name: 'Refresh offer and require new approval' }).click();
    await expect(page.getByText(/offer was refreshed/i)).toBeVisible();
    await expect(page.locator('.active-case-summary')).toContainText(caseId);
    await expect(page.locator('.saved-case.active')).toContainText(caseId);
    await expect(page.locator('.approval-check input')).not.toBeChecked();
    await expect(confirm).toHaveCount(0);
  });
}
