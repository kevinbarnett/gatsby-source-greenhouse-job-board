const { beforeEach, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { stripVTControlCharacters } = require('node:util')
const { Joi, testPluginOptionsSchema, validateOptionsSchema } = require('gatsby-plugin-utils')
const { buildSchema } = require('gatsby/graphql')

const { pluginOptionsSchema, createSchemaCustomization, createResolvers } = require('../gatsby-node')
const { typeDefs } = require('../schema')
const { loadFresh, loadWithMockClock, run } = require('./mock-clock')

const boardUrl = boardToken => `https://boards-api.greenhouse.io/v1/boards/${boardToken}`

// The responses of the Greenhouse API for a board. Jobs listed in `missingJobs` are in the job
// listing, but their details are gone.
const boardRoutes = (boardToken, { offices = [], departments = [], jobs = [], missingJobs = [] }) => {
  const url = boardUrl(boardToken)
  const routes = {
    [`${url}/offices/`]: { offices },
    [`${url}/departments/`]: { departments },
    [`${url}/jobs/`]: { jobs: jobs.map(({ id, title }) => ({ id, title })) },
  }
  for (const job of jobs) {
    routes[`${url}/jobs/${job.id}?questions=true`] = missingJobs.includes(job.id) ? 404 : job
  }
  return routes
}

// Serves boards from the Greenhouse API, keyed by board token, and returns when each request was sent
const mockBoards = (t, boards) => {
  const routes = Object.assign({}, ...Object.entries(boards).map(([boardToken, board]) => boardRoutes(boardToken, board)))
  const times = []
  t.mock.method(globalThis, 'fetch', async url => {
    times.push(Date.now())
    const route = routes[url]
    return typeof route === 'number' ? new Response('', { status: route }) : Response.json(route)
  })
  return times
}

const mockBoard = (t, board) => mockBoards(t, { acme: board })

// The parts of Gatsby that sourceNodes uses. A later build passes the fake of the build before it,
// to keep its node store.
const fakeGatsby = ({ store = new Map() } = {}) => {
  const calls = []
  const logs = { info: [], warn: [], panic: [] }
  // the nodes created in this build
  const created = new Set()
  // like Gatsby, which adds the message of an error passed along to the message it logs
  const log = level => (message, error) =>
    logs[level].push(stripVTControlCharacters(error ? `${message} ${error.message}` : message))

  // like Gatsby, which deletes the children of a node along with it, and their children
  const deleteChildren = node => {
    for (const childId of node.children) {
      if (store.has(childId)) {
        deleteNode(store.get(childId))
      }
    }
  }

  const deleteNode = node => {
    // like Gatsby, which cannot delete a node that is gone
    assert.ok(store.has(node.id), `deleteNode called for ${node.id}, which does not exist`)
    const storedNode = store.get(node.id)
    calls.push(['deleteNode', node.id])
    store.delete(node.id)
    deleteChildren(storedNode)
  }

  return {
    store,
    calls,
    logs,
    // like Gatsby, which deletes the nodes that were not created in a build once every plugin has
    // created its nodes, unless their parent was, looking up to the parent at the top
    deleteStaleNodes: () => {
      for (const node of [...store.values()]) {
        let top = node
        while (top.parent && store.has(top.parent)) {
          top = store.get(top.parent)
        }
        if (store.has(node.id) && !created.has(top.id)) {
          deleteNode(node)
        }
      }
    },
    args: {
      actions: {
        createNode: node => {
          calls.push(['createNode', node.id])
          // like Gatsby, which deletes the children of a cached node that changed, to have them
          // created again
          const cachedNode = store.get(node.id)
          if (cachedNode && cachedNode.internal.contentDigest !== node.internal.contentDigest) {
            deleteChildren(cachedNode)
          }
          store.set(node.id, node)
          created.add(node.id)
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

  test('reject a board token that cannot name a board, which earlier versions failed to fetch', async () => {
    const errors = {}
    for (const boardToken of ['', '   ', 0, -5, 1.5, null]) {
      errors[JSON.stringify(boardToken)] = (await testPluginOptionsSchema(pluginOptionsSchema, { boardToken })).errors
    }
    assert.deepEqual(errors, {
      '""': ['"boardToken" is not allowed to be empty'],
      '"   "': ['"boardToken" is not allowed to be empty'],
      0: ['"boardToken" must be a positive number'],
      [-5]: ['"boardToken" must be a positive number'],
      1.5: ['"boardToken" must be an integer'],
      null: ['"boardToken" must be one of [string, number]'],
    })
  })

  test('trim spaces around the board token, which would otherwise end up in the URL', async () => {
    const { value } = await validateOptionsSchema(pluginOptionsSchema({ Joi }), { boardToken: ' acme\n' })
    assert.equal(value.boardToken, 'acme')
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

  test('accept a timeout of a whole number of milliseconds, from 1 to the longest timer Node.js has', async () => {
    for (const timeout of [1, 90000, 2147483647]) {
      const result = await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: 'acme', timeout })
      assert.equal(result.isValid, true, `${timeout}: ${result.errors}`)
      assert.equal(result.hasWarnings, false)
    }

    const errors = {}
    for (const timeout of [0, -5, 1.5, 'slow', null, Infinity, 2147483648]) {
      const result = await testPluginOptionsSchema(pluginOptionsSchema, { boardToken: 'acme', timeout })
      errors[timeout] = result.errors
    }
    assert.deepEqual(errors, {
      // 0 would time out every request right away
      0: ['"timeout" must be greater than or equal to 1'],
      [-5]: ['"timeout" must be greater than or equal to 1'],
      1.5: ['"timeout" must be an integer'],
      slow: ['"timeout" must be a number'],
      null: ['"timeout" must be a number'],
      Infinity: ['"timeout" cannot be infinity'],
      // Node.js would time out after 1ms instead
      2147483648: ['"timeout" must be less than or equal to 2147483647'],
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

describe('createResolvers', () => {
  test('resolve job metadata against the schema that Gatsby inferred from the jobs', () => {
    const resolvers = []
    const jobs = [{ internal: { type: 'GreenhouseJob' }, metadata: [{ name: 'Featured on Website', value: [] }] }]
    createResolvers({
      createResolvers: definitions => resolvers.push(definitions),
      intermediateSchema: buildSchema(`
        type GreenhouseJobMetadata { name: String value: String }
        type Query { metadata: [GreenhouseJobMetadata] }
      `),
      getNodesByType: type => jobs.filter(node => node.internal.type === type),
    })

    assert.equal(resolvers.length, 1)
    assert.deepEqual(resolvers[0].GreenhouseJobMetadata, { id: { type: 'Float' } })
    assert.equal(typeof resolvers[0].GreenhouseJob.metadata.resolve, 'function')
  })
})

describe('sourceNodes', () => {
  let sourceNodes
  beforeEach(() => {
    ({ sourceNodes } = loadFresh('../gatsby-node'))
  })

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
    const rebuild = fakeGatsby(gatsby)
    await sourceNodes(rebuild.args, { boardToken: 'acme' })
    rebuild.deleteStaleNodes()

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

  test('delete changed parents that 2.0 created, which the plugin kept no record of', async t => {
    const board = {
      offices: [
        // listed before its parent
        { id: 11, parent_id: 10, child_ids: [], departments: [] },
        { id: 10, parent_id: null, child_ids: [11], departments: [] },
      ],
      departments: [
        { id: 2, parent_id: 1, child_ids: [3], jobs: [] },
        { id: 3, parent_id: 2, child_ids: [], jobs: [] },
        { id: 1, parent_id: null, child_ids: [2], jobs: [] },
      ],
    }
    mockBoard(t, board)
    const cleanBuild = fakeGatsby()
    await sourceNodes(cleanBuild.args, { boardToken: 'acme' })

    // 2.0 created the same nodes, but worked out their digests another way
    const store = new Map([...cleanBuild.store].map(([id, node]) => [
      id,
      { ...node, internal: { ...node.internal, contentDigest: `2.0 ${node.internal.contentDigest}` } },
    ]))
    const rebuild = fakeGatsby({ store })
    await sourceNodes(rebuild.args, { boardToken: 'acme' })
    rebuild.deleteStaleNodes()

    // every node is deleted before the first create, in whichever order the store lists them
    const firstCreate = rebuild.calls.findIndex(([action]) => action === 'createNode')
    assert.deepEqual(rebuild.calls.slice(0, firstCreate).sort(), [
      ['deleteNode', 'GreenhouseDepartment-1'],
      ['deleteNode', 'GreenhouseDepartment-2'],
      ['deleteNode', 'GreenhouseDepartment-3'],
      ['deleteNode', 'GreenhouseOffice-10'],
      ['deleteNode', 'GreenhouseOffice-11'],
    ])
    assert.equal(rebuild.calls.slice(firstCreate).some(([action]) => action === 'deleteNode'), false)
    assert.deepEqual(rebuild.store, cleanBuild.store)
  })

  test('leave the nodes of other boards alone, for a site that sources several boards', async t => {
    const globex = {
      departments: [
        { id: 6, parent_id: null, child_ids: [7], jobs: [] },
        { id: 7, parent_id: 6, child_ids: [], jobs: [] },
      ],
    }
    mockBoards(t, {
      acme: {
        departments: [
          { id: 1, name: 'Engineering', parent_id: null, child_ids: [2], jobs: [] },
          { id: 2, parent_id: 1, child_ids: [], jobs: [] },
        ],
      },
      globex,
    })
    // like Gatsby, which runs each instance of the plugin in turn, with one node store
    const gatsby = fakeGatsby()
    await sourceNodes(gatsby.args, { boardToken: 'acme' })
    await sourceNodes(gatsby.args, { boardToken: 'globex' })
    gatsby.deleteStaleNodes()

    assert.equal(gatsby.calls.some(([action]) => action === 'deleteNode'), false)
    const cachedIds = [...gatsby.store.keys()]
    assert.deepEqual(cachedIds, [1, 2, 6, 7].map(id => `GreenhouseDepartment-${id}`))

    // the next build: acme renames 1, while globex stays as it was
    t.mock.restoreAll()
    mockBoards(t, {
      acme: {
        departments: [
          { id: 1, name: 'Engineering & Product', parent_id: null, child_ids: [2], jobs: [] },
          { id: 2, parent_id: 1, child_ids: [], jobs: [] },
        ],
      },
      globex,
    })
    const rebuild = fakeGatsby(gatsby)
    await sourceNodes(rebuild.args, { boardToken: 'acme' })
    await sourceNodes(rebuild.args, { boardToken: 'globex' })
    rebuild.deleteStaleNodes()

    assert.deepEqual(rebuild.calls.filter(([action]) => action === 'deleteNode'), [
      ['deleteNode', 'GreenhouseDepartment-1'],
      ['deleteNode', 'GreenhouseDepartment-2'],
    ])
    assert.deepEqual([...rebuild.store.keys()].sort(), cachedIds)
    assert.equal(rebuild.store.get('GreenhouseDepartment-1').name, 'Engineering & Product')
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

  test('wait for each request as long as `timeout` says, and 90 seconds when the site does not set it', async t => {
    mockBoard(t, { jobs: [job(100)] })
    const timeouts = t.mock.method(AbortSignal, 'timeout')
    const timeoutOfEachRequest = async options => {
      timeouts.mock.resetCalls()
      await sourceNodes(fakeGatsby().args, options)
      return timeouts.mock.calls.map(call => call.arguments[0])
    }

    // offices, departments, the job listing and job 100
    assert.deepEqual(await timeoutOfEachRequest({ boardToken: 'acme', timeout: 5000 }), [5000, 5000, 5000, 5000])
    assert.deepEqual(await timeoutOfEachRequest({ boardToken: 'acme' }), [90000, 90000, 90000, 90000])
  })

  test('panic when the board cannot be fetched, and create nothing', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
    const gatsby = fakeGatsby()
    await sourceNodes(gatsby.args, { boardToken: 'acme' })

    assert.deepEqual(gatsby.logs.panic, [
      'gatsby-source-greenhouse-job-board: Failed to fetch offices from Greenhouse API: ' +
        `Request to ${boardUrl('acme')}/offices/ failed with HTTP status 404`,
    ])
    assert.deepEqual(gatsby.calls, [])
  })
})
