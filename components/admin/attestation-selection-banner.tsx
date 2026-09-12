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
    <div className="rounded-xl border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-4 py-2 text-sm">
      <button
        type="button"
        disabled={selectingAll}
        onClick={onSelectAllFiltered}
        className="min-h-9 font-medium text-[var(--color-primary)] underline hover:no-underline disabled:opacity-50"
      >
        {selectingAll ? 'Выбираем…' : `Выбрать все ${totalFiltered} по фильтру`}
      </button>
    </div>
  );
}
