// Acceptance tests for specs/policy-qa.md: AT-1 (handbookBody) and AT-2 (handbookSections).
// Fixture H is a test-local synthetic raw handbook, not the real one.
import { describe, expect, it } from 'vitest';
import {
  HandbookFormatError,
  HandbookSection,
  handbookBody,
  handbookSections,
} from './handbook.js';

const H = [
  '---',
  'title: Synthetic Handbook',
  'version: test',
  '---',
  '# Synthetic Employee Handbook',
  '',
  'This handbook is fictional test data.',
  '',
  '## HB-1 Leave',
  '',
  'This chapter covers leave.',
  '',
  '### HB-1.1 Annual leave',
  '',
  'Employees get 20 days of annual leave. The leave year runs from 1 April to 31 March.',
  '',
  '### HB-1.2 Sick leave',
  '',
  'Employees get 10 sick days per year. A medical note is needed after three days.',
  'Individual cases are handled by HR.',
  '',
  '## HB-2 Expenses',
  '',
  '### HB-2.1 Claims',
  '',
  'Approved claims are paid with the next pay run.',
  'The leave year runs from 1 April to 31 March.',
  'Individual cases are handled by HR.',
  '',
].join('\n');

const FRONTMATTER_LINES = 4;
const bodyOf = (raw: string): string => raw.split('\n').slice(FRONTMATTER_LINES).join('\n');

describe('policy-qa AT-1: handbookBody', () => {
  it('AT-1: strips the frontmatter and keeps the rest byte for byte', () => {
    const body = handbookBody(H);
    expect(body).toBe(bodyOf(H));
    expect(body.startsWith('# Synthetic Employee Handbook')).toBe(true);
    expect(body).not.toContain('title: Synthetic Handbook');
  });

  it('AT-1: CRLF frontmatter is recognised and the body keeps every CRLF', () => {
    const crlf = H.replace(/\n/g, '\r\n');
    const body = handbookBody(crlf);
    expect(body).toBe(bodyOf(H).replace(/\n/g, '\r\n'));
    expect(body.startsWith('# Synthetic Employee Handbook\r\n')).toBe(true);
    expect(body.includes('\r\n')).toBe(true);
    expect(body.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('AT-1: a body with trailing spaces and non-ASCII BMP characters is not changed', () => {
    const raw = H + '  é trailing  \n\n';
    expect(handbookBody(raw)).toBe(bodyOf(H) + '  é trailing  \n\n');
  });

  it('AT-1: missing frontmatter throws HandbookFormatError', () => {
    expect(() => handbookBody(bodyOf(H))).toThrow(HandbookFormatError);
  });

  it('AT-1: frontmatter that never closes throws HandbookFormatError', () => {
    const unclosed = H.split('\n')
      .filter((_, i) => i !== 3)
      .join('\n');
    expect(() => handbookBody(unclosed)).toThrow(HandbookFormatError);
  });

  it('AT-1: only an exact --- line closes the frontmatter', () => {
    for (const bad of ['----', '--- ', '---x']) {
      const raw = H.replace('---\n# Synthetic', `${bad}\n# Synthetic`);
      expect(raw, bad).not.toBe(H);
      expect(() => handbookBody(raw), bad).toThrow(HandbookFormatError);
    }
  });

  it('AT-1: a character outside the Basic Multilingual Plane in the body throws HandbookFormatError', () => {
    expect(() => handbookBody(H + '\u{1F600}')).toThrow(HandbookFormatError);
  });
});

describe('policy-qa AT-2: handbookSections', () => {
  const B = handbookBody(H);

  it('AT-2: returns HB-1.1, HB-1.2 and HB-2.1 in order with exact offsets', () => {
    const sections = handbookSections(B);
    expect(sections.map((s) => s.id)).toEqual(['HB-1.1', 'HB-1.2', 'HB-2.1']);
    for (const s of sections) expect(HandbookSection.safeParse(s).success).toBe(true);

    const [s11, s12, s21] = sections;
    const start11 = B.indexOf('### HB-1.1');
    const start12 = B.indexOf('### HB-1.2');
    const start21 = B.indexOf('### HB-2.1');
    expect(s11?.start).toBe(start11);
    expect(s12?.start).toBe(start12);
    expect(s21?.start).toBe(start21);
    expect(B[start11]).toBe('#');
    expect(s11?.headingEnd).toBe(B.indexOf('\n', start11) + 1);
    expect(s12?.headingEnd).toBe(B.indexOf('\n', start12) + 1);
    expect(s21?.headingEnd).toBe(B.indexOf('\n', start21) + 1);
    expect(s11?.end).toBe(start12);
    expect(s12?.end).toBe(B.indexOf('## HB-2 Expenses'));
    expect(s21?.end).toBe(B.length);
  });

  it('AT-2: text between a chapter heading and its first section belongs to no section', () => {
    const sections = handbookSections(B);
    const intro = B.indexOf('This chapter covers leave.');
    expect(sections.some((s) => intro >= s.headingEnd && intro < s.end)).toBe(false);
  });

  it('AT-2: a #### line stays inside the current section', () => {
    const withSub = B.replace(
      'Employees get 20 days of annual leave.',
      '#### Note\nEmployees get 20 days of annual leave.',
    );
    expect(withSub).not.toBe(B);
    const sections = handbookSections(withSub);
    expect(sections.map((s) => s.id)).toEqual(['HB-1.1', 'HB-1.2', 'HB-2.1']);
    expect(sections[0]?.end).toBe(withSub.indexOf('### HB-1.2'));
  });

  it('AT-2: a duplicate section id throws HandbookFormatError', () => {
    const dup = B.replace('### HB-1.2 Sick leave', '### HB-1.1 Sick leave');
    expect(() => handbookSections(dup)).toThrow(HandbookFormatError);
  });

  it('AT-2: a body with no ### section heading throws HandbookFormatError', () => {
    const none = B.replace(/^### /gm, '## ');
    expect(none).not.toContain('### ');
    expect(() => handbookSections(none)).toThrow(HandbookFormatError);
  });
});
