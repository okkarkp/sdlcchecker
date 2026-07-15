'use strict';
const express  = require('express');
const router   = express.Router();
const db       = require('../lib/db');
const { callAI } = require('../providers');
const { getAppMapContext } = require('../lib/app-crawler');
const { getFigmaContext }  = require('../lib/figma-parser');

// ── Build full context from current state ──────────────────────────────────────
function buildFullContext(clientId, payload) {
  const parts = [];

  // 1. Requirements / parsed inputs
  if (payload.requirements) {
    parts.push(`## Requirements\n${payload.requirements.slice(0, 2000)}`);
  }

  // 2. Scenarios (current generation)
  if (payload.scenarios && payload.scenarios.length) {
    const scenText = payload.scenarios.map(s =>
      `- [${s.sc_id || s.id}] ${s.title} (${s.type || '-'}, ${s.priority || '-'})`
    ).join('\n');
    parts.push(`## Current Scenarios (${payload.scenarios.length})\n${scenText}`);
  }

  // 3. Test cases (current generation)
  if (payload.testcases && payload.testcases.length) {
    const tcText = payload.testcases.map(tc => {
      const steps = (tc.steps || []).map((s, i) =>
        `  ${s.step_number || i + 1}. ${s.action} → ${s.expected_result}`
      ).join('\n');
      return `- [${tc.tc_id || tc.id}] ${tc.title} (${tc.priority || '-'})\n${steps}`;
    }).join('\n');
    parts.push(`## Current Test Cases (${payload.testcases.length})\n${tcText}`);
  }

  // 4. App map context
  try {
    const appMapEntries = db.listKnowledge(clientId).filter(k => k.kind === 'app_map');
    if (appMapEntries.length) {
      const appMap = JSON.parse(appMapEntries[0].guidance);
      const ctx = appMap.source?.includes('figma')
        ? getFigmaContext(appMap)
        : getAppMapContext(appMap);
      if (ctx) parts.push(`## Application Map\n${ctx}`);
    }
  } catch (_) {}

  // 5. Existing knowledge / curated notes
  const keywords = (payload.message || '').split(/\s+/).filter(w => w.length > 4);
  const knowledge = db.getRelevantKnowledge(clientId, payload.module || null, keywords, 8);
  if (knowledge.length) {
    parts.push(`## Curated Notes (learned from previous feedback)\n` +
      knowledge.map(k => `• ${k.guidance}`).join('\n'));
  }

  return parts.join('\n\n');
}

// ── GET /api/chat/history — load conversation thread ───────────────────────────
router.get('/history', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const msgs = db.getChatHistory('feedback', 'global', clientId);
  res.json({ success: true, messages: msgs.map(m => ({
    id: m.id, role: m.role, content: m.content, created_at: m.created_at,
    knowledge: m.diff_json ? JSON.parse(m.diff_json) : null,
  })) });
});

