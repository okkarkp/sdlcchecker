import { test as base, expect } from '@playwright/test';

// Extend test with shared fixtures here
type CustomFixtures = {
  // e.g. authenticatedPage: Page;
};

export const test = base.extend<CustomFixtures>({
  // Add custom fixtures here
});

export { expect };
