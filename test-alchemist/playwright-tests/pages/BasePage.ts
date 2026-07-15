import { Page, Locator, expect } from '@playwright/test';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  async navigate(path = '') {
    await this.page.goto(path);
    await this.waitForPageLoad();
  }

  async waitForPageLoad() {
    await this.page.waitForLoadState('networkidle');
  }

  async clickElement(locator: string | Locator) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await el.waitFor({ state: 'visible' });
    await el.click();
  }

  async fillInput(locator: string | Locator, value: string) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await el.waitFor({ state: 'visible' });
    await el.fill(value);
  }

  async selectOption(locator: string | Locator, value: string) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await el.selectOption(value);
  }

  async expectVisible(locator: string | Locator) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await expect(el).toBeVisible();
  }

  async expectHidden(locator: string | Locator) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await expect(el).toBeHidden();
  }

  async expectText(locator: string | Locator, text: string) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await expect(el).toContainText(text);
  }

  async expectUrl(urlPattern: string | RegExp) {
    await expect(this.page).toHaveURL(urlPattern);
  }

  async expectTitle(title: string) {
    await expect(this.page).toHaveTitle(title);
  }

  async screenshot(name: string) {
    await this.page.screenshot({
      path: `test-results/screenshots/${name}-${Date.now()}.png`,
      fullPage: true,
    });
  }

  async getTitle() {
    return this.page.title();
  }

  async getText(locator: string | Locator): Promise<string> {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    return el.innerText();
  }
}
