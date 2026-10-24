const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { stripVTControlCharacters } = require('node:util')
const { testPluginOptionsSchema } = require('gatsby-plugin-utils')

const { pluginOptionsSchema, createSchemaCustomization, sourceNodes } = require('../gatsby-node')
const { typeDefs } = require('../schema')
const { loadWithMockClock, run } = require('./mock-clock')

const boardUrl = 'https://boards-api.greenhouse.io/v1/boards/acme'

// Serves a board from the Greenhouse API, and returns when each request was sent. Jobs listed in
// `missingJobs` are in the job listing, but their details are gone.
const mockBoard = (t, { offices = [], departments = [], jobs = [], missingJobs = [] }) => {
  const routes = {
    [`${boardUrl}/offices/`]: { offices },
    [`${boardUrl}/departments/`]: { departments },
    [`${boardUrl}/jobs/`]: { jobs: jobs.map(({ id, title }) => ({ id, title })) },
  }
  for (const job of jobs) {
    routes[`${boardUrl}/jobs/${job.id}?questions=true`] = missingJobs.includes(job.id) ? 404 : job
  }
  const times = []
  t.mock.method(globalThis, 'fetch', async url => {
    times.push(Date.now())
    const route = routes[url]
    return typeof route === 'number' ? new Response('', { status: route }) : Response.json(route)
  })
  return times
}

// The parts of Gatsby that sourceNodes uses, with a node store that can be kept between builds
const fakeGatsby = (store = new Map()) => {
  const calls = []
  const logs = { info: [], warn: [], panic: [] }
  // like Gatsby, which adds the message of an error passed along to the message it logs
  const log = level => (message, error) =>
    logs[level].push(stripVTControlCharacters(error ? `${message} ${error.message}` : message))

  const deleteNode = node => {
    // like Gatsby, which cannot delete a node that is gone
    assert.ok(store.has(node.id), `deleteNode called for ${node.id}, which does not exist`)
    calls.push(['deleteNode', node.id])
    store.delete(node.id)
    // like Gatsby, which deletes the children of a node along with it
    for (const childId of node.children) {
      if (store.has(childId)) {
        deleteNode(store.get(childId))
      }
    }
  }

  return {
    store,
    calls,
    logs,
    args: {
      actions: {
        createNode: node => {
          calls.push(['createNode', node.id])
          store.set(node.id, node)
        },
        deleteNode,
      },
      createNodeId: key => key,
      createContentDigest: content => JSON.stringify(content),
      getNode: id => store.get(id),
      getNodesByType: type => [...store.values()].filter(node => node.internal.type === type),
      reporter: { info: log('info'), warn: log('warn'), panic: log('panic') },
    },
  }
}

const job = (id, departmentIds = []) => ({
  id,
  title: `Job ${id}`,
  departments: departmentIds.map(departmentId => ({ id: departmentId })),
  offices: [],
})

describe('pluginOptionsSchema', () => {
  test('require a board token', async () => {
    assert.equal((await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: 'acme' })).isValid, true)

    const { isValid, errors } = await testPluginOptionsSchema(pluginOptionsSchema, {})
    assert.equal(isValid, false)
    assert.deepEqual(errors, ['"boardToken" is required'])
  })

  test('accept a board token given as a number, which earlier versions used as it was', async () => {
    assert.equal((await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: 12345 })).isValid, true)

    const { isValid, errors } = await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: true })
    assert.equal(isValid, false)
    assert.deepEqual(errors, ['"boardToken" must be one of [string, number]'])
  })

  test('only warn about options it does not know, so existing configs keep working', async () => {
    const result = await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: 'acme', other: true })
    assert.equal(result.isValid, true)
    assert.equal(result.hasWarnings, true)
  })

  test('accept a whole number of requests per minute, of at least 1', async () => {
    for (const requestsPerMinute of [1, 500, 5000]) {
      const result = await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: 'acme', requestsPerMinute })
      assert.equal(result.isValid, true, `${requestsPerMinute}: ${result.errors}`)
      assert.equal(result.hasWarnings, false)
    }

    const errors = {}
    for (const requestsPerMinute of [0, -5, 1.5, 'fast', null, Infinity]) {
      const result = await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: 'acme', requestsPerMinute })
      errors[requestsPerMinute] = result.errors
    }
    assert.deepEqual(errors, {
      // 0 would let requests go out without being counted
      0: ['"requestsPerMinute" must be greater than or equal to 1'],
      [-5]: ['"requestsPerMinute" must be greater than or equal to 1'],
      1.5: ['"requestsPerMinute" must be an integer'],
      fast: ['"requestsPerMinute" must be a number'],
      null: ['"requestsPerMinute" must be a number'],
      Infinity: ['"requestsPerMinute" cannot be infinity'],
    })
  })
})

describe('createSchemaCustomization', () => {
  test('declare the Greenhouse types', () => {
    const types = []
    createSchemaCustomization({ actions: { createTypes: definitions => types.push(definitions) } })
    assert.deepEqual(types, [typeDefs])
  })
})

