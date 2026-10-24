const { inspect } = require('node:util')

const baseUrl = `https://boards-api.greenhouse.io/v1/boards`

const defaultOptions = {
  // Give up on a request that has not finished after this many milliseconds. Greenhouse can take
  // about a minute to send the offices list of a big board when it has not sent it for a while:
  // Anduril's, 48.5 MB, took between 46 and 62 seconds when measured. So wait half as long again.
  // Sites can change it with the plugin option of the same name.
  timeout: 90000,
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

// The least each option can be. A concurrency of 0 would fetch no job details at all, and a limit of
// 0 requests per minute would let every request through without counting it.
const minimums = { timeout: 1, retries: 0, retryDelay: 0, maxRetryDelay: 0, concurrency: 1, requestsPerMinute: 1 }

// Options given as undefined keep their defaults, so that options a site did not set can be
// passed along as they are
const withDefaults = options => {
  const merged = { ...defaultOptions }
  for (const [name, value] of Object.entries(options || {})) {
    if (value !== undefined) {
      merged[name] = value
    }
  }
  for (const [name, minimum] of Object.entries(minimums)) {
    if (!Number.isInteger(merged[name]) || merged[name] < minimum) {
      throw new RangeError(`The ${name} option must be a whole number of at least ${minimum}, not ${inspect(merged[name])}`)
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

// When each request was sent, oldest first, of which those from `oldestInLastMinute` on were sent
// in the last minute. Every board in the build shares them, since Greenhouse counts all requests
// from the same IP address.
const sentTimes = []
let oldestInLastMinute = 0
// The requests waiting to be sent, in the order they asked, each with its requests per minute
const waiting = []
// Wakes the waiting requests once the oldest request of the last minute stops counting
let wakeUp

// Sends the waiting requests that keep the requests of the last minute within their limit, in the
// order they asked, and wakes up again once the next one can go
const sendWaitingRequests = () => {
  wakeUp = undefined
  // performance.now() only moves forward, unlike the system clock
  const now = performance.now()
  while (oldestInLastMinute < sentTimes.length && sentTimes[oldestInLastMinute] <= now - minute) {
    oldestInLastMinute++
  }
  // drop the times that no longer count once they are most of the list, which keeps dropping them
  // cheap however many requests the build sends
  if (oldestInLastMinute > sentTimes.length / 2) {
    sentTimes.splice(0, oldestInLastMinute)
    oldestInLastMinute = 0
  }
  while (waiting.length > 0 && sentTimes.length - oldestInLastMinute < waiting[0].limit) {
    sentTimes.push(now)
    waiting.shift().send()
  }
  if (waiting.length > 0) {
    wakeUp = setTimeout(sendWaitingRequests, Math.ceil(sentTimes[oldestInLastMinute] + minute - now))
  }
}

// Resolves once the request can be sent without sending more than `limit` requests in any minute,
// and counts it as sent then
const waitToSend = limit => new Promise(send => {
  waiting.push({ limit, send })
  // while a wake up is due, the requests that asked earlier have to go first
  if (!wakeUp) {
    sendWaitingRequests()
  }
})

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
    return `timed out after ${timeout}ms. Set the \`timeout\` plugin option to wait longer.`
  }
  // fetch() reports network errors as "fetch failed" and puts the reason in `cause`
  const cause = error.cause && (error.cause.code || error.cause.message)
  return `failed: ${error.message}${cause ? ` (${cause})` : ``}`
}

// Helper function to handle fetch requests with timeouts, retries and proper error handling.
// Takes the options with their defaults already filled in.
async function fetchJSON(url, { timeout, retries, retryDelay, maxRetryDelay, requestsPerMinute }) {
  for (let attempt = 0; ; attempt++) {
    const backoff = retryDelay * 2 ** attempt
    let response, body

    // Retries count too, since the firewall sees every request. The request is sent right after
    // it is counted, with nothing in between that could make it later. The timeout starts then.
    await waitToSend(requestsPerMinute)

    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeout) })

      if (response.ok) {
        // the connection can still fail or time out while the body arrives, which is worth a retry
        body = await response.text()
      }
    } catch (error) {
      if (attempt < retries) {
        await sleep(Math.min(backoff, maxRetryDelay))
        continue
      }
      throw new Error(`Request to ${url} ${describeFailure(error, timeout)}`)
    }

    if (response.ok) {
      try {
        return JSON.parse(body)
      } catch (error) {
        // Not retried, since asking again gets the same answer. Such a body usually comes from
        // something between the build and Greenhouse, such as the error page of a proxy.
        throw new Error(`Request to ${url} returned a body that is not JSON: ${error.message}`)
      }
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
  const settings = withDefaults(options)
  const url = `${boardUrl(boardToken)}/jobs/`

  let jobs
  try {
    const data = await fetchJSON(url, settings)
    jobs = data.jobs || []
  } catch (error) {
    throw new Error(`Failed to fetch jobs from Greenhouse API: ${error.message}`)
  }

  const jobDetails = await mapWithConcurrency(jobs, settings.concurrency, async job => {
    try {
      return await fetchJSON(`${url}${encodeURIComponent(job.id)}?questions=true`, settings)
    } catch (error) {
      // A job can be closed between listing the jobs and fetching its details
      if (error.status === 404) {
        return null
      }
      throw new Error(`Failed to fetch details of job ${job.id} from Greenhouse API: ${error.message}`)
    }
  })

  const missingJobs = jobs.filter((job, index) => !jobDetails[index])
  // A few jobs can close while the build fetches the others, but not most of them. When most are
  // gone, Greenhouse is more likely failing to serve them, and a build without them would replace
  // a careers page that lists them.
  if (missingJobs.length > jobs.length / 2) {
    throw new Error(
      `Failed to fetch jobs from Greenhouse API: ` +
      `Greenhouse has no details for ${missingJobs.length} of the ${jobs.length} jobs it listed`
    )
  }
  if (onMissingJob) {
    missingJobs.forEach(job => onMissingJob(job))
  }

  return jobDetails.filter(Boolean)
}

async function fetchOffices(boardToken, options) {
  const settings = withDefaults(options)
  try {
    const data = await fetchJSON(`${boardUrl(boardToken)}/offices/`, settings)
    return data.offices || []
  } catch (error) {
    throw new Error(`Failed to fetch offices from Greenhouse API: ${error.message}`)
  }
}

async function fetchDepartments(boardToken, options) {
  const settings = withDefaults(options)
  try {
    const data = await fetchJSON(`${boardUrl(boardToken)}/departments/`, settings)
    return data.departments || []
  } catch (error) {
    throw new Error(`Failed to fetch departments from Greenhouse API: ${error.message}`)
  }
}

module.exports = { fetchJobs, fetchOffices, fetchDepartments }
