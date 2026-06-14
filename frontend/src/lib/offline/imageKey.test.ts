import { describe, it, expect } from 'vitest'
import { imageCacheKey } from './imageKey'

describe('imageCacheKey', () => {
  it('drops the query so different presigned signatures map to one cache key', () => {
    const sig1 =
      'https://peakme-ions.s3.amazonaws.com/ions/abc.png?X-Amz-Signature=AAA&X-Amz-Expires=3600'
    const sig2 =
      'https://peakme-ions.s3.amazonaws.com/ions/abc.png?X-Amz-Signature=BBB&X-Amz-Expires=60'

    expect(imageCacheKey(sig1)).toBe('https://peakme-ions.s3.amazonaws.com/ions/abc.png')
    // Contract between the download writer and the SW reader: same object → same key.
    expect(imageCacheKey(sig1)).toBe(imageCacheKey(sig2))
  })

  it('is idempotent (applying it to its own output is a no-op)', () => {
    const url = 'https://x.s3.amazonaws.com/a/b/c.png?sig=1'
    const once = imageCacheKey(url)
    expect(imageCacheKey(once)).toBe(once)
  })

  it('preserves path-encoded characters', () => {
    const url = 'https://x.s3.amazonaws.com/ions/m%2Fz%20885.png?sig=1'
    expect(imageCacheKey(url)).toBe('https://x.s3.amazonaws.com/ions/m%2Fz%20885.png')
  })
})
