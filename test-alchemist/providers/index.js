/**
 * Unified AI provider interface.
 * Supports: Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google).
 *
 * opts shape:
 *   provider        – 'claude' | 'openai' | 'gemini'  (auto-detected from model if omitted)
 *   model           – model ID string
 *   anthropicApiKey – key for Claude
 *   openaiApiKey    – key for OpenAI
 *   geminiApiKey    – key for Gemini
 */

const SYSTEM_PROMPT =
  'You are a senior QA architect and automation engineer. Always return valid JSON when asked.';

// ── Model catalogues (used by the frontend selector) ──────────────────────────
const MODELS = {
  claude: [
    { id: 'claude-opus-4-8',             label: 'Claude Opus 4.8  — most capable' },
    { id: 'claude-opus-4-7',             label: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-4-6',           label: 'Claude Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5-20251001',   label: 'Claude Haiku 4.5  — fastest' },
  ],
  openai: [
    { id: 'gpt-4o',        label: 'GPT-4o         — flagship' },
    { id: 'gpt-4o-mini',   label: 'GPT-4o Mini    — fast & cheap' },
    { id: 'o3-mini',       label: 'o3 Mini        — reasoning' },
    { id: 'o1-preview',    label: 'o1 Preview     — deep reasoning' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash',                  label: 'Gemini 2.0 Flash         — fast' },
    { id: 'gemini-2.0-flash-thinking-exp',     label: 'Gemini 2.0 Flash Thinking — reasoning' },
    { id: 'gemini-1.5-pro',                    label: 'Gemini 1.5 Pro            — capable' },
    { id: 'gemini-1.5-flash',                  label: 'Gemini 1.5 Flash          — balanced' },
  ],
  copilot: [
    { id: 'claude-opus-4.6',          label: 'Claude Opus 4.6     — most capable' },
    { id: 'claude-sonnet-4.6',        label: 'Claude Sonnet 4.6   — balanced' },
    { id: 'claude-haiku-4.5',         label: 'Claude Haiku 4.5    — fastest' },
    { id: 'gpt-5.4',                  label: 'GPT-5.4             — flagship' },
    { id: 'gpt-5.4-mini',             label: 'GPT-5.4 Mini        — fast' },
    { id: 'gemini-2.5-pro',           label: 'Gemini 2.5 Pro      — capable' },
  ],
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function detectProvider(model = '') {
  if (!model) return null;
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('claude')) return 'claude';
  return null;
}

function resolveKey(opts, provider) {
  const keyMap = {
    claude:  opts.anthropicApiKey || process.env.ANTHROPIC_API_KEY,
    openai:  opts.openaiApiKey    || process.env.OPENAI_API_KEY,
    gemini:  opts.geminiApiKey    || process.env.GEMINI_API_KEY,
    copilot: opts.copilotToken    || process.env.GITHUB_TOKEN,
  };
  const key = keyMap[provider];
  if (!key && provider !== 'claude' && provider !== 'copilot') {
    const name = { openai: 'OpenAI (ChatGPT)', gemini: 'Google (Gemini)' }[provider];
    throw new Error(`${name} API key not configured. Add it in ⚙ Settings → AI Provider.`);
  }
  return key || null;
}

function stripJsonComments(str) {
  // Remove single-line comments (// ...) that are sometimes added by lazy AI responses
  // Also remove trailing commas before ] or } which AI sometimes adds
  return str
    .replace(/\/\/[^\n]*/g, '')           // // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')     // /* block comments */
    .replace(/,(\s*[}\]])/g, '$1');       // trailing commas
}

function parseJSON(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/s) || text.match(/(\[[\s\S]*\])/s);
  const raw   = match ? match[1] : text;

  // First try verbatim
  try { return JSON.parse(raw); } catch {}

  // Second try: strip JS comments & trailing commas (AI laziness: "// ... N more")
  const cleaned = stripJsonComments(raw);
  try { return JSON.parse(cleaned); } catch {}

  // Third try: if array looks truncated, close it and parse partial
  const partial = cleaned.replace(/,?\s*$/, '') + ']}';
  try {
    const r = JSON.parse(partial);
    // Only accept if main collection looks present
    if (r.testcases?.length || r.scenarios?.length || r.files?.length) return r;
  } catch {}

  // Last resort: detect structural truncation for a better error message
  const openBraces  = (cleaned.match(/\{/g) || []).length;
  const closeBraces = (cleaned.match(/\}/g) || []).length;
  if (openBraces > closeBraces) {
    throw new Error('AI response was cut off (output too large). A partial result may have been saved. Try again or use a direct API key in Settings.');
  }
  throw new Error(`JSON parse failed. Raw response started with: ${raw.slice(0, 120)}`);
}

