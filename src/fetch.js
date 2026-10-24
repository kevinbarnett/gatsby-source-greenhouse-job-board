const baseUrl = `https://boards-api.greenhouse.io/v1/boards`

const defaultOptions = {
  // Give up on a request that has not finished after this many milliseconds
  timeout: 30000,
  // Retry network errors, timeouts, rate limiting (429) and server errors (5xx)
  retries: 3,
  // Wait 1s, 2s, 4s, ... between retries, unless the API sends Retry-After
  retryDelay: 1000,
  // Never wait longer than this between retries, whatever Retry-After says
  maxRetryDelay: 30000,
  // Job details are one request per job, so limit how many run at once. With 100, boards with
  // about 900 jobs download as fast as with every request at once, like earlier versions did.
  concurrency: 100,
  // Greenhouse's firewall blocks an IP address for about a minute once that address sends a few
  // thousand requests in a minute. When measured, 3,244 in a minute got through, and the block began at
  // about 7,200. So never send more than this many in any minute, with room to spare. Only builds
  // that fetch more than about 2,000 jobs, across all their boards, ever wait. Sites can change it
  // with the plugin option of the same name.
  requestsPerMinute: 2000,
}

// Options given as undefined keep their defaults, so that options a site did not set can be
// passed along as they are
const withDefaults = options => {
  const merged = { ...defaultOptions }
  for (const [name, value] of Object.entries(options || {})) {
    if (value !== undefined) {
      merged[name] = value
    }
  }
  return merged
}

class HTTPError extends Error {
  constructor(url, status) {
    super(`Request to ${url} failed with HTTP status ${status}`)
    this.name = `HTTPError`
    this.status = status
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const minute = 60000

// When each request of the last minute was sent, oldest first. Every board in the build shares
// it, since Greenhouse counts all requests from the same IP address.
const sentInLastMinute = []

// Counts a request about to be sent and returns 0 if that keeps the requests of the last minute
// within `limit`. Otherwise counts nothing and returns how many milliseconds to wait first.
function reserveRequest(limit) {
  // performance.now() only moves forward, unlike the system clock
  const now = performance.now()
  while (sentInLastMinute.length > 0 && sentInLastMinute[0] <= now - minute) {
    sentInLastMinute.shift()
  }
  if (sentInLastMinute.length < limit) {
    sentInLastMinute.push(now)
    return 0
  }
  return sentInLastMinute[0] + minute - now
}

const isRetryableStatus = status => status === 429 || status >= 500

// Retry-After is either a number of seconds or an HTTP date
const getRetryAfter = response => {
  const value = response.headers.get(`retry-after`)
  if (!value) {
    return undefined
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000)
  }
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

const describeFailure = (error, timeout) => {
  if (error.name === `TimeoutError`) {
    return `timed out after ${timeout}ms`
  }
  // fetch() reports network errors as "fetch failed" and puts the reason in `cause`
  const cause = error.cause && (error.cause.code || error.cause.message)
  return `failed: ${error.message}${cause ? ` (${cause})` : ``}`
}

// Helper function to handle fetch requests with timeouts, retries and proper error handling
async function fetchJSON(url, options) {
  const { timeout, retries, retryDelay, maxRetryDelay, requestsPerMinute } = withDefaults(options)

  for (let attempt = 0; ; attempt++) {
    const backoff = retryDelay * 2 ** attempt
    let response

    // Retries count too, since the firewall sees every request. The request is sent right after
    // it is counted, with nothing in between that could make it later. The timeout starts then.
    let wait
    while ((wait = reserveRequest(requestsPerMinute)) > 0) {
      await sleep(wait)
    }

    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeout) })

      if (response.ok) {
        return await response.json()
      }
    } catch (error) {
      if (attempt < retries) {
        await sleep(Math.min(backoff, maxRetryDelay))
        continue
      }
      throw new Error(`Request to ${url} ${describeFailure(error, timeout)}`)
    }

    // Release the connection, since the error body is not needed. Not awaited, so that
    // cleaning up can never hold up the build.
    response.body?.cancel().catch(() => {})

    if (attempt < retries && isRetryableStatus(response.status)) {
      await sleep(Math.min(getRetryAfter(response) ?? backoff, maxRetryDelay))
      continue
    }
    throw new HTTPError(url, response.status)
  }
}

// Like Promise.all(items.map(fn)), but with at most `limit` calls of fn running at once
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  let failed = false

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index])
      } catch (error) {
        // stop starting new work once anything fails
        failed = true
        throw error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const boardUrl = boardToken => `${baseUrl}/${encodeURIComponent(boardToken)}`

async function fetchJobs(boardToken, { onMissingJob, ...options } = {}) {
  const { concurrency } = withDefaults(options)
  const url = `${boardUrl(boardToken)}/jobs/`

  let jobs
  try {
    const data = await fetchJSON(url, options)
    jobs = data.jobs || []
  } catch (error) {
    throw new Error(`Failed to fetch jobs from Greenhouse API: ${error.message}`)
  }

  const jobDetails = await mapWithConcurrency(jobs, concurrency, async job => {
    try {
      return await fetchJSON(`${url}${encodeURIComponent(job.id)}?questions=true`, options)
    } catch (error) {
      // A job can be closed between listing the jobs and fetching its details
      if (error.status === 404) {
        if (onMissingJob) {
          onMissingJob(job)
        }
        return null
      }
      throw new Error(`Failed to fetch details of job ${job.id} from Greenhouse API: ${error.message}`)
    }
  })

  return jobDetails.filter(Boolean)
}

async function fetchOffices(boardToken, options) {
  try {
    const data = await fetchJSON(`${boardUrl(boardToken)}/offices/`, options)
    return data.offices || []
  } catch (error) {
    throw new Error(`Failed to fetch offices from Greenhouse API: ${error.message}`)
  }
}

async function fetchDepartments(boardToken, options) {
  try {
    const data = await fetchJSON(`${boardUrl(boardToken)}/departments/`, options)
    return data.departments || []
  } catch (error) {
    throw new Error(`Failed to fetch departments from Greenhouse API: ${error.message}`)
  }
}

module.exports = { fetchJobs, fetchOffices, fetchDepartments }
