import { useMemo, useState } from 'react'
import type { LibraryFilterDataStatus } from '../hooks/useLibraryFilterData'
import { useTypeSafeTranslations } from '../hooks/useTypeSafeTranslations'
import { buildFilter, parseFilter, PROGRESS_FILTER_VALUES, type FilterGroup } from '../lib/filterUtils'
import { FILTER_GROUP_LABEL_KEYS, LIBRARY_SORT_OPTIONS, PROGRESS_LABEL_KEYS, type LibraryQuery } from '../lib/libraryQuery'
import type { AbsFilterData } from '../types/abs'
import type { TypeSafeTranslations } from '../types/translations'
import BottomSheet from './BottomSheet'
import SelectField from './SelectField'
import Btn from './ui/Btn'
import ToggleSwitch from './ui/ToggleSwitch'

interface FilterOption {
  /** What goes into the filter string: a name, or an entity id for authors/series. */
  value: string
  /** What the user reads. */
  label: string
  /** Set for id-keyed groups so the list chip can show the name without `/filterdata`. */
  entityName?: string
}

interface FilterGroupOptions {
  group: FilterGroup
  options: FilterOption[]
}

const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })

/**
 * Turns `/filterdata` into the groups the sheet shows. Values are passed through untouched --
 * they are the server's filter keys, and the real data has near-duplicates (`Expanse` vs
 * `The Expanse`, `eng` vs `English`) and comma-joined multi-genres that must round-trip exactly.
 * Only the display ORDER is changed (alphabetical, to make a 20-item list scannable). Groups with
 * no options are dropped rather than shown as dead menus (a real library has an empty `tags`).
 */
function buildFilterGroups(filterData: AbsFilterData | null, t: TypeSafeTranslations): FilterGroupOptions[] {
  const strings = (values: string[] | undefined): FilterOption[] => (values ?? []).map((value) => ({ value, label: value })).sort(byLabel)
  const entities = (values: { id: string; name: string }[] | undefined): FilterOption[] =>
    (values ?? []).map((entity) => ({ value: entity.id, label: entity.name, entityName: entity.name })).sort(byLabel)

  const groups: FilterGroupOptions[] = [
    { group: 'genres', options: strings(filterData?.genres) },
    { group: 'authors', options: entities(filterData?.authors) },
    { group: 'series', options: entities(filterData?.series) },
    { group: 'narrators', options: strings(filterData?.narrators) },
    // Progress values are fixed by the server, so this group never depends on `/filterdata`.
    { group: 'progress', options: PROGRESS_FILTER_VALUES.map((value) => ({ value, label: t(PROGRESS_LABEL_KEYS[value]) })) },
    { group: 'publishers', options: strings(filterData?.publishers) },
    { group: 'languages', options: strings(filterData?.languages) },
    {
      group: 'publishedDecades',
      options: (filterData?.publishedDecades ?? []).map((value) => ({ value, label: t('LabelMobileDecade', { decade: value }) })).sort(byLabel)
    },
    { group: 'tags', options: strings(filterData?.tags) }
  ]
  return groups.filter((entry) => entry.options.length > 0)
}

interface LibraryFilterSheetProps {
  isOpen: boolean
  onClose: () => void
  query: LibraryQuery
  onChange: (next: LibraryQuery) => void
  filterData: AbsFilterData | null
  filterDataStatus: LibraryFilterDataStatus
  onRetryFilterData: () => void
}

/**
 * Filter/sort bottom sheet for the library list. Sort and the Downloaded toggle apply as you
 * touch them (the list behind updates live); picking a filter value applies it and closes the
 * sheet, since that is the end of the interaction. Only ONE filter can be active -- the server
 * takes a single `filter` param -- so choosing a value replaces any previous one.
 */
