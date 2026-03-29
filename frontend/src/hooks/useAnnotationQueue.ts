import { useCallback, useEffect, useRef, useState } from 'react'
import apiClient from '../lib/apiClient'
import type { IonQueueItem } from '../lib/types'

const BATCH_SIZE = 20
const PREFETCH_AHEAD = 5

interface UseAnnotationQueueOptions {
  datasetId: string
  strategy?: 'unannotated_first' | 'starred_first' | 'all'
}

export function useAnnotationQueue({ datasetId, strategy = 'unannotated_first' }: UseAnnotationQueueOptions) {
  const [queue, setQueue] = useState<IonQueueItem[]>([])
  const [offset, setOffset] = useState(0)
  const [exhausted, setExhausted] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const prefetchingRef = useRef(false)
  // Prevents prefetch effect from firing before the initial batch completes
  const initializedRef = useRef(false)

  const forceReload = useCallback(() => setReloadKey((k) => k + 1), [])

  const fetchBatch = useCallback(async (batchOffset: number): Promise<IonQueueItem[]> => {
    const { data } = await apiClient.get<IonQueueItem[]>(
      `/api/datasets/${datasetId}/ions/queue`,
      { params: { limit: BATCH_SIZE, strategy, offset: batchOffset } }
    )
    return data
  }, [datasetId, strategy])

  // Initial load
  useEffect(() => {
    initializedRef.current = false
    setQueue([])
    setOffset(0)
    setExhausted(false)
    fetchBatch(0).then((items) => {
      setQueue(items)
      setOffset(items.length)
      if (items.length < BATCH_SIZE) setExhausted(true)
      items.forEach((item) => prefetchImage(item.image_url))
      initializedRef.current = true
    })
  }, [datasetId, strategy, reloadKey])

  // Prefetch next batch when queue gets low
  useEffect(() => {
    if (!initializedRef.current) return
    if (queue.length <= PREFETCH_AHEAD && !exhausted && !prefetchingRef.current) {
      prefetchingRef.current = true
      fetchBatch(offset).then((items) => {
        setQueue((prev) => [...prev, ...items])
        setOffset((prev) => prev + items.length)
        if (items.length < BATCH_SIZE) setExhausted(true)
        items.forEach((item) => prefetchImage(item.image_url))
        prefetchingRef.current = false
      })
    }
  }, [queue.length, exhausted, offset, fetchBatch])

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

