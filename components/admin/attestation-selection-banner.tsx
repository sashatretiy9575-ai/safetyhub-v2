'use client';

type AttestationSelectionBannerProps = {
  selectedCount: number;
  totalFiltered: number;
  pageSize: number;
  isAllFilteredSelected: boolean;
  selectingAll: boolean;
  onSelectAllFiltered: () => void;
  onClearSelection: () => void;
};

export function AttestationSelectionBanner({
  selectedCount,
  totalFiltered,
  pageSize,
  isAllFilteredSelected,
  selectingAll,
  onSelectAllFiltered,
  onClearSelection,
}: AttestationSelectionBannerProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold tabular-nums">Выделено: {selectedCount}</span>
        {totalFiltered > pageSize && !isAllFilteredSelected ? (
          <>
            <span className="text-[var(--color-text-subtle)]">·</span>
            <button
              type="button"
              disabled={selectingAll}
              onClick={onSelectAllFiltered}
              className="font-medium text-[var(--color-primary)] underline hover:no-underline disabled:opacity-50"
            >
              {selectingAll ? 'Выбираем…' : `Выбрать все ${totalFiltered} по фильтру`}
            </button>
          </>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClearSelection}
        className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline"
      >
        Снять
      </button>
    </div>
  );
}
