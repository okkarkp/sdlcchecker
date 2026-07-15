const fs = require('fs');
const path = require('path');

async function parseFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const buffer = fs.readFileSync(file.path);

  switch (ext) {
    case '.pdf':   return parsePdf(buffer);
    case '.xlsx':
    case '.xls':   return parseExcel(buffer);
    case '.docx':
    case '.doc':   return parseWord(buffer);
    case '.pptx':  return parsePptx(buffer);
    case '.ppt':   throw new Error('.ppt (legacy binary) is not supported — please save as .pptx and re-upload.');
    case '.csv':   return buffer.toString('utf-8');
    case '.txt':
    case '.md':    return buffer.toString('utf-8');
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

async function parsePdf(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return data.text;
}

function parseExcel(buffer) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = [];
  workbook.SheetNames.forEach((name) => {
    const ws = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    sheets.push(`=== Sheet: ${name} ===\n${rows.map((r) => r.join('\t')).join('\n')}`);
  });
  return sheets.join('\n\n');
}

async function parseWord(buffer) {
  const mammoth = require('mammoth');
  try {
    const result = await mammoth.extractRawText({ buffer });
    if (!result.value?.trim()) throw new Error('empty document');
    return result.value;
  } catch {
    throw new Error(
      'Could not parse Word document. If this is an old .doc file, please save it as .docx and re-upload.'
    );
  }
}

// PPTX is a ZIP of XML files. Slide text lives in ppt/slides/slide*.xml inside <a:t> nodes.
async function parsePptx(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const n = (s) => parseInt(s.match(/(\d+)\.xml$/)[1]);
      return n(a) - n(b);
    });

  const slides = [];
  for (const [i, slideFile] of slideFiles.entries()) {
    const xml = await zip.files[slideFile].async('text');
    // Extract all <a:t> text nodes and join them
    const tokens = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    if (tokens.length) slides.push(`[Slide ${i + 1}]\n${tokens.join(' ')}`);
  }

  if (!slides.length) throw new Error('No text content found in the PowerPoint file.');
  return slides.join('\n\n');
}

module.exports = { parseFile };
