const assert = require('node:assert/strict')

// Loads a fresh copy of `module`, so that requests sent by other tests do not count against the
// requests per minute, and no request of another test is still waiting to be sent
const loadFresh = module => {
  // gatsby-node.js keeps the copy of fetch.js it loaded, so load both afresh
  for (const name of ['../fetch', '../gatsby-node']) {
    delete require.cache[require.resolve(name)]
  }
  return require(module)
}

// Mocks the clock, so that it only moves when `run` moves it, and loads a fresh copy of `module`
const loadWithMockClock = (t, module) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  // t.mock.timers cannot mock performance.now(), so make it follow the mocked Date
  t.mock.method(performance, 'now', () => Date.now())
  return loadFresh(module)
}

// Awaits `promise`, moving the clock on to the waiting timers whenever nothing else can run
const run = async (t, promise) => {
  let settled = false
  promise.then(() => (settled = true), () => (settled = true))
  for (let turns = 0; !settled; turns++) {
    assert.ok(turns < 1000, 'the promise is still pending, with nothing left to run')
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.runAll()
  }
  return promise
}

module.exports = { loadFresh, loadWithMockClock, run }
