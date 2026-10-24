const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const { fetchJobs, fetchOffices, fetchDepartments } = require('../fetch')

const baseUrl = 'https://boards-api.greenhouse.io/v1/boards'

// Small delays so retries do not slow the tests down
const fast = { retryDelay: 1, maxRetryDelay: 50, timeout: 1000 }

const json = (body, init) => new Response(JSON.stringify(body), init)

// Replaces fetch with one that answers from `routes`, a map from URL to a list of responses
// (or functions returning one) that are used up in order. Returns the URLs that were requested.
const mockFetch = (t, routes) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(url)
    const responses = routes[url]
    assert.ok(responses && responses.length, `unexpected request to ${url}`)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(init) : next.clone()
  })
  return requests
}

describe('fetchOffices and fetchDepartments', () => {
  test('return the list from the API', async t => {
    mockFetch(t, {
      [`${baseUrl}/acme/offices/`]: [json({ offices: [{ id: 1 }] })],
      [`${baseUrl}/acme/departments/`]: [json({ departments: [{ id: 2 }] })],
    })
    assert.deepEqual(await fetchOffices('acme', fast), [{ id: 1 }])
    assert.deepEqual(await fetchDepartments('acme', fast), [{ id: 2 }])
  })

  test('return an empty list when the API leaves it out', async t => {
    mockFetch(t, { [`${baseUrl}/acme/offices/`]: [json({})] })
    assert.deepEqual(await fetchOffices('acme', fast), [])
  })

  test('encode the board token, so it cannot change the request path', async t => {
    const requests = mockFetch(t, {
      [`${baseUrl}/..%2Fother%3Fx%3D1/offices/`]: [json({ offices: [] })],
    })
    await fetchOffices('../other?x=1', fast)
    assert.deepEqual(requests, [`${baseUrl}/..%2Fother%3Fx%3D1/offices/`])
  })
})

describe('retries', () => {
  test('retry server errors and rate limiting until a request succeeds', async t => {
    const requests = mockFetch(t, {
      [`${baseUrl}/acme/offices/`]: [
        json({}, { status: 503 }),
        json({}, { status: 429 }),
        json({ offices: [{ id: 1 }] }),
      ],
    })
    assert.deepEqual(await fetchOffices('acme', fast), [{ id: 1 }])
    assert.equal(requests.length, 3)
  })

  test('retry network errors', async t => {
    const requests = mockFetch(t, {
      [`${baseUrl}/acme/offices/`]: [
        () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })),
        json({ offices: [] }),
      ],
    })
    assert.deepEqual(await fetchOffices('acme', fast), [])
    assert.equal(requests.length, 2)
  })

  test('give up after the last retry and name the URL and status', async t => {
    const requests = mockFetch(t, { [`${baseUrl}/acme/offices/`]: [json({}, { status: 500 })] })
    await assert.rejects(fetchOffices('acme', { ...fast, retries: 2 }), {
      message: `Failed to fetch offices from Greenhouse API: Request to ${baseUrl}/acme/offices/ failed with HTTP status 500`,
    })
    assert.equal(requests.length, 3)
  })

  test('do not retry client errors', async t => {
    const requests = mockFetch(t, { [`${baseUrl}/missing/offices/`]: [json({}, { status: 404 })] })
    await assert.rejects(fetchOffices('missing', fast), /failed with HTTP status 404/)
    assert.equal(requests.length, 1)
  })

  test('report the cause of a network error', async t => {
    mockFetch(t, {
      [`${baseUrl}/acme/offices/`]: [
        () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
      ],
    })
    await assert.rejects(fetchOffices('acme', { ...fast, retries: 0 }), {
      message: `Failed to fetch offices from Greenhouse API: Request to ${baseUrl}/acme/offices/ failed: fetch failed (ENOTFOUND)`,
    })
  })

  test('wait as long as Retry-After asks, up to maxRetryDelay', async t => {
    for (const retryAfter of ['1', new Date(Date.now() + 60000).toUTCString()]) {
      mockFetch(t, {
        [`${baseUrl}/acme/offices/`]: [
          json({}, { status: 429, headers: { 'Retry-After': retryAfter } }),
          json({ offices: [] }),
        ],
      })
      const start = performance.now()
      await fetchOffices('acme', fast)
      const waited = performance.now() - start
      // the backoff alone would be 1ms, and Retry-After alone at least a second
      assert.ok(waited >= 45 && waited < 900, `waited ${waited}ms for Retry-After: ${retryAfter}`)
      t.mock.restoreAll()
    }
  })
})

