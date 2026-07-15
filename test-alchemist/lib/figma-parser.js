'use strict';
/**
 * lib/figma-parser.js — Figma Export Parser
 *
 * Parses Figma exports to extract application structure:
 * - Screens/pages from frame hierarchy
 * - Interactive components (buttons, inputs, dropdowns)
 * - Navigation flows from prototype connections
 * - Form fields with labels and validation hints
 *
 * Supports:
 * 1. Figma JSON export (from plugins or Figma REST API)
 * 2. Figma image exports (screenshots analyzed via AI)
 * 3. Figma prototype flow JSON
 */

const path = require('path');
const fs   = require('fs');

// ── Component type detection patterns ─────────────────────────────────────────
const COMPONENT_PATTERNS = {
  button:   /button|btn|cta|submit|action/i,
  input:    /input|field|text.?field|text.?box|search.?bar/i,
  dropdown: /dropdown|select|combo.?box|menu|picker/i,
  checkbox: /checkbox|check.?box|toggle|switch/i,
  radio:    /radio|option/i,
  link:     /link|anchor|nav.?item|breadcrumb/i,
  tab:      /tab|tab.?bar|tab.?item|segment/i,
  modal:    /modal|dialog|popup|overlay|drawer/i,
  card:     /card|tile|item|list.?item/i,
  table:    /table|grid|data.?grid|list/i,
  header:   /header|nav.?bar|top.?bar|app.?bar/i,
  sidebar:  /sidebar|side.?nav|drawer|menu/i,
  footer:   /footer|bottom.?bar/i,
  form:     /form|login|sign.?up|register|search/i,
  image:    /image|avatar|icon|logo|illustration/i,
  text:     /heading|title|subtitle|paragraph|label|caption/i,
  toast:    /toast|snackbar|notification|alert|banner/i,
};

/**
 * Parse a Figma JSON export file
 * Returns an app map structure compatible with app-crawler output
 */
function parseFigmaJson(figmaData) {
  if (typeof figmaData === 'string') {
    figmaData = JSON.parse(figmaData);
  }

  // Figma REST API format: { document: { children: [...] } }
  // Plugin export format varies — try to detect
  const root = figmaData.document || figmaData;
  const pages = [];
  const flows = [];

  // Extract pages (top-level children in Figma = pages/canvases)
  const canvases = root.children || root.pages || [root];

  for (const canvas of canvases) {
    // Each canvas contains frames = screens
    const frames = findFrames(canvas);
    for (const frame of frames) {
      const pageInfo = analyzeFrame(frame);
      pages.push(pageInfo);
    }
  }

  // Extract prototype flows (connections between frames)
  extractFlows(canvases, pages, flows);

  const appMap = {
    baseUrl: '(Figma Design)',
    source: 'figma',
    crawledAt: new Date().toISOString(),
    totalPages: pages.length,
    pages,
    navigationFlows: buildFlowGraph(flows),
    summary: buildSummary(pages),
  };

  return appMap;
}

/**
 * Parse Figma image exports (multiple screen PNGs) — generates structure for AI analysis
 * Returns image metadata that can be sent to vision AI
 */
function parseFigmaImages(imageFiles) {
  return imageFiles.map((file, idx) => {
    const name = path.basename(file.originalname || file.name || `screen-${idx + 1}`, path.extname(file.originalname || ''));
    return {
      index: idx,
      filename: file.originalname || file.name,
      screenName: cleanScreenName(name),
      path: file.path || file.filepath,
      size: file.size,
      mimeType: file.mimetype || 'image/png',
    };
  });
}

/**
 * Build an app map from AI-analyzed Figma screenshots
 * Called after the AI has analyzed the images and returned structured data
 */