describe('sourceNodes', () => {
  test('create linked nodes, and log the counts without "No Office" and "No Department"', async t => {
    mockBoard(t, {
      offices: [{ id: 0, name: 'No Office', departments: [] }, { id: 10, departments: [{ id: 0, jobs: [{ id: 100 }] }] }],
      departments: [{ id: 0, name: 'No Department', jobs: [{ id: 100 }] }],
      jobs: [job(100)],
    })
    const gatsby = fakeGatsby()
    await sourceNodes(gatsby.args, { boardToken: 'acme' })

    assert.deepEqual(gatsby.calls, [
      ['createNode', 'GreenhouseOffice-10'],
      ['createNode', 'GreenhouseJob-100'],
    ])
    assert.deepEqual(gatsby.store.get('GreenhouseOffice-10').jobs___NODE, ['GreenhouseJob-100'])
    assert.ok(
      gatsby.logs.info.includes('Fetched from Greenhouse API:\n  1 jobs,\n  1 offices,\n  0 departments'),
      gatsby.logs.info.join('\n')
    )
  })

  test('delete changed and removed parents before creating any node', async t => {
    const gatsby = fakeGatsby()
    mockBoard(t, {
      departments: [
        // Greenhouse lists children both before and after their parents
        { id: 1, name: 'Engineering', parent_id: null, child_ids: [2], jobs: [] },
        { id: 2, parent_id: 1, child_ids: [3], jobs: [] },
        { id: 3, parent_id: 2, child_ids: [], jobs: [] },
        { id: 5, parent_id: 4, child_ids: [], jobs: [] },
        { id: 4, parent_id: null, child_ids: [5], jobs: [] },
        { id: 7, parent_id: 6, child_ids: [], jobs: [] },
        { id: 6, parent_id: null, child_ids: [7], jobs: [] },
      ],
    })
    await sourceNodes(gatsby.args, { boardToken: 'acme' })
    const cachedIds = [...gatsby.store.keys()]

    // the next build: 1 and its child 2 are renamed, 4 is removed and its child 5 moves to 1,
    // while 6 and 7 stay as they were
    t.mock.restoreAll()
    mockBoard(t, {
      departments: [
        { id: 2, name: 'Frontend', parent_id: 1, child_ids: [3], jobs: [] },
        { id: 3, parent_id: 2, child_ids: [], jobs: [] },
        { id: 5, parent_id: 1, child_ids: [], jobs: [] },
        { id: 1, name: 'Engineering & Product', parent_id: null, child_ids: [2, 5], jobs: [] },
        { id: 7, parent_id: 6, child_ids: [], jobs: [] },
        { id: 6, parent_id: null, child_ids: [7], jobs: [] },
      ],
    })
    const rebuild = fakeGatsby(gatsby.store)
    await sourceNodes(rebuild.args, { boardToken: 'acme' })

    const firstCreate = rebuild.calls.findIndex(([action]) => action === 'createNode')
    assert.deepEqual(rebuild.calls.slice(0, firstCreate), [
      // deleting 1 also deletes 2 and 3, so 2 is not deleted again
      ['deleteNode', 'GreenhouseDepartment-1'],
      ['deleteNode', 'GreenhouseDepartment-2'],
      ['deleteNode', 'GreenhouseDepartment-3'],
      ['deleteNode', 'GreenhouseDepartment-4'],
      ['deleteNode', 'GreenhouseDepartment-5'],
    ])
    assert.equal(rebuild.calls.slice(firstCreate).some(([action]) => action === 'deleteNode'), false)
    assert.deepEqual(
      [...rebuild.store.keys()].sort(),
      cachedIds.filter(id => id !== 'GreenhouseDepartment-4').sort()
    )
  })

  test('warn about a job whose details are gone, and leave it out', async t => {
    mockBoard(t, { jobs: [job(100), job(101)], missingJobs: [101] })
    const gatsby = fakeGatsby()
    await sourceNodes(gatsby.args, { boardToken: 'acme' })

    assert.deepEqual([...gatsby.store.keys()], ['GreenhouseJob-100'])
    assert.deepEqual(gatsby.logs.warn, [
      'gatsby-source-greenhouse-job-board: Skipping job 101 (Job 101), since Greenhouse no longer has its details',
    ])
  })

  test('send at most `requestsPerMinute` requests in any minute, for offices, departments and jobs', async t => {
    const { sourceNodes } = loadWithMockClock(t, '../gatsby-node')
    const times = mockBoard(t, { jobs: [job(100)] })
    const options = { boardToken: 'acme', requestsPerMinute: 1 }
    // like a site that sources two boards, whose requests count together, so that the offices of
    // the second board have to wait too
    const gatsby = fakeGatsby()
    await run(t, sourceNodes(gatsby.args, options))
    await run(t, sourceNodes(fakeGatsby().args, options))

    // offices, departments, the job listing and job 100, twice, each a minute after the one before
    assert.deepEqual(times, [0, 1, 2, 3, 4, 5, 6, 7].map(minutes => minutes * 60000))
    assert.deepEqual([...gatsby.store.keys()], ['GreenhouseJob-100'])
  })

  test('send up to 2,000 requests a minute when the site does not set `requestsPerMinute`', async t => {
    const { sourceNodes } = loadWithMockClock(t, '../gatsby-node')
    const times = mockBoard(t, { jobs: Array.from({ length: 1998 }, (_, i) => job(i + 1)) })
    const gatsby = fakeGatsby()
    await run(t, sourceNodes(gatsby.args, { boardToken: 'acme' }))

    assert.deepEqual(times, [...Array(2000).fill(0), 60000])
    assert.equal(gatsby.store.size, 1998)
  })

  test('panic when the board cannot be fetched, and create nothing', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
    const gatsby = fakeGatsby()
    await sourceNodes(gatsby.args, { boardToken: 'acme' })

    assert.deepEqual(gatsby.logs.panic, [
      'gatsby-source-greenhouse-job-board: Failed to fetch offices from Greenhouse API: ' +
        `Request to ${boardUrl}/offices/ failed with HTTP status 404`,
    ])
    assert.deepEqual(gatsby.calls, [])
  })
})