describe('timeouts', () => {
  test('abort a request that takes longer than the timeout', async t => {
    mockFetch(t, {
      [`${baseUrl}/acme/offices/`]: [
        ({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
      ],
    })
    await assert.rejects(fetchOffices('acme', { ...fast, timeout: 20, retries: 1 }), {
      message: `Failed to fetch offices from Greenhouse API: Request to ${baseUrl}/acme/offices/ timed out after 20ms`,
    })
  })
})

describe('fetchJobs', () => {
  const jobsUrl = `${baseUrl}/acme/jobs/`
  let routes

  beforeEach(() => {
    routes = {
      [jobsUrl]: [json({ jobs: [{ id: 1 }, { id: 2 }, { id: 3 }] })],
      [`${jobsUrl}1?questions=true`]: [json({ id: 1, title: 'One' })],
      [`${jobsUrl}2?questions=true`]: [json({ id: 2, title: 'Two' })],
      [`${jobsUrl}3?questions=true`]: [json({ id: 3, title: 'Three' })],
    }
  })

  test('fetch the details of every job, in the order of the listing', async t => {
    mockFetch(t, routes)
    assert.deepEqual(await fetchJobs('acme', fast), [
      { id: 1, title: 'One' },
      { id: 2, title: 'Two' },
      { id: 3, title: 'Three' },
    ])
  })

  test('skip a job whose details are gone, and report it', async t => {
    routes[`${jobsUrl}2?questions=true`] = [json({}, { status: 404 })]
    mockFetch(t, routes)
    const missing = []
    const jobs = await fetchJobs('acme', { ...fast, onMissingJob: job => missing.push(job) })
    assert.deepEqual(jobs.map(job => job.id), [1, 3])
    assert.deepEqual(missing, [{ id: 2 }])
  })

  test('fail with the job id when its details cannot be fetched', async t => {
    routes[`${jobsUrl}2?questions=true`] = [json({}, { status: 500 })]
    mockFetch(t, routes)
    await assert.rejects(fetchJobs('acme', { ...fast, retries: 0 }), {
      message: `Failed to fetch details of job 2 from Greenhouse API: Request to ${jobsUrl}2?questions=true failed with HTTP status 500`,
    })
  })

  test('fail when the job listing cannot be fetched', async t => {
    routes[jobsUrl] = [json({}, { status: 404 })]
    mockFetch(t, routes)
    await assert.rejects(fetchJobs('acme', fast), /^Error: Failed to fetch jobs from Greenhouse API: .* 404$/)
  })

  test('encode the job id', async t => {
    routes[jobsUrl] = [json({ jobs: [{ id: '1/../../x' }] })]
    routes[`${jobsUrl}1%2F..%2F..%2Fx?questions=true`] = [json({ id: 1 })]
    const requests = mockFetch(t, routes)
    await fetchJobs('acme', fast)
    assert.equal(requests[1], `${jobsUrl}1%2F..%2F..%2Fx?questions=true`)
  })

  // Serves `count` jobs whose details each take a moment, and returns how many were fetched at once
  const mockSlowJobs = (t, count) => {
    const ids = Array.from({ length: count }, (_, i) => i + 1)
    const stats = { ids, running: 0, mostRunning: 0 }
    routes = { [jobsUrl]: [json({ jobs: ids.map(id => ({ id })) })] }
    for (const id of ids) {
      routes[`${jobsUrl}${id}?questions=true`] = [async () => {
        stats.running++
        stats.mostRunning = Math.max(stats.mostRunning, stats.running)
        await new Promise(resolve => setTimeout(resolve, 5))
        stats.running--
        return json({ id })
      }]
    }
    mockFetch(t, routes)
    return stats
  }

  test('fetch at most `concurrency` job details at once', async t => {
    const stats = mockSlowJobs(t, 7)
    const jobs = await fetchJobs('acme', { ...fast, concurrency: 3 })
    assert.deepEqual(jobs.map(job => job.id), stats.ids)
    assert.equal(stats.mostRunning, 3)
  })

  test('fetch up to 100 job details at once by default, so large boards are as fast as before', async t => {
    const stats = mockSlowJobs(t, 250)
    const jobs = await fetchJobs('acme', fast)
    assert.deepEqual(jobs.map(job => job.id), stats.ids)
    assert.equal(stats.mostRunning, 100)
  })
})