function buildAppMapFromScreenAnalysis(screens) {
  const pages = screens.map(screen => ({
    url: screen.screenName || screen.name,
    title: screen.title || screen.screenName || screen.name,
    type: screen.type || 'page',
    headings: screen.headings || [],
    forms: screen.forms || [],
    buttons: screen.buttons || [],
    inputs: screen.inputs || [],
    selects: screen.selects || [],
    textareas: screen.textareas || [],
    linkCount: screen.links?.length || 0,
    figmaSource: true,
  }));

  const flows = {};
  screens.forEach(screen => {
    if (screen.navigatesTo?.length) {
      flows[screen.screenName] = screen.navigatesTo.map(nav => ({
        to: nav.target,
        action: nav.trigger || 'click',
      }));
    }
  });

  return {
    baseUrl: '(Figma Design)',
    source: 'figma-images',
    crawledAt: new Date().toISOString(),
    totalPages: pages.length,
    pages,
    navigationFlows: flows,
    summary: buildSummary(pages),
  };
}

// ── Figma JSON Analysis Helpers ───────────────────────────────────────────────

/**
 * Find all top-level frames in a canvas (these are the screens)
 */
function findFrames(canvas) {
  const frames = [];
  const children = canvas.children || [];

  for (const child of children) {
    // Top-level FRAME nodes are screens
    if (child.type === 'FRAME' || child.type === 'COMPONENT_SET' || child.type === 'SECTION') {
      frames.push(child);
    }
  }

  // If no frames found, the canvas itself might be a single screen
  if (!frames.length && children.length > 0) {
    frames.push(canvas);
  }

  return frames;
}

/**
 * Analyze a frame (screen) and extract interactive elements
 */
function analyzeFrame(frame) {
  const elements = { forms: [], buttons: [], inputs: [], selects: [], links: [], textareas: [] };
  const headings = [];

  // Recursive traversal of the frame tree
  traverseNode(frame, elements, headings, 0);

  // Detect page type from name + contents
  const pageType = detectPageType(frame.name, elements, headings);

  // Group inputs into forms based on proximity/grouping
  const forms = groupIntoForms(elements);

  return {
    url: frame.name,
    title: cleanScreenName(frame.name),
    type: pageType,
    headings,
    forms: forms.length ? forms : elements.forms,
    buttons: elements.buttons,
    inputs: elements.inputs,
    selects: elements.selects,
    textareas: elements.textareas,
    linkCount: elements.links.length,
    figmaFrameId: frame.id,
  };
}

/**
 * Recursively traverse Figma node tree to find interactive elements
 */
function traverseNode(node, elements, headings, depth) {
  if (!node) return;

  const name = (node.name || '').toLowerCase();
  const type = node.type;

  // Detect component type from node name
  const detected = detectComponentType(node);

  if (detected === 'button') {
    elements.buttons.push({
      text: extractTextContent(node) || cleanScreenName(node.name),
      type: 'button',
      id: node.id || '',
      disabled: name.includes('disabled') || name.includes('inactive'),
    });
  } else if (detected === 'input' || detected === 'textarea') {
    const info = {
      tag: detected === 'textarea' ? 'textarea' : 'input',
      type: guessInputType(node.name),
      name: node.name,
      id: node.id || '',
      placeholder: extractPlaceholder(node),
      required: name.includes('required') || name.includes('*'),
      label: extractNearbyLabel(node),
    };
    if (detected === 'textarea') elements.textareas.push(info);
    else elements.inputs.push(info);
  } else if (detected === 'dropdown') {
    elements.selects.push({
      tag: 'select',
      name: node.name,
      id: node.id || '',
      label: extractNearbyLabel(node),
      options: extractDropdownOptions(node),
    });
  } else if (detected === 'link' || detected === 'tab') {
    elements.links.push({
      text: extractTextContent(node) || node.name,
      href: '#',
    });
  } else if (detected === 'form') {
    const formFields = [];
    extractFormFields(node, formFields);
    if (formFields.length) {
      elements.forms.push({
        id: node.id || node.name,
        action: '',
        method: 'POST',
        fields: formFields,
        submitButton: findSubmitInChildren(node),
      });
    }
  }

  // Text nodes that look like headings
  if (type === 'TEXT' && node.style) {
    const fontSize = node.style.fontSize || 0;
    if (fontSize >= 20) {
      headings.push({ level: fontSize >= 32 ? 1 : fontSize >= 24 ? 2 : 3, text: node.characters || node.name });
    }
  }

  // Recurse into children
  const children = node.children || [];
  for (const child of children) {
    traverseNode(child, elements, headings, depth + 1);
  }
}

