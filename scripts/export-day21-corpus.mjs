import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const outputDirectory = process.argv[2];
if (!outputDirectory) {
  throw new Error('Usage: npm run prepare:day21-corpus -- <output-directory>');
}

const projectRoot = resolve(import.meta.dirname, '..');
const sources = [
  'README.md',
  'src/types.ts',
  'src/main.ts',
  'src/indexing/markdown-chunker.ts',
  'src/indexing/index-builder.ts',
  'src/indexing/index-controller.ts',
  'src/indexing/index-repository.ts',
  'src/retrieval/vector-search.ts',
  'src/retrieval/retrieval-service.ts',
  'src/ui/chat-view.ts',
];

await mkdir(outputDirectory, { recursive: true });
let totalCharacters = 0;
const corpusHash = createHash('sha256');

for (const source of sources) {
  const content = await readFile(join(projectRoot, source), 'utf8');
  totalCharacters += content.length;
  corpusHash.update(source).update('\0').update(content).update('\0');
  const outputName = `${source.replaceAll('/', ' — ').replace(/\.[^.]+$/, '')}.md`;
  const header = [
    '---',
    `source: ${source}`,
    'challenge_day: 21',
    `kind: ${source.endsWith('.ts') ? 'code' : 'readme'}`,
    '---',
    '',
    `# ${basename(source)}`,
    '',
    `Original project file: \`${source}\``,
    '',
  ];
  const markdown = source.endsWith('.md')
    ? [...header, content.trimEnd(), ''].join('\n')
    : [...header, ...renderCodeSections(content), ''].join('\n');
  await writeFile(join(outputDirectory, outputName), markdown, 'utf8');
}

const estimatedPages = Math.round((totalCharacters / 1800) * 10) / 10;
process.stdout.write(
  `Exported ${sources.length} documents, ${totalCharacters} source characters, approximately ${estimatedPages} pages. Corpus SHA-256: ${corpusHash.digest('hex')}\n`,
);

function renderCodeSections(content) {
  const lines = content.trimEnd().split('\n');
  const sections = [];
  const linesPerSection = 80;
  for (let start = 0; start < lines.length; start += linesPerSection) {
    const end = Math.min(lines.length, start + linesPerSection);
    sections.push(
      `## Part ${Math.floor(start / linesPerSection) + 1} — lines ${start + 1}–${end}`,
      '',
      '````typescript',
      lines.slice(start, end).join('\n'),
      '````',
      '',
    );
  }
  return sections;
}
