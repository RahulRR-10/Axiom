// Diagnostic script: test pdf-parse + check SQLite state
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ── 1. Find the vault path (look for .axiom dir on Desktop or common places) ──
function findVault(startDir) {
  const entries = fs.readdirSync(startDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(startDir, e.name);
    if (e.isDirectory()) {
      const axiomDir = path.join(full, '.axiom');
      if (fs.existsSync(axiomDir)) return full;
    }
  }
  return null;
}

// Search common locations
const home = process.env.USERPROFILE || process.env.HOME;
const searchPaths = [
  path.join(home, 'Desktop'),
  path.join(home, 'Documents'),
  home,
];

let vaultPath = null;
for (const sp of searchPaths) {
  vaultPath = findVault(sp);
  if (vaultPath) break;
}

if (!vaultPath) {
  console.log('ERROR: Could not find a vault with .axiom directory');
  process.exit(1);
}

console.log(`\n=== VAULT: ${vaultPath} ===\n`);

// ── 2. Check SQLite database ──
const dbPath = path.join(vaultPath, '.axiom', 'axiom.db');
if (!fs.existsSync(dbPath)) {
  console.log('ERROR: axiom.db not found at', dbPath);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

console.log('--- FILES TABLE ---');
const files = db.prepare('SELECT id, name, type, subject, indexed_at FROM files LIMIT 20').all();
console.log(`Total files: ${db.prepare('SELECT COUNT(*) as n FROM files').get().n}`);
for (const f of files) {
  console.log(`  [${f.type}] ${f.name} | subject=${f.subject} | indexed=${f.indexed_at}`);
}

console.log('\n--- CHUNKS TABLE ---');
const chunkCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
console.log(`Total chunks: ${chunkCount}`);
if (chunkCount > 0) {
  const sampleChunks = db.prepare(`
    SELECT c.id, c.file_id, c.page_or_slide, substr(c.text, 1, 80) as preview, f.name
    FROM chunks c JOIN files f ON f.id = c.file_id
    LIMIT 5
  `).all();
  for (const c of sampleChunks) {
    console.log(`  file=${c.name} page=${c.page_or_slide}: "${c.preview}..."`);
  }
}

console.log('\n--- CHUNKS_FTS TABLE ---');
try {
  const ftsCount = db.prepare('SELECT COUNT(*) as n FROM chunks_fts').get().n;
  console.log(`Total FTS rows: ${ftsCount}`);
  if (ftsCount > 0) {
    // Test a simple FTS query
    const testWord = db.prepare('SELECT text FROM chunks LIMIT 1').get();
    if (testWord) {
      const firstWord = testWord.text.split(/\s+/)[0];
      console.log(`  Test FTS query for "${firstWord}":`);
      try {
        const ftsResults = db.prepare(`SELECT rowid, substr(text, 1, 80) as t FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 3`).all(`"${firstWord}"`);
        console.log(`  Found ${ftsResults.length} results`);
        for (const r of ftsResults) console.log(`    rowid=${r.rowid}: "${r.t}..."`);
      } catch (e) {
        console.log(`  FTS query error: ${e.message}`);
      }
    }
  }
} catch (e) {
  console.log(`FTS table error: ${e.message}`);
}

// ── 3. Find a PDF and test pdf-parse ──
console.log('\n--- PDF TEXT EXTRACTION TEST ---');
function findPdfs(dir, max = 3) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) results.push(...findPdfs(full, max - results.length));
      else if (e.name.toLowerCase().endsWith('.pdf')) results.push(full);
      if (results.length >= max) break;
    }
  } catch {}
  return results;
}

const pdfs = findPdfs(vaultPath);
console.log(`Found ${pdfs.length} PDFs in vault`);

if (pdfs.length > 0) {
  const pdfParse = require('pdf-parse');
  const testPdf = pdfs[0];
  console.log(`Testing: ${path.basename(testPdf)}`);
  
  const buf = fs.readFileSync(testPdf);
  console.log(`  Buffer size: ${buf.length} bytes`);
  
  const pageTexts = new Map();
  pdfParse(buf, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      const text = content.items
        .filter(item => typeof item.str === 'string')
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pageTexts.set(pageData.pageIndex + 1, text);
      return text;
    }
  }).then(data => {
    console.log(`  pdf-parse result: ${data.numpages} pages, ${data.text.length} chars total`);
    console.log(`  Per-page map has ${pageTexts.size} entries`);
    for (const [page, text] of pageTexts) {
      console.log(`  Page ${page}: ${text.length} chars — "${text.slice(0, 100)}..."`);
      if (page >= 3) { console.log('  ... (truncated)'); break; }
    }
    
    // ── 4. Check if this PDF has chunks in the DB ──
    const fileRow = db.prepare('SELECT id FROM files WHERE path = ?').get(testPdf);
    if (fileRow) {
      const chunks = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE file_id = ?').get(fileRow.id);
      console.log(`\n  DB status for this PDF: file_id=${fileRow.id}, chunks=${chunks.n}`);
    } else {
      console.log(`\n  DB status: PDF NOT in files table`);
    }
    
    db.close();
  }).catch(err => {
    console.log(`  pdf-parse FAILED: ${err.message}`);
    db.close();
  });
} else {
  console.log('No PDFs found in vault to test');
  db.close();
}