/**
 * Detect what type of UI component a node represents
 */
function detectComponentType(node) {
  const name = (node.name || '').toLowerCase();
  const compName = (node.componentName || node.mainComponent?.name || '').toLowerCase();
  const combined = `${name} ${compName}`;

  for (const [type, pattern] of Object.entries(COMPONENT_PATTERNS)) {
    if (pattern.test(combined)) return type;
  }

  // Heuristic: if it has "characters" property and is styled bold/large, it's text
  if (node.type === 'TEXT') return 'text';

  return null;
}

function guessInputType(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('email')) return 'email';
  if (n.includes('password') || n.includes('pass')) return 'password';
  if (n.includes('phone') || n.includes('tel')) return 'tel';
  if (n.includes('number') || n.includes('amount') || n.includes('qty')) return 'number';
  if (n.includes('date')) return 'date';
  if (n.includes('url') || n.includes('website')) return 'url';
  if (n.includes('search')) return 'search';
  return 'text';
}

function extractTextContent(node) {
  if (node.characters) return node.characters.trim().substring(0, 60);
  if (node.children) {
    for (const child of node.children) {
      const text = extractTextContent(child);
      if (text) return text;
    }
  }
  return '';
}

function extractPlaceholder(node) {
  // Look for child text that looks like placeholder
  if (node.children) {
    for (const child of node.children) {
      if (child.type === 'TEXT' && child.opacity !== undefined && child.opacity < 1) {
        return child.characters || '';
      }
      if (child.type === 'TEXT' && (child.name || '').toLowerCase().includes('placeholder')) {
        return child.characters || '';
      }
    }
  }
  return '';
}

function extractNearbyLabel(node) {
  // In Figma, labels are usually sibling or parent text nodes
  return cleanScreenName(node.name).replace(/input|field|text/gi, '').trim() || '';
}

function extractDropdownOptions(node) {
  const options = [];
  if (node.children) {
    for (const child of node.children) {
      if (child.type === 'TEXT' && child.characters) {
        options.push(child.characters.trim());
      }
    }
  }
  return options.slice(0, 15);
}

function extractFormFields(node, fields) {
  if (!node.children) return;
  for (const child of node.children) {
    const detected = detectComponentType(child);
    if (detected === 'input' || detected === 'textarea' || detected === 'dropdown' || detected === 'checkbox' || detected === 'radio') {
      fields.push({
        tag: detected === 'dropdown' ? 'select' : detected === 'textarea' ? 'textarea' : 'input',
        type: detected === 'checkbox' ? 'checkbox' : detected === 'radio' ? 'radio' : guessInputType(child.name),
        name: child.name,
        id: child.id || '',
        label: extractNearbyLabel(child),
        required: (child.name || '').toLowerCase().includes('required'),
      });
    }
    extractFormFields(child, fields);
  }
}

function findSubmitInChildren(node) {
  if (!node.children) return null;
  for (const child of node.children) {
    if (detectComponentType(child) === 'button') {
      return extractTextContent(child) || cleanScreenName(child.name);
    }
    const found = findSubmitInChildren(child);
    if (found) return found;
  }
  return null;
}

/**
 * Extract prototype flows/connections between frames
 */
function extractFlows(canvases, pages, flows) {
  for (const canvas of canvases) {
    traverseForFlows(canvas, pages, flows);
  }
}

function traverseForFlows(node, pages, flows) {
  if (!node) return;

  // Figma prototype interactions
  if (node.transitionNodeID || node.reactions?.length) {
    const reactions = node.reactions || [];
    for (const reaction of reactions) {
      const action = reaction.action;
      if (action?.type === 'NODE' && action.destinationId) {
        const fromPage = findParentFrame(node, pages);
        const toPage = pages.find(p => p.figmaFrameId === action.destinationId);
        if (fromPage && toPage) {
          flows.push({
            from: fromPage.url,
            to: toPage.url,
            trigger: reaction.trigger?.type || 'ON_CLICK',
            element: node.name,
          });
        }
      }
    }

    // Legacy transitionNodeID
    if (node.transitionNodeID) {
      const fromPage = findParentFrame(node, pages);
      const toPage = pages.find(p => p.figmaFrameId === node.transitionNodeID);
      if (fromPage && toPage) {
        flows.push({
          from: fromPage.url,
          to: toPage.url,
          trigger: 'ON_CLICK',
          element: node.name,
        });
      }
    }
  }

  if (node.children) {
    for (const child of node.children) {
      traverseForFlows(child, pages, flows);
    }
  }
}

