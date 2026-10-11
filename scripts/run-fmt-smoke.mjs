import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const output = process.argv[2] ?? await mkdtemp(join(tmpdir(), 'ai-advent-fmt-'));
await mkdir(output, { recursive: true });
const runtime = join(output, 'runtime.cjs');
await build({ stdin: { contents: "export { formatNote } from './src/rag/format-service'; export { ConfigurableLlmClient } from './src/llm/llm-client'; export { LocalStreamingTransport } from './src/infrastructure/local-streaming-transport';", resolveDir: process.cwd() }, outfile: runtime, bundle: true, platform: 'node', format: 'cjs' });
const { formatNote, ConfigurableLlmClient, LocalStreamingTransport } = createRequire(import.meta.url)(resolve(runtime));
const skill = await readFile('vault-skills/fmt/SKILL.md', 'utf8');
const transport = new LocalStreamingTransport();
const llm = new ConfigurableLlmClient(transport);
const config = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.8:27b' };
const code = '```python\nprint("ошибко 250")\n```';
const frontmatter = '---\ntags: [еда]\naliases: ["Тест"]\n---';
const cases = [
  { name: 'language-and-protected-content', title: 'Рецепт', content: `${frontmatter}\n# Рецепт\n\n## Приготовление\n\nЯ добовил 250 г муки и 2 яйца. Тесто получились мягким.\n\nСмотри [[Кухня|мои рецепты]] и ![[photo.png]].\n\n${code}\n`, check: (text) => ({ spelling: text.includes('добавил') && !text.includes('добовил'), grammar: text.includes('получилось мягким'), numbers: text.includes('250 г') && text.includes('2 яйца'), metadata: text.startsWith(frontmatter), links: text.includes('[[Кухня|мои рецепты]]') && text.includes('![[photo.png]]'), code: text.includes(code), noDuplicateTitle: !/^# Рецепт$/m.test(text), compactHeading: text.includes('## Приготовление\nЯ'), noWrapper: !text.startsWith('```markdown') }) },
  { name: 'footnotes-and-information', title: 'Посёлок', content: '## История\n\nВ посёлке жили 1708 человек в 90 дворах[^1].\n\n## Источники\n[^1]: [Архив](https://example.org/archive?id=7)\nЗаметка автора: сведения относятся к 1900 году.\n', check: (text) => ({ numbers: ['1708', '90', '1900'].every((value) => text.includes(value)), url: text.includes('https://example.org/archive?id=7'), annotation: text.includes('сведения относятся к 1900 году'), preservedSourceSection: text.includes('## Источники'), linkAfterPunctuation: text.includes('дворах. [Архив]'), noInventedCitations: !text.includes('[S1]') }) },
  { name: 'tasks-negation-and-callout', title: 'План', content: '## План\n\nЯ не хочу меняеть срок: 11.10.2026.\n\nНапример\nнужно проверить список.\n\n- [x] Купить 3 билета\n- [ ] Не покупать 4-й билет\n\n> [!note]\n> Значение свойства `draft: false` не менять.\n\n#план ^plan-1\n', check: (text) => ({ spelling: !text.includes('меняеть'), introductoryComma: text.includes('Например, нужно'), compactList: !text.includes('\n\n- [x]'), negation: text.includes('не хочу') && text.includes('Не покупать'), date: text.includes('11.10.2026'), tasks: text.includes('- [x] Купить 3 билета') && text.includes('- [ ] Не покупать 4-й билет'), callout: text.includes('> [!note]\n> Значение свойства `draft: false` не менять.'), ids: text.includes('#план') && text.includes('^plan-1') }) },
];
const report = [];
try {
  for (const test of cases) {
    process.stdout.write(`Starting ${test.name}\n`);
    const note = { path: `${test.title}.md`, title: test.title, content: test.content, mtime: 1 };
    await writeFile(join(output, `${test.name}.input.md`), test.content);
    const start = Date.now();
    const result = await formatNote('/fmt', note, skill, llm, config, () => {});
    await writeFile(join(output, `${test.name}.output.md`), result.text);
    const checks = test.check(result.text);
    report.push({ name: test.name, durationMs: Date.now() - start, checks });
    process.stdout.write(`${JSON.stringify(report.at(-1))}\n`);
  }
} finally {
  transport.dispose();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(`Results: ${output}\n`);
if (report.some((test) => Object.values(test.checks).some((pass) => !pass))) process.exitCode = 1;
