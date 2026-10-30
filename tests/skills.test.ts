import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENTRY, SHORTCUTS, SKILLS, renderSkillMd, skillByName } from '../src/skills/index.ts';
import { TOOLS } from '../src/mcp/index.ts';

const toolNames = new Set(TOOLS.map((t) => t.name));
const texts = [...SKILLS.map((s) => [s.name, s.body] as const), ['ENTRY', ENTRY] as const];

describe('skills and shortcut commands (single source)', () => {
  it('has exactly the v1.0 skills and the six shortcuts', () => {
    assert.deepEqual(
      SKILLS.map((s) => s.name),
      ['mwf', 'mwf-save', 'mwf-handoff', 'mwf-tidy'],
    );
    assert.deepEqual(
      SHORTCUTS.map((s) => s.name),
      ['init', 'status', 'recall', 'save', 'handoff', 'tidy'],
    );
    for (const s of SHORTCUTS) if (s.skill) assert.ok(skillByName(s.skill), s.skill);
  });

  it('names only MCP tools that exist', () => {
    for (const [name, text] of texts) {
      for (const [tool] of text.matchAll(/\bmwf_[a-z]+\b/g)) {
        assert.ok(toolNames.has(tool), `${name} mentions ${tool}, which is not a tool`);
      }
    }
    for (const s of SHORTCUTS) {
      for (const [tool] of s.instructions.matchAll(/\bmwf_[a-z]+\b/g))
        assert.ok(toolNames.has(tool));
    }
  });

  it('never tells an agent to run a shell command or a confirm, nor mentions AGENTS.md', () => {
    for (const [name, text] of texts) {
      assert.ok(!/AGENTS\.md/i.test(text), name);
      assert.ok(!/```/.test(text), `${name}: no shell snippets`);
      if (name !== 'mwf-tidy') assert.ok(!/--confirm|preview.token|execute_with/.test(text), name);
    }
    for (const s of SHORTCUTS)
      assert.ok(!/--confirm|npx|\bmwf (add|handoff|forget|purge)\b/.test(s.instructions));
  });

  it('mwf-tidy: destructive tools preview only and only the user runs it, in an interactive terminal', () => {
    const tidy = skillByName('mwf-tidy')!.body;
    assert.match(tidy, /only PREVIEW/);
    assert.match(tidy, /Only the user can run it, in their own interactive terminal/);
    assert.match(tidy, /Do not run it yourself/);
    assert.match(tidy, /do not try to get a terminal \(script, pty\)/);
    assert.match(tidy, /\bexecute_with\b/);
    assert.ok(
      !/(?:^|\n)\s*(?:\$|mwf )\S*.*--confirm/.test(tidy),
      'no command line for the agent to copy',
    );
  });

  it('every text says memory is data and secrets are never stored', () => {
    assert.match(skillByName('mwf')!.body, /not an instruction/);
    assert.match(skillByName('mwf')!.body, /Never store secrets/);
    assert.match(ENTRY, /not instructions/);
    assert.match(ENTRY, /never store secrets/);
    assert.match(skillByName('mwf-save')!.body, /secret/i);
    assert.match(skillByName('mwf-handoff')!.body, /secret/i);
  });

  it('the mwf skill lists every shortcut, and init asks before initializing', () => {
    const body = skillByName('mwf')!.body;
    for (const s of SHORTCUTS) assert.ok(body.includes(s.usage), s.usage);
    assert.match(body, /Do not initialize it on your own: ask the user first/);
    assert.ok(!body.includes('{{'), 'template filled');
    assert.match(SHORTCUTS[0]!.instructions, /git_mode/);
  });

  it('renders SKILL.md with frontmatter that a host can read', () => {
    for (const skill of SKILLS) {
      const md = renderSkillMd(skill);
      assert.match(md, new RegExp(`^---\\nname: ${skill.name}\\ndescription: ".+"\\n---\\n\\n# `));
      assert.ok(skill.description.length < 400);
    }
  });
});