function findParentFrame(node, pages) {
  // Simple heuristic: find which page this node belongs to by ID prefix
  // In real usage, we'd track parent references during traversal
  return pages[0]; // fallback
}

function buildFlowGraph(flows) {
  const graph = {};
  for (const f of flows) {
    if (!graph[f.from]) graph[f.from] = [];
    graph[f.from].push({ to: f.to, action: `${f.trigger} on "${f.element}"` });
  }
  return graph;
}

function detectPageType(frameName, elements, headings) {
  const name = (frameName || '').toLowerCase();
  if (name.includes('login') || name.includes('sign in')) return 'login';
  if (name.includes('register') || name.includes('sign up')) return 'registration';
  if (name.includes('dashboard') || name.includes('home')) return 'dashboard';
  if (name.includes('settings') || name.includes('preference')) return 'settings';
  if (name.includes('profile')) return 'profile';
  if (name.includes('search') || name.includes('filter')) return 'search';
  if (name.includes('list') || name.includes('table')) return 'list';
  if (name.includes('detail') || name.includes('view')) return 'detail';
  if (name.includes('form') || name.includes('create') || name.includes('edit')) return 'form';
  if (name.includes('modal') || name.includes('dialog')) return 'modal';
  if (name.includes('error') || name.includes('404') || name.includes('empty')) return 'error';
  if (elements.forms.length || elements.inputs.length > 3) return 'form';
  return 'page';
}

function buildSummary(pages) {
  const types = {};
  let totalForms = 0, totalButtons = 0, totalInputs = 0;
  pages.forEach(p => {
    types[p.type] = (types[p.type] || 0) + 1;
    totalForms += (p.forms?.length || 0);
    totalButtons += (p.buttons?.length || 0);
    totalInputs += (p.inputs?.length || 0) + (p.selects?.length || 0) + (p.textareas?.length || 0);
  });
  return { pageTypes: types, totalForms, totalButtons, totalInputs };
}

function cleanScreenName(name) {
  return (name || '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\d+\s*/, '') // remove leading numbers
    .trim();
}

/**
 * Generate compact AI context from a Figma-sourced app map
 */
function getFigmaContext(appMap) {
  if (!appMap || !appMap.pages?.length) return '';

  const lines = [`\nAPPLICATION DESIGN (${appMap.totalPages} screens from Figma):\n`];

  for (const page of appMap.pages) {
    lines.push(`• [${page.type.toUpperCase()}] ${page.title}`);

    if (page.forms?.length) {
      page.forms.forEach(form => {
        const fieldNames = form.fields.map(f => f.label || f.name || f.type).join(', ');
        lines.push(`  FORM: Fields: ${fieldNames}`);
        if (form.submitButton) lines.push(`    Submit: "${form.submitButton}"`);
      });
    }

    if (page.buttons?.length) {
      lines.push(`  BUTTONS: ${page.buttons.map(b => `"${b.text}"`).join(', ')}`);
    }

    if (page.inputs?.length || page.selects?.length) {
      const all = [...(page.inputs || []), ...(page.selects || [])];
      if (all.length) lines.push(`  INPUTS: ${all.map(i => i.label || i.name || i.type).join(', ')}`);
    }
    lines.push('');
  }

  if (Object.keys(appMap.navigationFlows || {}).length) {
    lines.push('SCREEN FLOWS:');
    for (const [from, edges] of Object.entries(appMap.navigationFlows)) {
      edges.forEach(e => lines.push(`  ${from} → ${e.to} (${e.action})`));
    }
  }

  return lines.join('\n');
}

module.exports = {
  parseFigmaJson,
  parseFigmaImages,
  buildAppMapFromScreenAnalysis,
  getFigmaContext,
};
