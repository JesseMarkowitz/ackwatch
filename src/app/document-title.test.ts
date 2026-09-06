import { describe, expect, it } from 'vitest';

import { BASE_DOCUMENT_TITLE, documentTitleFor } from './document-title';

describe('documentTitleFor', () => {
  it('leads with the count so a narrow tab still shows it', () => {
    expect(documentTitleFor(3)).toBe('(3) AckWatch');
    expect(documentTitleFor(1)).toBe('(1) AckWatch');
  });

  it('says nothing when nothing needs attention', () => {
    // A permanent "(0)" would be a badge that never goes out, which is the same as no badge.
    expect(documentTitleFor(0)).toBe(BASE_DOCUMENT_TITLE);
    expect(documentTitleFor(-1)).toBe(BASE_DOCUMENT_TITLE);
  });
});
