require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');
const https = require('https');

/**
 * Standalone Confluence page fetcher (debug helper).
 *
 * Credentials and target are read from the environment / CLI — never hardcode them.
 *   CONFLUENCE_BASE_URL  (falls back to JIRA_BASE_URL)   e.g. https://yourorg.atlassian.net
 *   CONFLUENCE_EMAIL     (falls back to JIRA_EMAIL)
 *   CONFLUENCE_API_TOKEN (falls back to JIRA_API_TOKEN)
 *
 * Usage:
 *   node fetch_confluence.js <pageId>
 *   node fetch_confluence.js --search "some text"
 */
const baseUrl = (process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const email   = process.env.CONFLUENCE_EMAIL     || process.env.JIRA_EMAIL;
const token   = process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN;

if (!baseUrl || !email || !token) {
  console.error('✗ Missing Confluence credentials. Set CONFLUENCE_BASE_URL (or JIRA_BASE_URL), CONFLUENCE_EMAIL (or JIRA_EMAIL) and CONFLUENCE_API_TOKEN (or JIRA_API_TOKEN) in your .env.');
  process.exit(1);
}

const auth = Buffer.from(`${email}:${token}`).toString('base64');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// CLI args: a page ID, or --search "<query>"
const args        = process.argv.slice(2);
const searchIdx   = args.indexOf('--search');
const searchQuery = searchIdx !== -1 ? args[searchIdx + 1] : null;
const pageId      = searchIdx === -1 ? args[0] : null;

async function fetchPage() {
  try {
    if (!pageId) throw Object.assign(new Error('no pageId'), { response: { status: 404 } });
    console.log('Attempting direct page fetch...');
    const response = await axios.get(
      `${baseUrl}/wiki/api/v2/pages/${pageId}?body-format=storage`,
      { headers: { Authorization: `Basic ${auth}` }, httpsAgent }
    );
    console.log('✓ Page found!');
    console.log('Title:', response.data.title);
    console.log('\n--- Page Content ---\n');
    console.log(response.data.body.storage.value.substring(0, 5000));

  } catch (e) {
    if (e.response?.status === 404) {
      if (!searchQuery) {
        console.error('Page not found and no --search query provided.');
        console.error('Usage: node fetch_confluence.js <pageId>  |  node fetch_confluence.js --search "text"');
        return;
      }
      console.log('Direct page not found (404). Searching instead...\n');
      try {
        const search = await axios.get(
          `${baseUrl}/wiki/rest/api/content/search`,
          {
            params: { cql: `text ~ "${searchQuery}"`, limit: 10 },
            headers: { Authorization: `Basic ${auth}` },
            httpsAgent
          }
        );

        console.log('Search results:');
        search.data.results.forEach((p, i) => {
          console.log(`${i+1}. ${p.title} (ID: ${p.id})`);
        });

        if (search.data.results.length > 0) {
          const firstPage = search.data.results[0];
          console.log(`\nFetching: ${firstPage.title}...\n`);
          const pageResp = await axios.get(
            `${baseUrl}/wiki/api/v2/pages/${firstPage.id}?body-format=storage`,
            { headers: { Authorization: `Basic ${auth}` }, httpsAgent }
          );
          console.log(pageResp.data.body.storage.value.substring(0, 5000));
        }
      } catch (searchErr) {
        console.error('Search error:', searchErr.message);
      }
    } else {
      console.error('Error:', e.message);
    }
  }
}

fetchPage();
