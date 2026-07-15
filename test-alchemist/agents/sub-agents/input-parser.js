const BaseAgent  = require('../base-agent');
const { parseFile } = require('../../parsers');
const path       = require('path');
const fs         = require('fs');

class InputParserAgent extends BaseAgent {
  constructor() {
    super('input-parser', 'Input Parser', 'Parses PDF, Excel, Word, PPTX, CSV and text inputs', '📥');
  }

  async execute({ files = [], userStory, requirements, rules }, opts = {}) {
    const inputs = [];

    if (userStory)    inputs.push({ type: 'user_story',    content: userStory });
    if (requirements) inputs.push({ type: 'requirements', content: requirements });
    if (rules)        inputs.push({ type: 'rules',        content: rules });

    for (const file of files) {
      try {
        const content = await parseFile(file);
        inputs.push({ type: this._extType(file.originalname), filename: file.originalname, content });
      } catch (e) {
        inputs.push({ type: 'error', filename: file.originalname, content: e.message });
      } finally {
        try { fs.unlinkSync(file.path); } catch {}
      }
    }

    if (!inputs.length) throw new Error('No input provided to Input Parser Agent.');
    return { inputs, count: inputs.length };
  }

  _extType(name) {
    const m = { '.pdf':'pdf','.xlsx':'excel','.xls':'excel','.docx':'word','.doc':'word',
                '.pptx':'pptx','.csv':'csv','.txt':'text','.md':'markdown' };
    return m[path.extname(name).toLowerCase()] || 'text';
  }
}

module.exports = new InputParserAgent();
