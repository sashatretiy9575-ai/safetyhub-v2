'use client';

type AttestationSelectionBannerProps = {
  selectedCount: number;
  totalFiltered: number;
  pageSize: number;
  isAllFilteredSelected: boolean;
  selectingAll: boolean;
  onSelectAllFiltered: () => void;
};

/**
 * Offers to extend a selection past the current page. The count and the
 * clear button belong to the selection panel right under it, so repeating
 * them here only said the same thing twice.
 */
export function AttestationSelectionBanner({
  selectedCount,
  totalFiltered,
  pageSize,
  isAllFilteredSelected,
  selectingAll,
  onSelectAllFiltered,
}: AttestationSelectionBannerProps) {
  if (selectedCount === 0 || isAllFilteredSelected || totalFiltered <= pageSize) return null;

  return (
    // No frame of its own: it sits inside the selection panel, which already
    // has the same border and tint, and a border inside a border reads as a
    // second panel.
    <button
      type="button"
      disabled={selectingAll}
      onClick={onSelectAllFiltered}
      className="block min-h-11 max-w-full text-left text-sm font-medium [overflow-wrap:anywhere] text-[var(--color-primary)] underline hover:no-underline disabled:opacity-50"
    >
      {selectingAll ? 'Выбираем…' : `Выбрать все ${totalFiltered} по фильтру`}
    </button>
  );
}
