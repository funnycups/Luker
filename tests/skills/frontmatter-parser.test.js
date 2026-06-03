import { describe, test, expect } from '@jest/globals';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter-parser.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseSkillFrontmatter', () => {
    test('parses minimal valid SKILL.md', () => {
        const result = parseSkillFrontmatter(fixture('valid-skill.md'));
        expect(result).toEqual({
            name: 'test-skill',
            description: 'A simple test skill',
            license: null,
            metadata: { author: null, version: null, tags: [] },
        });
    });

    test('parses full metadata', () => {
        const result = parseSkillFrontmatter(fixture('valid-with-metadata.md'));
        expect(result.name).toBe('full-metadata-skill');
        expect(result.license).toBe('MIT');
        expect(result.metadata.author).toBe('Test Author');
        expect(result.metadata.version).toBe('1.0.0');
        expect(result.metadata.tags).toEqual(['test', 'sample']);
    });

    test('throws on missing frontmatter delimiter', () => {
        expect(() => parseSkillFrontmatter(fixture('invalid-no-frontmatter.md')))
            .toThrow(/must start with YAML frontmatter/);
    });

    test('throws on missing name', () => {
        expect(() => parseSkillFrontmatter(fixture('invalid-no-name.md')))
            .toThrow(/frontmatter must include name/);
    });

    test('throws on missing description', () => {
        expect(() => parseSkillFrontmatter('---\nname: x\n---\nbody'))
            .toThrow(/frontmatter must include description/);
    });

    test('validates name format and length', () => {
        expect(() => parseSkillFrontmatter('---\nname: Bad Name\ndescription: x\n---\n'))
            .toThrow(/name must match/);
        expect(() => parseSkillFrontmatter(`---\nname: ${'a'.repeat(129)}\ndescription: x\n---\n`))
            .toThrow(/name must be/);
    });

    test('normalizes CRLF line endings', () => {
        const text = '---\r\nname: crlf-test\r\ndescription: handles CRLF\r\n---\r\nBody\r\n';
        const result = parseSkillFrontmatter(text);
        expect(result.name).toBe('crlf-test');
    });
});
