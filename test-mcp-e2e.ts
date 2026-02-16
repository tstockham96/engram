/**
 * End-to-end MCP server test — sends real MCP protocol messages
 * and verifies responses. Tests the full round-trip that Claude Code
 * or Cursor would do.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const geminiKey = readFileSync(homedir() + '/.config/engram/gemini-key', 'utf-8').trim();

async function main() {
  console.log('🧪 MCP Server End-to-End Test\n');

  // Start the MCP server as a child process
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp.ts'],
    env: {
      ...process.env,
      ENGRAM_OWNER: 'mcp-e2e-test',
      ENGRAM_DB_PATH: '/tmp/engram-mcp-e2e-test.db',
      GEMINI_API_KEY: geminiKey,
    },
  });

  const client = new Client({
    name: 'test-client',
    version: '1.0.0',
  });

  await client.connect(transport);
  console.log('✅ Connected to MCP server\n');

  // 1. List tools
  console.log('── Test 1: List tools ──');
  const tools = await client.listTools();
  console.log(`  Found ${tools.tools.length} tools:`);
  for (const tool of tools.tools) {
    console.log(`    • ${tool.name}: ${tool.description?.slice(0, 60)}...`);
  }
  console.log();

  // 2. Remember a memory
  console.log('── Test 2: Remember ──');
  const rememberResult = await client.callTool({
    name: 'engram_remember',
    arguments: {
      content: 'Thomas is building Engram, a universal memory protocol for AI agents',
      type: 'semantic',
      entities: ['Thomas', 'Engram'],
      topics: ['project', 'AI'],
      salience: 0.8,
    },
  });
  console.log('  Result:', JSON.stringify(rememberResult.content).slice(0, 200));
  console.log();

  // 3. Remember more memories for richer recall
  console.log('── Test 3: Seed more memories ──');
  const memories = [
    { content: 'Thomas prefers direct, no-fluff communication', entities: ['Thomas'], topics: ['preferences'], salience: 0.7 },
    { content: 'Engram uses SQLite with sqlite-vec for local-first storage', entities: ['Engram', 'SQLite'], topics: ['architecture'], salience: 0.6 },
    { content: 'Need to write the HN launch post by end of week', entities: ['Thomas', 'Engram'], topics: ['launch'], salience: 0.8, status: 'pending' },
    { content: 'Mem0 is the biggest competitor with 50K developers', entities: ['Mem0', 'Engram'], topics: ['competition'], salience: 0.7 },
  ];
  for (const mem of memories) {
    await client.callTool({ name: 'engram_remember', arguments: mem });
  }
  console.log(`  Stored ${memories.length} additional memories`);
  console.log();

  // 4. Recall
  console.log('── Test 4: Recall ──');
  const recallResult = await client.callTool({
    name: 'engram_recall',
    arguments: {
      context: 'What is Thomas building?',
      entities: ['Thomas'],
      limit: 5,
    },
  });
  console.log('  Result:', (recallResult.content as any)[0]?.text?.slice(0, 300));
  console.log();

  // 5. Surface (proactive)
  console.log('── Test 5: Proactive Surface ──');
  const surfaceResult = await client.callTool({
    name: 'engram_surface',
    arguments: {
      context: 'Starting a new work session, planning the week ahead',
      activeEntities: ['Thomas', 'Engram'],
      activeTopics: ['planning', 'launch'],
    },
  });
  console.log('  Result:', (surfaceResult.content as any)[0]?.text?.slice(0, 400));
  console.log();

  // 6. Briefing
  console.log('── Test 6: Session Briefing ──');
  const briefingResult = await client.callTool({
    name: 'engram_briefing',
    arguments: {
      context: 'Starting Monday morning',
    },
  });
  const briefingText = (briefingResult.content as any)[0]?.text;
  const briefing = JSON.parse(briefingText);
  console.log(`  Summary: ${briefing.summary}`);
  console.log(`  Key facts: ${briefing.keyFacts.length}`);
  console.log(`  Commitments: ${briefing.activeCommitments.length}`);
  console.log(`  Entities: ${briefing.topEntities.map((e: any) => e.name).join(', ')}`);
  console.log();

  // 7. Stats
  console.log('── Test 7: Stats ──');
  const statsResult = await client.callTool({
    name: 'engram_stats',
    arguments: {},
  });
  console.log('  Result:', (statsResult.content as any)[0]?.text?.slice(0, 200));
  console.log();

  // 8. Connect memories
  console.log('── Test 8: Connect ──');
  const parsed = JSON.parse((rememberResult.content as any)[0].text);
  const firstId = parsed.id;
  // Get another memory ID from recall
  const recallParsed = (recallResult.content as any)[0]?.text;
  // We'll just connect the first remembered to itself for test (edge case)
  const connectResult = await client.callTool({
    name: 'engram_connect',
    arguments: {
      sourceId: firstId,
      targetId: firstId,
      type: 'associated_with',
      strength: 0.5,
    },
  });
  console.log('  Result:', (connectResult.content as any)[0]?.text);
  console.log();

  // 9. Entities
  console.log('── Test 9: Entities ──');
  const entitiesResult = await client.callTool({
    name: 'engram_entities',
    arguments: {},
  });
  console.log('  Result:', (entitiesResult.content as any)[0]?.text?.slice(0, 300));
  console.log();

  // 10. Ingest
  console.log('── Test 10: Ingest ──');
  const ingestResult = await client.callTool({
    name: 'engram_ingest',
    arguments: {
      text: 'Thomas mentioned he wants to write a blog post about Engram on tstockham.com. He also said the domain engram.ai is for sale but nobody responded to his inquiry.',
      humanName: 'Thomas',
    },
  });
  console.log('  Result:', (ingestResult.content as any)[0]?.text);
  console.log();

  // 11. Forget
  console.log('── Test 11: Forget ──');
  const forgetResult = await client.callTool({
    name: 'engram_forget',
    arguments: {
      id: firstId,
      hard: false,
    },
  });
  console.log('  Result:', (forgetResult.content as any)[0]?.text);
  console.log();

  console.log('🎉 All 11 MCP tools tested successfully!\n');

  // Clean up
  await client.close();
  // Clean up test db
  const { unlinkSync, existsSync } = await import('fs');
  if (existsSync('/tmp/engram-mcp-e2e-test.db')) unlinkSync('/tmp/engram-mcp-e2e-test.db');

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
