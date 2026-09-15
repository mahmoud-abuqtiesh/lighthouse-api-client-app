import { test, expect } from './fixtures';

test('should be possible to save app configuration', async ({ appConfigPage, page }) => {
  const saveButton = page.getByRole('button', { name: /Save Lighthouse settings/i });

  // reset the stored credential if one is already configured
  const resetButtons = page.getByRole('button', { name: /reset/i });
  if (await resetButtons.first().isVisible()) {
    await resetButtons.first().click();
  }

  // one Lighthouse endpoint: environment, cell and URL
  await page.getByLabel('Environment').first().fill('staging');
  await page.getByLabel('Cell').first().fill('mq');
  await page.getByLabel('URL').first().fill('http://lighthouse.mq.staging.internal:4567');

  // the Grafana team allowed to use the operator page
  await page.getByTestId('data-testid ac-team').fill('platform');

  // the shared Lighthouse credential, entered as one unit
  await page.getByTestId('data-testid ac-username').fill('lighthouse');
  await page.getByTestId('data-testid ac-password').fill('secret-api-password');

  // listen for the server response on the saved form
  const saveResponse = appConfigPage.waitForSettingsResponse();

  await saveButton.click();
  await expect(saveResponse).toBeOK();
});
