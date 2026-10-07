import { expect, test } from '@playwright/test';

const variants = [
  { id: 'refined', name: 'Quiet Ledger', order: 'NS-DEMO-1001' },
  { id: 'extravagant', name: 'Return Observatory', order: 'NS-DEMO-1002' },
  { id: 'middle', name: 'Field Notes', order: 'NS-DEMO-1003' },
];

test('three design directions render synthetic evidence and read-only MCP policy results', async ({ page }, testInfo) => {
  for (const variant of variants) {
    await page.goto('/');
    await page.getByRole('radio', { name: new RegExp(variant.order) }).click();
    await page.locator(`input[name="design-version"][value="${variant.id}"]`).check();
    if (variant.order === 'NS-DEMO-1003') {
      await page.getByLabel(/Delivery date from this synthetic receipt/).fill('2026-09-08');
    }
    await page.getByRole('checkbox', { name: /I reviewed the synthetic receipt/ }).check();
    await page.getByRole('checkbox', { name: /All required accessories are included/ }).check();

    await page.getByRole('textbox', { name: 'Ask the demo guide' }).fill('Can I return this sample order?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('.tool-trace code')).toHaveText('check_return_options');
    await expect(page.locator('.tool-trace')).toContainText('MCP Streamable HTTP');
    await expect(page.locator('.tool-trace')).toContainText('Result');
    await expect(page.locator('main.app-shell')).toHaveAttribute('data-design', variant.id);
    const width = await page.locator('body').evaluate((element) => element.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize().width);
    await page.screenshot({
      path: testInfo.outputPath(`design-${variant.id}-${testInfo.project.name}.png`),
      fullPage: true,
    });
  }

  await page.reload();
  const designInputs = page.locator('input[name="design-version"]');
  await designInputs.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(designInputs.nth(1)).toBeChecked();
  await expect(designInputs.nth(1)).toBeFocused();
});
