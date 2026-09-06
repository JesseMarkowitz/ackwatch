/**
 * The browser tab as a coverage surface.
 *
 * The product's whole premise is not missing things, and the tab is where an operator looking
 * elsewhere would notice. The count is *needs attention* only: open work has been seen and
 * acknowledged, so counting it would make the number stop meaning "unlooked at".
 *
 * It reads the same whether or not the tab is focused. A count that vanished on focus would be
 * one more thing to reason about, and the tab you are already looking at is the one place the
 * number costs nothing.
 */
export const BASE_DOCUMENT_TITLE = 'AckWatch';

export function documentTitleFor(needingAttention: number): string {
  if (needingAttention <= 0) return BASE_DOCUMENT_TITLE;
  // Leading, so it survives the truncation a browser applies to a narrow tab.
  return `(${needingAttention}) ${BASE_DOCUMENT_TITLE}`;
}