// ── POST /api/chat/send — send feedback, stream response ───────────────────────
router.post('/send', async (req, res) => {
  const { clientId, message, aiOpts = {}, context: ctxPayload = {} } = req.body;
  if (!clientId || !message) return res.status(400).json({ error: 'clientId + message required' });

  // Persist user message
  db.saveChatMessage({ clientId, itemType: 'feedback', itemId: 'global', role: 'user', content: message });

  // Build full context
  const fullContext = buildFullContext(clientId, { ...ctxPayload, message });

  // Recent conversation history
  const history = db.getChatHistory('feedback', 'global', clientId);
  const recentMsgs = history.slice(-10).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

  const systemPrompt = `You are the AI Feedback Assistant for Test Alchemist, a QA test generation tool.

Your role:
- Answer questions about the test artifacts (scenarios, test cases, requirements, app flows)
- Capture user feedback as concise rules for future generation improvement
- Suggest what to regenerate based on feedback
- You do NOT edit or modify any test cases directly

${fullContext}

IMPORTANT: After your response, if the user's message contains actionable feedback that should improve future test generation, output on the LAST line:
<<<LEARN>>> <one concise imperative rule that should be applied in future generations> <<<END>>>

If the message is just a question with no actionable feedback, do NOT output a LEARN block.

Keep answers concise and helpful.`;

  const prompt = recentMsgs
    ? recentMsgs + '\nUser: ' + message
    : message;

  // SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let fullResponse = '';
  const opts = {
    ...aiOpts,
    provider: aiOpts.provider || 'copilot',
    model:    aiOpts.model    || 'claude-sonnet-4',
    systemPrompt,
    rawText: true,
    broadcastFn: (chunk) => {
      if (chunk.subtype === 'token') {
        fullResponse += chunk.message;
        res.write(`data: ${JSON.stringify({ type: 'token', text: chunk.message })}\n\n`);
      }
    }
  };

  try {
    await callAI(prompt, 2048, opts);

    // Parse learned rule
    const learnMatch = fullResponse.match(/<<<LEARN>>>([\s\S]*?)<<<END>>>/);
    let learnedRule = '';
    if (learnMatch) learnedRule = learnMatch[1].trim();

    // Strip markers from display text
    const displayText = fullResponse
      .replace(/<<<LEARN>>>[\s\S]*?<<<END>>>/g, '')
      .trim();

    // Save assistant message (store knowledge ref in diff_json field for retrieval)
    let savedKnowledge = null;
    if (learnedRule && learnedRule.length > 10) {
      const kId = db.saveKnowledgeEntry({
        clientId,
        kind: 'feedback',
        module: ctxPayload.module || null,
        triggerText: message.slice(0, 200),
        guidance: learnedRule,
        sourceItemId: 'global',
        sourceItemType: 'feedback',
      });
      savedKnowledge = { id: kId, guidance: learnedRule };
    }

    db.saveChatMessage({
      clientId, itemType: 'feedback', itemId: 'global',
      role: 'assistant', content: displayText,
      diffJson: savedKnowledge || null,
    });

    res.write(`data: ${JSON.stringify({
      type: 'done',
      displayText,
      knowledge: savedKnowledge,
    })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.end();
});

// ── POST /api/chat/clear — clear chat history ──────────────────────────────────
router.post('/clear', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    db.clearChatHistory('feedback', 'global', clientId);
  } catch (_) {}
  res.json({ success: true });
});

// ── POST /api/chat/bulk-update — AI-driven bulk field changes ──────────────────
router.post('/bulk-update', async (req, res) => {
  const { clientId, message, itemType, itemIds, items, aiOpts = {} } = req.body;
  if (!clientId || !message || !itemType || !itemIds?.length) {
    return res.status(400).json({ error: 'clientId, message, itemType, itemIds required' });
  }

  // Build item summaries for AI context
  const itemSummaries = (items || []).map(item => {
    if (itemType === 'scenario') {
      return `{ id: "${item.id}", title: "${item.title}", priority: "${item.priority || ''}", type: "${item.type || ''}", module: "${item.module || ''}", tags: ${JSON.stringify(item.tags || [])} }`;
    }
    return `{ id: "${item.id}", tc_id: "${item.tc_id || ''}", title: "${item.title}", priority: "${item.priority || ''}", type: "${item.type || ''}", module: "${item.module || ''}", preconditions: ${JSON.stringify(item.preconditions || [])}, expected_result: "${item.expected_result || ''}" }`;
  }).join('\n');

  const allowedFields = itemType === 'scenario'
    ? ['title', 'module', 'type', 'priority', 'tags', 'acceptance_criteria', 'description']
    : ['title', 'module', 'priority', 'type', 'preconditions', 'steps', 'expected_result', 'labels', 'automation_notes'];

  const systemPrompt = `You are a QA assistant that applies bulk changes to test artifacts.

The user wants to modify ${itemIds.length} ${itemType}(s). Interpret their instruction and produce a JSON array of updates.

Allowed fields for ${itemType}: ${JSON.stringify(allowedFields)}

Current items:
${itemSummaries}

IMPORTANT RULES:
- Output ONLY a valid JSON array. No explanation, no markdown fences.
- Each element: { "id": "<item id>", "changes": { "<field>": <new_value> } }
- For array fields (tags, preconditions, labels, acceptance_criteria, steps), output the FULL array value.
- For steps, each step is: { "step_number": N, "action": "...", "expected_result": "..." }
- Only include items that need changes.
- If the instruction is unclear or can't be applied, output: []`;

  const opts = {
    ...aiOpts,
    provider: aiOpts.provider || 'copilot',
    model: aiOpts.model || 'claude-sonnet-4',
    systemPrompt,
    rawText: true,
  };

  try {
    const aiResponse = await callAI('User instruction: ' + message, 4096, opts);
    const responseText = (typeof aiResponse === 'string' ? aiResponse : aiResponse?.text || '').trim();

    // Extract JSON from response (handle markdown fences if AI adds them)
    let jsonStr = responseText;
    const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    let updates;
    try {
      updates = JSON.parse(jsonStr);
    } catch (parseErr) {
      return res.json({ success: false, error: 'AI returned invalid JSON', raw: responseText.slice(0, 500) });
    }

    if (!Array.isArray(updates) || !updates.length) {
      return res.json({ success: true, updated: 0, message: 'No changes needed based on your instruction.' });
    }

    // Apply changes
    let updated = 0;
    const changes = [];
    for (const upd of updates) {
      if (!upd.id || !upd.changes || !itemIds.includes(upd.id)) continue;
      try {
        if (itemType === 'scenario') {
          db.updateScenario(upd.id, clientId, upd.changes);
        } else {
          db.updateTestCase(upd.id, clientId, upd.changes);
        }
        updated++;
        changes.push({ id: upd.id, fields: Object.keys(upd.changes) });
      } catch (e) {
        console.warn(`[BulkUpdate] Failed for ${upd.id}:`, e.message);
      }
    }

    // Save as knowledge if it seems like a recurring preference
    const learnablePatterns = /always|never|all .* should|every .* must|default|standard/i;
    if (learnablePatterns.test(message) && updated > 0) {
      db.saveKnowledgeEntry({
        clientId,
        kind: 'feedback',
        module: null,
        triggerText: message.slice(0, 200),
        guidance: message,
        sourceItemId: 'bulk-update',
        sourceItemType: itemType,
      });
    }

    res.json({ success: true, updated, total: itemIds.length, changes });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