export default function LibraryFilterSheet({ isOpen, onClose, query, onChange, filterData, filterDataStatus, onRetryFilterData }: LibraryFilterSheetProps) {
  const t = useTypeSafeTranslations()
  const active = parseFilter(query.filter)
  const [expanded, setExpanded] = useState<FilterGroup | null>(null)
  const groups = useMemo(() => buildFilterGroups(filterData, t), [filterData, t])
  // Open on the group that holds the active filter so its selection is visible straight away.
  const openGroup = expanded ?? active?.group ?? null

  const selectFilter = (group: FilterGroup, option: FilterOption) => {
    const isSelected = active?.group === group && active.value === option.value
    // Tapping the selected value again clears it, so the sheet works without a separate "clear".
    onChange({ ...query, filter: isSelected ? null : buildFilter(group, option.value), label: isSelected ? null : (option.entityName ?? null) })
    onClose()
  }

  return (
    <BottomSheet isOpen={isOpen} title={t('LabelMobileFilterAndSort')} onClose={onClose}>
      <section className="mb-4">
        <SelectField
          id="library-sort"
          label={t('LabelSortBy')}
          value={query.sort}
          onChange={(event) => {
            const option = LIBRARY_SORT_OPTIONS.find((candidate) => candidate.key === event.target.value)
            if (option) onChange({ ...query, sort: option.key, desc: option.defaultDesc })
          }}
        >
          {LIBRARY_SORT_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {t(option.labelKey)}
            </option>
          ))}
        </SelectField>
        <div className="mt-1 flex gap-2">
          {[false, true].map((desc) => (
            <button
              key={String(desc)}
              type="button"
              aria-pressed={query.desc === desc}
              className={`${query.desc === desc ? 'bg-accent text-button-foreground border-accent' : 'bg-primary text-foreground border-border'} min-h-9 flex-1 rounded-md border px-3 text-sm`}
              onClick={() => onChange({ ...query, desc })}
            >
              {t(desc ? 'LabelSortDescending' : 'LabelSortAscending')}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-4">
        <ToggleSwitch value={query.downloaded} label={t('LabelMobileDownloadedOnly')} onChange={(downloaded) => onChange({ ...query, downloaded })} />
        {/* Not a server filter: say so, and say what it costs, rather than imply it behaves like the rest. */}
        <p className="text-foreground-subdued mt-1 text-xs leading-snug">{t('MessageMobileDownloadedOnlyHint')}</p>
      </section>

      <section>
        <h3 className="text-foreground-subdued mb-1 text-xs font-semibold tracking-wide uppercase">{t('LabelMobileFilter')}</h3>
        <p className="text-foreground-subdued mb-2 text-xs leading-snug">{t('MessageMobileOneFilterAtATime')}</p>
        <ul className="divide-border border-border divide-y rounded-md border">
          {groups.map(({ group, options }) => {
            const isOpenGroup = openGroup === group
            const hasActive = active?.group === group
            return (
              <li key={group}>
                <button
                  type="button"
                  className="text-foreground flex min-h-11 w-full items-center justify-between px-3 text-start text-sm"
                  aria-expanded={isOpenGroup}
                  onClick={() => setExpanded(isOpenGroup ? null : group)}
                >
                  <span className="flex items-center gap-2">
                    {t(FILTER_GROUP_LABEL_KEYS[group])}
                    {hasActive && <span className="bg-accent size-1.5 rounded-full" aria-hidden="true" />}
                  </span>
                  <span className="material-symbols text-foreground-subdued text-xl" aria-hidden="true">
                    {isOpenGroup ? 'expand_less' : 'expand_more'}
                  </span>
                </button>
                {isOpenGroup && (
                  <ul className="border-border max-h-60 overflow-y-auto border-t">
                    {options.map((option) => {
                      const selected = hasActive && active.value === option.value
                      return (
                        <li key={`${group}:${option.value}`}>
                          <button
                            type="button"
                            className="hover:bg-bg-hover text-foreground flex min-h-11 w-full items-center justify-between gap-2 px-3 text-start text-sm"
                            aria-pressed={selected}
                            onClick={() => selectFilter(group, option)}
                          >
                            <span className="min-w-0 break-words">{option.label}</span>
                            {selected && (
                              <span className="material-symbols text-accent text-xl" aria-hidden="true">
                                check
                              </span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>

        {filterDataStatus === 'loading' && (
          <p className="text-foreground-subdued mt-2 text-xs" role="status">
            {t('MessageMobileFilterOptionsLoading')}
          </p>
        )}
        {filterDataStatus === 'error' && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p role="alert" className="text-error text-xs">
              {t('MessageMobileFilterOptionsFailed')}
            </p>
            <Btn size="small" onClick={onRetryFilterData}>
              {t('ButtonRetry')}
            </Btn>
          </div>
        )}
        {/* `/filterdata` is cached server-side for ~30 minutes. */}
        {filterDataStatus === 'ready' && <p className="text-foreground-subdued mt-2 text-xs leading-snug">{t('MessageMobileFilterOptionsStale')}</p>}
      </section>
    </BottomSheet>
  )
}
