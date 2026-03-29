import { useCallback, useEffect, useRef, useState } from 'react'
import apiClient from '../lib/apiClient'
import type { IonQueueItem } from '../lib/types'

const BATCH_SIZE = 20
const PREFETCH_AHEAD = 5

interface UseAnnotationQueueOptions {
  datasetId: string
  strategy?: 'unannotated_first' | 'starred_first' | 'all'
  labelFilter?: string | null
}

export function useAnnotationQueue({ datasetId, strategy = 'unannotated_first', labelFilter = null }: UseAnnotationQueueOptions) {
  const [queue, setQueue] = useState<IonQueueItem[]>([])
  // Cursor: sort_order of the last item fetched. -1 means "fetch from beginning".
  // Cursor-based pagination ensures we never skip ions that get annotated mid-session
  // (offset-based pagination would shift the window as annotated ions disappear from
  // the filtered result set, causing gaps).
  const [cursor, setCursor] = useState(-1)
  const [exhausted, setExhausted] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const prefetchingRef = useRef(false)
  // Prevents prefetch effect from firing before the initial batch completes
  const initializedRef = useRef(false)

  const forceReload = useCallback(() => setReloadKey((k) => k + 1), [])

  const fetchBatch = useCallback(async (afterSortOrder: number): Promise<IonQueueItem[]> => {
    const params: Record<string, unknown> = { limit: BATCH_SIZE, strategy, after_sort_order: afterSortOrder }
    if (labelFilter) params.label_filter = labelFilter
    const { data } = await apiClient.get<IonQueueItem[]>(
      `/api/datasets/${datasetId}/ions/queue`,
      { params }
    )
    return data
  }, [datasetId, strategy, labelFilter])

  // Initial load
  useEffect(() => {
    initializedRef.current = false
    setQueue([])
    setCursor(-1)
    setExhausted(false)
    fetchBatch(-1).then((items) => {
      setQueue(items)
      if (items.length > 0) setCursor(items[items.length - 1].sort_order)
      if (items.length < BATCH_SIZE) setExhausted(true)
      items.forEach((item) => {
        prefetchImage(item.image_url)
        if (item.tic_image_url) prefetchImage(item.tic_image_url)
      })
      initializedRef.current = true
    })
  }, [datasetId, strategy, labelFilter, reloadKey])

  // Prefetch next batch when queue gets low
  useEffect(() => {
    if (!initializedRef.current) return
    if (queue.length <= PREFETCH_AHEAD && !exhausted && !prefetchingRef.current) {
      prefetchingRef.current = true
      fetchBatch(cursor).then((items) => {
        setQueue((prev) => [...prev, ...items])
        if (items.length > 0) setCursor(items[items.length - 1].sort_order)
        if (items.length < BATCH_SIZE) setExhausted(true)
        items.forEach((item) => {
          prefetchImage(item.image_url)
          if (item.tic_image_url) prefetchImage(item.tic_image_url)
        })
        prefetchingRef.current = false
      })
    }
  }, [queue.length, exhausted, cursor, fetchBatch])

  const current = queue[0] ?? null
  const remaining = queue.length

  const advance = useCallback(() => {
    setQueue((prev) => prev.slice(1))
  }, [])

  const prependItem = useCallback((item: IonQueueItem) => {
    setQueue((prev) => [item, ...prev])
  }, [])

  const updateCurrent = useCallback((updater: (item: IonQueueItem) => IonQueueItem) => {
    setQueue((prev) => {
      if (prev.length === 0) return prev
      return [updater(prev[0]), ...prev.slice(1)]
    })
  }, [])

  return { current, remaining, advance, updateCurrent, exhausted, forceReload, prependItem }
}

function prefetchImage(url: string) {
  const img = new Image()
  img.src = url
}

