import { test, expect } from './fixtures';

test('should be possible to save app configuration', async ({ appConfigPage, page }) => {
  const endpoints = page.getByRole('group', { name: /lighthouse endpoints/i });
  const credential = page.getByRole('group', { name: /lighthouse credential/i });

  // provisioning/plugins/apps.yaml always provisions a credential, so the reset
  // control is always rendered. Username and password reset together, so either
  // button does the same thing.
  await credential.getByRole('button', { name: 'Reset' }).first().click();

  // one Lighthouse endpoint: environment, cell and URL
  await endpoints.getByRole('textbox', { name: 'Environment' }).fill('staging');
  await endpoints.getByRole('textbox', { name: 'Cell' }).fill('mq');
  await endpoints.getByRole('textbox', { name: 'URL' }).fill('http://lighthouse.mq.staging.internal:4567');

  // the Grafana team allowed to use the operator page
  await page.getByRole('textbox', { name: 'Grafana team' }).fill('platform');

  // the shared Lighthouse credential, entered as one unit
  await credential.getByRole('textbox', { name: 'Username' }).fill('lighthouse');
  await credential.getByRole('textbox', { name: 'Password' }).fill('secret-api-password');

  // listen for the server response on the saved form
  const saveResponse = appConfigPage.waitForSettingsResponse();

  await page.getByRole('button', { name: /Save Lighthouse settings/i }).click();
  await expect(saveResponse).toBeOK();
});