// ── Internal broadcast helper ─────────────────────────────────────────────────
// opts.broadcastFn is injected by routes (e.g. clientId-scoped global.broadcastTo)
// so every AI call emits real-time events to the Execution Log drawer.
function _emit(opts, message, subtype = 'ai') {
  try { opts?.broadcastFn?.({ type: 'ai_log', subtype, message }); } catch {}
}

// ── Claude Code CLI fallback (used when no API key is configured) ─────────────
// Uses stdin instead of -p flag to avoid Windows shell quoting issues with long prompts.
async function callClaudeCLI(prompt, maxTokens, opts = {}) {
  const { spawn } = require('child_process');
  const model = opts.model || 'claude-sonnet-4-6';
  const sysMsg = opts.systemPrompt || SYSTEM_PROMPT;

  _emit(opts, `→ Claude CLI (${model}) — prompt ${Math.round(prompt.length / 4)} tokens est.`);
  const t0 = Date.now();

  // Prepend system prompt clearly so the model follows it
  const fullPrompt = `<SYSTEM_INSTRUCTIONS>\n${sysMsg}\n</SYSTEM_INSTRUCTIONS>\n\n${prompt}`;

  return new Promise((resolve, reject) => {
    // 4-minute timeout per call; parallel batching means total wall-time stays reasonable
    const args = ['--print', '--output-format', 'json', '--model', model, '--no-session-persistence'];
    // Pass system prompt via CLI flag if available
    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }
    const child = spawn(
      'claude',
      args,
      { shell: true, timeout: 240_000 }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('error', err => {
      _emit(opts, `✗ Claude CLI error: ${err.message}`, 'error');
      reject(new Error(
        err.code === 'ENOENT' || /not found|not recognized/i.test(err.message)
          ? 'Claude Code CLI not found. Install it from claude.ai/code or add an Anthropic API key in ⚙ Settings.'
          : err.message
      ));
    });

    // Auth-failure phrases — checked ONLY against the CLI's error channel / structured
    // error, never against a successful result (the model's own text often mentions
    // "login"/"unauthorized" when the task is about a login page → false positives).
    const AUTH_RE = /not logged in|please run\s*\/login|invalid api key|authentication (failed|required)|\bunauthorized\b/i;
    const notLoggedIn = () => {
      _emit(opts, '✗ Claude CLI: not logged in — run "claude login"', 'error');
      return new Error('Claude CLI is not logged in. Run "claude login" in your terminal, then try again.');
    };

    child.on('close', code => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const outEst  = Math.round(stdout.length / 4);

      // Parse the structured JSON response first (the normal success path)
      let cliResp = null;
      try { cliResp = JSON.parse(stdout); } catch {}

      if (cliResp && !cliResp.is_error) {
        _emit(opts, `← Claude CLI — ~${outEst} tokens out — ${elapsed}s`);
        const resultText = cliResp.result ?? stdout;
        try { return resolve(opts.rawText ? resultText : parseJSON(resultText)); }
        catch (e) { return reject(new Error(`CLI response parse failed: ${e.message}`)); }
      }

      if (cliResp && cliResp.is_error) {
        const msg = cliResp.result || cliResp.error || 'unknown error';
        _emit(opts, `✗ Claude CLI: ${msg}`, 'error');
        return reject(AUTH_RE.test(msg) ? notLoggedIn() : new Error(`Claude CLI: ${msg}`));
      }

      // stdout was not JSON — base auth/error decisions on stderr only
      if (AUTH_RE.test(stderr)) return reject(notLoggedIn());
      if (code !== 0 && !stdout) {
        _emit(opts, `✗ Claude CLI exited ${code}`, 'error');
        return reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`));
      }
      // Non-JSON but usable stdout → return as-is
      _emit(opts, `← Claude CLI — ~${outEst} tokens out — ${elapsed}s`);
      try { resolve(opts.rawText ? stdout : parseJSON(stdout)); }
      catch (e) { reject(new Error(`CLI response parse failed: ${e.message}`)); }
    });

    // If --system-prompt flag is used, send only the user prompt; otherwise send full
    child.stdin.write(opts.systemPrompt ? prompt : fullPrompt, 'utf8');
    child.stdin.end();
  });
}

// ── Provider call functions ────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens, opts) {
  const key = resolveKey(opts, 'claude');

  // No API key → delegate to Claude Code CLI (blocking, no real token streaming)
  if (!key) {
    // Emit a "thinking" indicator so the exec pane feed shows activity
    if (opts.broadcastFn) {
      const dots = ['✶ Generating with Claude CLI…', '✶ Still thinking…', '✶ Working…'];
      let d = 0;
      const ticker = setInterval(() => {
        opts.broadcastFn({ type: 'ai_log', subtype: 'token', message: dots[d++ % dots.length] + ' ' });
      }, 4000);
      try {
        const result = await callClaudeCLI(prompt, maxTokens, opts);
        clearInterval(ticker);
        return result;
      } catch (e) {
        clearInterval(ticker);
        throw e;
      }
    }
    return callClaudeCLI(prompt, maxTokens, opts);
  }

  const model = opts.model || 'claude-opus-4-8';
  const t0 = Date.now();
  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey: key });

  _emit(opts, `→ Claude API (${model}) — max ${maxTokens} tokens`);

  const sysMsg = opts.systemPrompt || SYSTEM_PROMPT;

  // ── Streaming path — uses SDK .on('text') event API (most reliable across versions) ──
  if (opts.broadcastFn) {
    let accumulated = '';

    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: sysMsg,
      messages: [{ role: 'user', content: prompt }],
    });

    // .on('text', cb) fires for every text_delta — no need to inspect raw SSE events
    stream.on('text', (chunk) => {
      accumulated += chunk;
      opts.broadcastFn({ type: 'ai_log', subtype: 'token', message: chunk });
    });

    // wait for the stream to fully complete
    const final   = await stream.finalMessage();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const u       = final.usage || {};
    _emit(opts, `← Claude API (stream) — ${u.input_tokens ?? '?'} in / ${u.output_tokens ?? '?'} out — ${elapsed}s`);

    return opts.rawText ? accumulated : parseJSON(accumulated);
  }

  // ── Blocking path (CLI fallback or no broadcastFn) ─────────────────────────
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: sysMsg,
    messages: [{ role: 'user', content: prompt }],
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const u = msg.usage || {};
  _emit(opts, `← Claude API — ${u.input_tokens ?? '?'} in / ${u.output_tokens ?? '?'} out — ${elapsed}s · stop: ${msg.stop_reason}`);

  const text = msg.content[0].text;
  return opts.rawText ? text : parseJSON(text);
}

async function callOpenAI(prompt, maxTokens, opts) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: resolveKey(opts, 'openai') });
  const model = opts.model || 'gpt-4o';
  const isReasoning = model.startsWith('o1') || model.startsWith('o3');
  const sysMsg = opts.systemPrompt || SYSTEM_PROMPT;

  _emit(opts, `→ OpenAI (${model}) — max ${maxTokens} tokens`);
  const t0 = Date.now();

  const params = {
    model,
    messages: isReasoning
      ? [{ role: 'user', content: `${sysMsg}\n\n${prompt}` }]
      : [{ role: 'system', content: sysMsg }, { role: 'user', content: prompt }],
  };
  if (isReasoning) params.max_completion_tokens = maxTokens;
  else params.max_tokens = maxTokens;

  const response = await client.chat.completions.create(params);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const u = response.usage || {};
  _emit(opts, `← OpenAI — ${u.prompt_tokens ?? '?'} in / ${u.completion_tokens ?? '?'} out — ${elapsed}s · finish: ${response.choices[0]?.finish_reason}`);

  const text = response.choices[0].message.content;
  return opts.rawText ? text : parseJSON(text);
}

async function callGemini(prompt, maxTokens, opts) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(resolveKey(opts, 'gemini'));
  const modelId = opts.model || 'gemini-2.0-flash';

  _emit(opts, `→ Gemini (${modelId}) — max ${maxTokens} tokens`);
  const t0 = Date.now();

  const sysMsg = opts.systemPrompt || SYSTEM_PROMPT;
  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction: sysMsg,
  });
  const genConfig = { maxOutputTokens: maxTokens };
  if (!opts.rawText) genConfig.responseMimeType = 'application/json';
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: genConfig,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const u = result.response.usageMetadata || {};
  _emit(opts, `← Gemini — ${u.promptTokenCount ?? '?'} in / ${u.candidatesTokenCount ?? '?'} out — ${elapsed}s`);

  const text = result.response.text();
  return opts.rawText ? text : parseJSON(text);
}

// ── GitHub Copilot / VS Code Language Model provider ──────────────────────────
// Two modes:
//   1. Bridge mode (default): calls the local VS Code Copilot Bridge extension on port 3939
//      — No token needed, uses the already-authenticated Copilot session in VS Code
//   2. Token mode: calls GitHub Models API with a PAT (for environments without VS Code)
const COPILOT_BRIDGE_URL = 'http://127.0.0.1:3939';

async function callCopilot(prompt, maxTokens, opts) {
  const token = opts.copilotToken || process.env.GITHUB_TOKEN;
  const model = opts.model || 'claude-sonnet-4';
  const t0 = Date.now();

  // Determine endpoint: bridge (no token) vs GitHub Models API (with token)
  const useBridge = !token;
  const endpoint = useBridge
    ? `${COPILOT_BRIDGE_URL}/chat/completions`
    : 'https://models.github.ai/inference/chat/completions';

  _emit(opts, `→ Copilot ${useBridge ? '(VS Code Bridge)' : '(GitHub API)'} — ${model} — max ${maxTokens} tokens`);

  const headers = { 'Content-Type': 'application/json' };
  if (!useBridge) headers['Authorization'] = `Bearer ${token}`;

  const sysMsg = opts.systemPrompt || SYSTEM_PROMPT;
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: sysMsg },
      { role: 'user', content: prompt },
    ],
  });

  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    if (useBridge && (err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED')) {
      throw new Error(
        'Copilot Bridge not running. In VS Code, press Ctrl+Shift+P → "Test Alchemist: Start Copilot Bridge" or install the vscode-bridge extension.'
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new Error(useBridge
        ? 'Copilot Bridge: No permission. Ensure Copilot is signed in and active in VS Code.'
        : 'GitHub Copilot: Authentication failed. Check your GitHub token and Copilot subscription.');
    }
    throw new Error(`Copilot API error (${status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const u = data.usage || {};
  _emit(opts, `← Copilot — ${u.prompt_tokens ?? '?'} in / ${u.completion_tokens ?? '?'} out — ${elapsed}s`);

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Copilot returned empty response');
  return opts.rawText ? content : parseJSON(content);
}

// ── Public interface ───────────────────────────────────────────────────────────
async function callAI(prompt, maxTokens = 8192, opts = {}) {
  const provider = opts.provider || detectProvider(opts.model) || 'copilot';
  switch (provider) {
    case 'openai':  return callOpenAI(prompt, maxTokens, opts);
    case 'gemini':  return callGemini(prompt, maxTokens, opts);
    case 'copilot': return callCopilot(prompt, maxTokens, opts);
    default:        return callClaude(prompt, maxTokens, opts);
  }
}

/**
 * Call AI with image(s) for vision analysis.
 * images: [{ base64, mimeType }] — array of base64-encoded images
 */
async function callAIWithImages(prompt, images, maxTokens = 4096, opts = {}) {
  const provider = opts.provider || detectProvider(opts.model) || 'copilot';
  const sysMsg = opts.systemPrompt || SYSTEM_PROMPT;

  _emit(opts, `→ Vision (${provider}) — ${images.length} image(s)`);
  const t0 = Date.now();

  let text;

  if (provider === 'claude') {
    const key = resolveKey(opts, 'claude');
    if (!key) throw new Error('Claude API key required for vision — CLI does not support images');
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    const model = opts.model || 'claude-sonnet-4-6';

    const content = images.map(img => {
      if (img.mimeType === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: img.base64 } };
      }
      return { type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } };
    });
    content.push({ type: 'text', text: prompt });

    const msg = await client.messages.create({
      model, max_tokens: maxTokens, system: sysMsg,
      messages: [{ role: 'user', content }],
    });
    text = msg.content[0].text;

  } else if (provider === 'openai') {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: resolveKey(opts, 'openai') });
    const model = opts.model || 'gpt-4o';

    // OpenAI doesn't support PDF natively — extract text for PDFs, use image_url for images
    const content = [];
    for (const img of images) {
      if (img.mimeType === 'application/pdf') {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(Buffer.from(img.base64, 'base64'));
        const pdfText = pdfData.text.length > 80000 ? pdfData.text.slice(0, 80000) + '\n\n[... PDF truncated due to size ...]' : pdfData.text;
        content.push({ type: 'text', text: `[PDF Document: ${img.name || 'document'}]\n${pdfText}` });
      } else {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
      }
    }
    content.push({ type: 'text', text: prompt });

    const response = await client.chat.completions.create({
      model, max_tokens: maxTokens,
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content },
      ],
    });
    text = response.choices[0].message.content;

  } else if (provider === 'gemini') {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(resolveKey(opts, 'gemini'));
    const modelId = opts.model || 'gemini-2.0-flash';
    const model = genAI.getGenerativeModel({ model: modelId, systemInstruction: sysMsg });

    // Gemini supports PDF natively via inlineData
    const parts = images.map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.base64 },
    }));
    parts.push({ text: prompt });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    });
    text = result.response.text();

  } else {
    // Copilot bridge / GitHub Models — use OpenAI-compatible format
    const token = opts.copilotToken || process.env.GITHUB_TOKEN;
    const useBridge = !token;
    const model = opts.model || 'gpt-4o';
    const endpoint = useBridge
      ? `${COPILOT_BRIDGE_URL}/chat/completions`
      : 'https://models.github.ai/inference/chat/completions';

    const headers = { 'Content-Type': 'application/json' };
    if (!useBridge) headers['Authorization'] = `Bearer ${token}`;

    // Check if there are actual images (not just PDFs) — bridge may not support multimodal
    const hasImages = images.some(img => img.mimeType !== 'application/pdf');

    // Copilot/OpenAI format — extract text from PDFs, use image_url for images
    const content = [];
    let hasMeaningfulPdfText = false;
    const imagePdfs = []; // Track PDFs that need image conversion

    for (const img of images) {
      if (img.mimeType === 'application/pdf') {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(Buffer.from(img.base64, 'base64'));
        const meaningfulChars = pdfData.text.replace(/[\s\n\r]/g, '').length;
        if (meaningfulChars < 50) {
          // Image-based PDF — mark for conversion
          imagePdfs.push(img);
          continue;
        }
        hasMeaningfulPdfText = true;
        // Truncate PDF text to avoid exceeding model context limits
        const pdfText = pdfData.text.length > 80000 ? pdfData.text.slice(0, 80000) + '\n\n[... PDF truncated due to size ...]' : pdfData.text;
        content.push({ type: 'text', text: `[PDF Document: ${img.name || 'document'}]\n${pdfText}` });
      } else if (!useBridge) {
        // Only send image_url to GitHub Models API (not bridge)
        content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
      }
    }

    // Convert image-based PDFs to PNG pages for vision (non-bridge only)
    if (imagePdfs.length && !useBridge) {
      try {
        const { pdf } = await import('pdf-to-img');
        for (const pdfDoc of imagePdfs) {
          const pdfBuffer = Buffer.from(pdfDoc.base64, 'base64');
          let pageNum = 0;
          const maxPages = 20; // Limit pages to avoid huge payloads
          for await (const pageImage of pdf(pdfBuffer, { scale: 1.5 })) {
            pageNum++;
            if (pageNum > maxPages) break;
            const pageBase64 = pageImage.toString('base64');
            content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${pageBase64}` } });
          }
          console.log(`[Vision] Converted ${pdfDoc.name || 'PDF'}: ${Math.min(pageNum, maxPages)} page(s) to images`);
        }
      } catch (convErr) {
        console.warn('[Vision] PDF-to-image conversion failed:', convErr.message);
        throw new Error('Could not convert image-based PDF to images for vision. Use Claude or Gemini provider (native PDF support), or export wireframes as PNG screenshots.');
      }
    } else if (imagePdfs.length && useBridge) {
      throw new Error('This PDF is image-based and Copilot Bridge cannot do vision. Add a GitHub token in Settings for GitHub Models API, or use Claude/Gemini provider.');
    }

    content.push({ type: 'text', text: prompt });

    // If PDFs were provided but none had extractable text and no images were converted
    const hasPdfs = images.some(img => img.mimeType === 'application/pdf');
    if (hasPdfs && !hasMeaningfulPdfText && !hasImages && !imagePdfs.length) {
      throw new Error('This PDF is image-based (no extractable text). Use Claude or Gemini provider for native PDF vision, or export wireframes as PNG screenshots.');
    }

    // If using bridge with images (no PDF text available), bridge doesn't support vision
    if (useBridge && hasImages && content.length <= 1) {
      throw new Error('Copilot Bridge does not support image analysis. Use Claude, OpenAI, or Gemini provider for vision, or upload a PDF instead.');
    }

    // If bridge mode, flatten content to single string (bridge expects plain text messages)
    const userContent = useBridge
      ? content.map(c => c.text || '').filter(Boolean).join('\n\n')
      : content;

    const response = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [
          { role: 'system', content: sysMsg },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Copilot vision error (${response.status}): ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Copilot returned empty response for vision');
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  _emit(opts, `← Vision (${provider}) — ${elapsed}s`);
  return opts.rawText ? text : parseJSON(text);
}

module.exports = { callAI, callAIWithImages, MODELS };
