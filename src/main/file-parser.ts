import * as fs from 'fs';
import * as path from 'path';

const TEXT_EXTS = new Set(['.txt', '.csv', '.tsv', '.json', '.xml', '.md', '.log', '.html', '.yml', '.yaml']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

const MAX_TEXT_SIZE = 200_000; // chars
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

/**
 * Parse a file into text content suitable for LLM consumption.
 * Returns null for images (handled separately).
 */
export async function parseFileToText(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const stat = fs.statSync(filePath);

  if (stat.size > MAX_FILE_SIZE) {
    return `[File: ${name}] (skipped — too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB)`;
  }

  if (IMAGE_EXTS.has(ext)) return null;

  // Plain text formats
  if (TEXT_EXTS.has(ext)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const truncated = content.length > MAX_TEXT_SIZE
        ? content.substring(0, MAX_TEXT_SIZE) + '\n... [truncated]'
        : content;
      return `[File: ${name}]\n\`\`\`\n${truncated}\n\`\`\``;
    } catch (err: any) {
      return `[File: ${name}] (error reading: ${err.message})`;
    }
  }

  // Excel
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.readFile(filePath);
      const parts: string[] = [`[File: ${name}] (Excel workbook)`];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        const truncated = csv.length > MAX_TEXT_SIZE / workbook.SheetNames.length
          ? csv.substring(0, MAX_TEXT_SIZE / workbook.SheetNames.length) + '\n... [truncated]'
          : csv;
        parts.push(`\n## Sheet: ${sheetName}\n\`\`\`csv\n${truncated}\n\`\`\``);
      }

      return parts.join('\n');
    } catch (err: any) {
      return `[File: ${name}] (Excel parse error: ${err.message})`;
    }
  }

  // PDF
  if (ext === '.pdf') {
    try {
      // Import the lib subpath directly — pdf-parse's index.js has a debug
      // mode that tries to read a test PDF on import, which fails in production.
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js' as any)).default;
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      const text = data.text || '';
      const truncated = text.length > MAX_TEXT_SIZE
        ? text.substring(0, MAX_TEXT_SIZE) + '\n... [truncated]'
        : text;
      return `[File: ${name}] (PDF, ${data.numpages} pages)\n\`\`\`\n${truncated}\n\`\`\``;
    } catch (err: any) {
      return `[File: ${name}] (PDF parse error: ${err.message})`;
    }
  }

  // DOCX — try as text (will be garbled, but better than nothing)
  if (ext === '.docx' || ext === '.doc') {
    return `[File: ${name}] (DOCX format — please save as PDF or TXT for parsing)`;
  }

  // Unknown — try as text
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > 0 && /[\x20-\x7E\n\r\t]/.test(content.substring(0, 100))) {
      const truncated = content.length > MAX_TEXT_SIZE ? content.substring(0, MAX_TEXT_SIZE) : content;
      return `[File: ${name}]\n\`\`\`\n${truncated}\n\`\`\``;
    }
  } catch {}

  return `[File: ${name}] (binary file, ${stat.size} bytes — cannot parse)`;
}
