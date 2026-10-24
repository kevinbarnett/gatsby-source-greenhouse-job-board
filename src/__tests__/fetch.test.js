const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const { loadFresh, loadWithMockClock, run } = require('./mock-clock')

let fetchJobs, fetchOffices, fetchDepartments
beforeEach(() => {
  ({ fetchJobs, fetchOffices, fetchDepartments } = loadFresh('../fetch'))
})

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

describe('options', () => {
  test('reject an option that is not a whole number within range, before sending any request', async t => {
    const requests = mockFetch(t, {})
    const errors = []
    for (const [name, value] of [
      ['concurrency', 0],
      ['concurrency', null],
      ['requestsPerMinute', 0],
      ['requestsPerMinute', NaN],
      ['requestsPerMinute', Infinity],
      ['timeout', 0],
      ['retries', -1],
      ['retryDelay', 1.5],
      ['maxRetryDelay', '50'],
    ]) {
      for (const fetchList of [fetchJobs, fetchOffices, fetchDepartments]) {
        await fetchList('acme', { [name]: value }).catch(error => errors.push(`${error.name}: ${error.message}`))
      }
    }
    assert.deepEqual(requests, [])
    assert.deepEqual(new Set(errors), new Set([
      'RangeError: The concurrency option must be a whole number of at least 1, not 0',
      'RangeError: The concurrency option must be a whole number of at least 1, not null',
      'RangeError: The requestsPerMinute option must be a whole number of at least 1, not 0',
      'RangeError: The requestsPerMinute option must be a whole number of at least 1, not NaN',
      'RangeError: The requestsPerMinute option must be a whole number of at least 1, not Infinity',
      'RangeError: The timeout option must be a whole number of at least 1, not 0',
      'RangeError: The retries option must be a whole number of at least 0, not -1',
      'RangeError: The retryDelay option must be a whole number of at least 0, not 1.5',
      "RangeError: The maxRetryDelay option must be a whole number of at least 0, not '50'",
    ]))
    assert.equal(errors.length, 27)
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

  test('retry when the connection fails while the body arrives', async t => {
    const requests = mockFetch(t, {
      [`${baseUrl}/acme/offices/`]: [
        () => new Response(new ReadableStream({ start: controller => controller.error(new TypeError('terminated')) })),
        json({ offices: [{ id: 1 }] }),
      ],
    })
    assert.deepEqual(await fetchOffices('acme', fast), [{ id: 1 }])
    assert.equal(requests.length, 2)
  })

  test('fail at once when a response is not JSON, since asking again gets the same answer', async t => {
    const requests = mockFetch(t, {
      [`${baseUrl}/acme/offices/`]: [new Response('<!DOCTYPE html><title>Access denied</title>')],
    })
    await assert.rejects(fetchOffices('acme', fast), {
      message: `Failed to fetch offices from Greenhouse API: Request to ${baseUrl}/acme/offices/ returned a body ` +
        `that is not JSON: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    })
    assert.equal(requests.length, 1)
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
          // Keep Node running, like the open connection of a real request would. The timer of
          // AbortSignal.timeout() does not, so Node 22 would otherwise end the test early.
          const connection = setInterval(() => {}, 1000)
          signal.addEventListener('abort', () => {
            clearInterval(connection)
            reject(signal.reason)
          })
        }),
      ],
    })
    await assert.rejects(fetchOffices('acme', { ...fast, timeout: 20, retries: 1 }), {
      message: `Failed to fetch offices from Greenhouse API: Request to ${baseUrl}/acme/offices/ timed out after 20ms. ` +
        'Set the `timeout` plugin option to wait longer.',
    })
  })

  // Replaces fetch with one that answers each request after the next of `delays` milliseconds, unless
  // the request is aborted first. Use with loadWithMockClock. AbortSignal.timeout() has a timer of
  // its own, which t.mock.timers cannot mock, so it is replaced with one that uses the mocked clock.
  const mockSlowFetch = (t, delays) => {
    t.mock.method(AbortSignal, 'timeout', ms => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
      return controller.signal
    })
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(json({ offices: [{ id: 1 }] })), delays.shift())
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      })
    }))
  }

  test('wait up to 90 seconds by default, since Greenhouse can take a minute to send the offices of a big board', async t => {
    const { fetchOffices } = loadWithMockClock(t, '../fetch')
    mockSlowFetch(t, [89000, 91000])
    assert.deepEqual(await run(t, fetchOffices('acme', { retries: 0 })), [{ id: 1 }])
    await assert.rejects(run(t, fetchOffices('acme', { retries: 0 })), {
      message: `Failed to fetch offices from Greenhouse API: Request to ${baseUrl}/acme/offices/ timed out after 90000ms. ` +
        'Set the `timeout` plugin option to wait longer.',
    })
  })

  test('keep the default when `timeout` is given as undefined', async t => {
    const { fetchOffices } = loadWithMockClock(t, '../fetch')
    mockSlowFetch(t, [89000, 91000])
    assert.deepEqual(await run(t, fetchOffices('acme', { retries: 0, timeout: undefined })), [{ id: 1 }])
    await assert.rejects(run(t, fetchOffices('acme', { retries: 0, timeout: undefined })), /timed out after 90000ms/)
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

  test('skip up to half of the jobs when their details are gone, and report them in the order of the listing', async t => {
    routes[jobsUrl] = [json({ jobs: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] })]
    routes[`${jobsUrl}4?questions=true`] = [json({}, { status: 404 })]
    // job 1 is found to be missing after job 4
    routes[`${jobsUrl}1?questions=true`] = [async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return json({}, { status: 404 })
    }]
    mockFetch(t, routes)
    const missing = []
    const jobs = await fetchJobs('acme', { ...fast, onMissingJob: job => missing.push(job.id) })
    assert.deepEqual(jobs.map(job => job.id), [2, 3])
    assert.deepEqual(missing, [1, 4])
  })

  test('fail when the details of more than half of the jobs are gone, since Greenhouse is likely failing', async t => {
    routes[`${jobsUrl}1?questions=true`] = [json({}, { status: 404 })]
    routes[`${jobsUrl}3?questions=true`] = [json({}, { status: 404 })]
    mockFetch(t, routes)
    const missing = []
    await assert.rejects(fetchJobs('acme', { ...fast, onMissingJob: job => missing.push(job.id) }), {
      message: 'Failed to fetch jobs from Greenhouse API: Greenhouse has no details for 2 of the 3 jobs it listed',
    })
    assert.deepEqual(missing, [])
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

describe('requests per minute', () => {
  const jobsUrl = `${baseUrl}/acme/jobs/`

  // Replaces fetch with one that answers with `respond(url)`, and returns when each request was sent
  const mockFetchTimes = (t, respond) => {
    const times = []
    t.mock.method(globalThis, 'fetch', async url => {
      times.push(Date.now())
      return respond(url)
    })
    return times
  }

  // Answers like a board with `count` jobs
  const board = count => url => url === jobsUrl
    ? json({ jobs: Array.from({ length: count }, (_, i) => ({ id: i + 1 })) })
    : json({ id: Number(url.slice(jobsUrl.length, url.indexOf('?'))) })

  test('send at most `requestsPerMinute` requests in any minute, and wait to send the rest', async t => {
    const { fetchJobs } = loadWithMockClock(t, '../fetch')
    const times = mockFetchTimes(t, board(7))
    const jobs = await run(t, fetchJobs('acme', { ...fast, requestsPerMinute: 3 }))
    assert.deepEqual(jobs.map(job => job.id), [1, 2, 3, 4, 5, 6, 7])
    // the job listing, then the details of each job
    assert.deepEqual(times, [0, 0, 0, 60000, 60000, 60000, 120000, 120000])
  })

  test('free up the slot of each request one minute after it was sent', async t => {
    const { fetchOffices } = loadWithMockClock(t, '../fetch')
    const times = mockFetchTimes(t, () => json({}))
    const options = { ...fast, requestsPerMinute: 2 }
    await run(t, fetchOffices('acme', options))
    t.mock.timers.tick(30000)
    await run(t, Promise.all([1, 2, 3].map(() => fetchOffices('acme', options))))
    assert.deepEqual(times, [0, 30000, 60000, 90000])
  })

  test('count the requests for every board together, since Greenhouse counts them per IP address', async t => {
    const { fetchOffices, fetchDepartments } = loadWithMockClock(t, '../fetch')
    const times = mockFetchTimes(t, () => json({}))
    const options = { ...fast, requestsPerMinute: 1 }
    await run(t, Promise.all([fetchOffices('acme', options), fetchDepartments('other', options)]))
    assert.deepEqual(times, [0, 60000])
  })

  test('send waiting requests in the order they asked, waking up only when one can go', async t => {
    const { fetchJobs } = loadWithMockClock(t, '../fetch')
    const times = mockFetchTimes(t, board(9))
    await run(t, fetchJobs('acme', { ...fast, requestsPerMinute: 2 }))
    assert.deepEqual(
      globalThis.fetch.mock.calls.map(call => call.arguments[0]),
      [jobsUrl, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(id => `${jobsUrl}${id}?questions=true`)]
    )
    assert.deepEqual(times, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4].map(minutes => minutes * 60000))
    // the clock is read when a request asks to go while none is waiting, and when the oldest
    // request stops counting, rather than each time any waiting request wakes up
    assert.ok(performance.now.mock.callCount() <= times.length, `read the clock ${performance.now.mock.callCount()} times`)
  })

  test('count retries too', async t => {
    const { fetchOffices } = loadWithMockClock(t, '../fetch')
    const responses = [json({}, { status: 503 }), json({ offices: [{ id: 1 }] })]
    const times = mockFetchTimes(t, () => responses.shift())
    assert.deepEqual(await run(t, fetchOffices('acme', { ...fast, requestsPerMinute: 1 })), [{ id: 1 }])
    assert.deepEqual(times, [0, 60000])
  })

  test('send up to 2,000 requests a minute by default, well below what Greenhouse blocks', async t => {
    const { fetchJobs } = loadWithMockClock(t, '../fetch')
    const times = mockFetchTimes(t, board(2100))
    const jobs = await run(t, fetchJobs('acme', fast))
    assert.equal(jobs.length, 2100)
    assert.deepEqual(times, [...Array(2000).fill(0), ...Array(101).fill(60000)])
  })

  test('keep the default when `requestsPerMinute` is given as undefined', async t => {
    const { fetchJobs } = loadWithMockClock(t, '../fetch')
    const times = mockFetchTimes(t, board(2000))
    await run(t, fetchJobs('acme', { ...fast, requestsPerMinute: undefined }))
    assert.deepEqual(times, [...Array(2000).fill(0), 60000])
  })
})
