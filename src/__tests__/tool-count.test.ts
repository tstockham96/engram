import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MCP_TOOLS = [
  'engram_remember',
  'engram_recall',
  'engram_forget',
  'engram_consolidate',
  'engram_connect',
  'engram_stats',
  'engram_ingest',
  'engram_ask',
  'engram_alerts',
  'engram_checkpoint',
  'engram_audit',
  'engram_surface',
  'engram_briefing',
  'engram_entities',
  'engram_import_obsidian',
  'engram_import_claude_code',
  'engram_powered_by',
];

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('MCP tool count', () => {
  it('registers exactly 17 tools in src/mcp.ts', () => {
    const mcp = read('src/mcp.ts');
    const registered = [...mcp.matchAll(/server\.tool\(\s*'([^']+)'/g)].map(match => match[1]);
    expect(registered).toEqual(MCP_TOOLS);
    expect(registered).toHaveLength(17);
  });

  it('advertises those same 17 tools in the README, docs, and engram init', () => {
    const readme = read('README.md');
    const docs = read('docs/claude-code-setup.md');
    const cli = read('src/cli.ts');

    expect(readme).toContain('17 memory tools');
    expect(docs).toContain('17 MCP tools');
    expect(cli).toContain('17 memory tools');

    const approved = [...cli.matchAll(/'mcp__engram__(engram_[a-z_]+)'/g)].map(match => match[1]);
    expect([...approved].sort()).toEqual([...MCP_TOOLS].sort());

    for (const name of MCP_TOOLS) {
      expect(readme).toContain(`\`${name}\``);
      expect(cli).toContain(name);
    }
  });
});
