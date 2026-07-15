const BaseAgent = require('../base-agent');
const { callAI } = require('../../providers');

class PlaywrightGenAgent extends BaseAgent {
  constructor() {
    super('playwright-gen', 'Playwright Generator', 'Generates POM-pattern TypeScript Playwright tests from test cases', '🎭');
  }

  async execute({ testcases, baseUrl = 'https://your-app.com', applicationName = 'App' }, opts = {}) {
    const prompt = `Generate Playwright TypeScript test files using Page Object Model (POM) pattern.

Application: ${applicationName}  Base URL: ${baseUrl}

TEST CASES:
${JSON.stringify(testcases.slice(0, 20), null, 2)}

Return JSON:
{
  "files": [
    {
      "path": "tests/login.spec.ts",
      "content": "// full TypeScript source"
    },
    {
      "path": "pages/LoginPage.ts",
      "content": "// Page Object class"
    },
    {
      "path": "playwright.config.ts",
      "content": "// config"
    }
  ]
}

Rules:
- One Page class per module in pages/ (export default class)
- One spec file per module in tests/
- Use @playwright/test imports (test, expect, Page)
- Prefer data-testid locators, fall back to role/label/CSS
- Wrap tests in test.describe blocks
- Use beforeEach for navigation/auth setup
- Include playwright.config.ts with baseURL, retries: 1, reporter: 'html'
- Return ONLY JSON`;

    const data = await callAI(prompt, 16000, opts);
    const files = data.files || [];
    return { files, count: files.length };
  }
}

module.exports = new PlaywrightGenAgent();
