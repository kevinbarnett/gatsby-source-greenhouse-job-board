// Builds a real Gatsby site with the plugin packed the way npm publishes it,
// against a mock of the Greenhouse API (see mock-greenhouse.js)
const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { stripVTControlCharacters } = require('node:util')

const root = path.join(__dirname, '..')
const siteDir = path.join(__dirname, 'site')
// where npm would install the plugin for the site
const pluginDir = path.join(siteDir, 'node_modules', 'gatsby-source-greenhouse-job-board')
const gatsbyCli = require.resolve('gatsby/cli.js')

let tmpDir

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenhouse-e2e-'))
  // npm pack runs the prepare script, which builds the plugin
  execFileSync('npm', ['pack', '--pack-destination', tmpDir], { cwd: root, stdio: 'ignore' })
  const [tarball] = fs.readdirSync(tmpDir)
  fs.rmSync(pluginDir, { recursive: true, force: true })
  fs.mkdirSync(pluginDir, { recursive: true })
  execFileSync('tar', ['-xzf', path.join(tmpDir, tarball), '-C', pluginDir, '--strip-components=1'])
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Turns a board into the responses of the Greenhouse API, nested the way Greenhouse nests them:
// every office lists every department with the jobs at that office, every department lists its
// jobs, and every job lists its departments and offices. Jobs without a department or office are
// under "No Department" or "No Office". Jobs in `missingJobs` are listed, but their details are gone.
const greenhouseRoutes = ({ offices, departments, jobs, missingJobs = [] }, boardToken) => {
  const noOffice = { id: 0, name: 'No Office', location: null, parent: null, children: [] }
  const noDepartment = { id: 0, name: 'No Department', parent: null, children: [] }

  const officeSummary = ({ id, name, location, parent, children }) => ({
    id, name, location, parent_id: parent, child_ids: children,
  })
  const departmentSummary = ({ id, name, parent, children }) => ({
    id, name, parent_id: parent, child_ids: children,
  })
  const listing = ({ id, title, metadata = null }) => ({
    id,
    internal_job_id: id + 1000,
    title,
    absolute_url: `https://job-boards.greenhouse.io/${boardToken}/jobs/${id}`,
    updated_at: '2026-10-01T09:30:00-04:00',
    first_published: '2026-09-01T09:30:00-04:00',
    requisition_id: `R-${id}`,
    company_name: 'Acme',
    language: 'en',
    location: { name: 'Remote' },
    metadata,
  })
  const jobsIn = (department, office) => jobs
    .filter(job => (job.department ?? 0) === department.id && (!office || (job.office ?? 0) === office.id))
    .map(listing)
  const departmentsAt = office => [...departments, noDepartment]
    .map(department => ({ ...departmentSummary(department), jobs: jobsIn(department, office) }))

  const board = `/v1/boards/${boardToken}`
  const routes = {
    [`${board}/offices/`]: {
      status: 200,
      body: {
        offices: [...offices, noOffice].map(office => ({ ...officeSummary(office), departments: departmentsAt(office) })),
      },
    },
    [`${board}/departments/`]: {
      status: 200,
      body: { departments: departmentsAt() },
    },
    [`${board}/jobs/`]: {
      status: 200,
      body: { jobs: jobs.map(listing), meta: { total: jobs.length } },
    },
  }
  for (const job of jobs) {
    routes[`${board}/jobs/${job.id}?questions=true`] = missingJobs.includes(job.id)
      ? { status: 404, body: { status: 404, error: 'Job not found' } }
      : {
        status: 200,
        body: {
          ...listing(job),
          content: '&lt;p&gt;Join us&lt;/p&gt;',
          departments: departments.filter(({ id }) => id === job.department).map(departmentSummary),
          offices: offices.filter(({ id }) => id === job.office).map(officeSummary),
          questions: [
            {
              required: true,
              label: 'First Name',
              description: null,
              fields: [{ name: 'first_name', type: 'input_text', values: [] }],
            },
          ],
        },
      }
  }
  return routes
}

// Runs `gatsby build` for the site, with the plugin added once for each of the options in `plugins`
// and `routes` as the responses of the Greenhouse API, and returns Gatsby's exit code, what it
// printed, and the results of running `queries` one after another while the site creates its pages,
// if the build got that far. Each query is a string, or an object with the query and its variables.
// The site declares `typeDefs` as types of its own, if given.
const gatsbyBuild = async ({ routes, plugins = [{ boardToken: 'acme' }], typeDefs = '', queries, clean }) => {
  if (clean) {
    for (const dir of ['.cache', 'public']) {
      fs.rmSync(path.join(siteDir, dir), { recursive: true, force: true })
    }
  }
  const mockFile = path.join(tmpDir, 'greenhouse.json')
  const resultsFile = path.join(tmpDir, 'results.json')
  fs.writeFileSync(mockFile, JSON.stringify(routes))
  fs.rmSync(resultsFile, { force: true })

  const gatsby = spawn(process.execPath, [gatsbyCli, 'build'], {
    cwd: siteDir,
    env: {
      ...process.env,
      CI: '1',
      GATSBY_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(path.join(__dirname, 'mock-greenhouse.js'))}`]
        .filter(Boolean)
        .join(' '),
      E2E_PLUGIN_OPTIONS: JSON.stringify(plugins),
      E2E_TYPE_DEFS: typeDefs,
      GREENHOUSE_MOCK: mockFile,
      E2E_QUERIES: JSON.stringify(queries.map(query => (typeof query === 'string' ? { query } : query))),
      E2E_RESULTS: resultsFile,
    },
    timeout: 120_000,
  })
  let output = ''
  gatsby.stdout.on('data', data => { output += data })
  gatsby.stderr.on('data', data => { output += data })
  const [code] = await once(gatsby, 'close')
  const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : undefined
  return { code, output: stripVTControlCharacters(output), results }
}

// Builds the site, serving `board` as the Greenhouse API, and returns the data of running `query`
// while the site creates its pages, along with what Gatsby printed. `query` can also be an object of
// named queries, which run one after another, and then the data is an object with that of each. A
// site that sources several boards gives `boards` instead, as a list of `{ boardToken, board }`, and
// adds the plugin once for each. `routes` replaces the responses made from the boards, for a test
// that changes them.
const build = async ({
  board, boardToken = 'acme', boards = [{ boardToken, board }],
  routes = Object.assign({}, ...boards.map(({ boardToken, board }) => greenhouseRoutes(board, boardToken))),
  options, typeDefs, query, clean = true,
}) => {
  const queries = typeof query === 'string' ? { query } : query
  const { code, output, results } = await gatsbyBuild({
    routes,
    plugins: boards.map(({ boardToken }) => ({ boardToken, ...options })),
    typeDefs,
    queries: Object.values(queries),
    clean,
  })
  assert.equal(code, 0, `gatsby build failed:\n${output}`)
  const data = Object.fromEntries(Object.keys(queries).map((name, i) => {
    const { data, errors } = results[i]
    assert.equal(errors, undefined, `the query ${name} failed:\n${JSON.stringify(errors, null, 2)}`)
    return [name, data]
  }))
  return { data: typeof query === 'string' ? data.query : data, output }
}

const linksQuery = `{
  allGreenhouseOffice {
    nodes {
      gh_Id
      name
      parent { ... on GreenhouseOffice { gh_Id } }
      children { ... on GreenhouseOffice { gh_Id } }
      childrenGreenhouseOffice { gh_Id }
      jobs { gh_Id }
    }
  }
  allGreenhouseDepartment {
    nodes {
      gh_Id
      name
      parent { ... on GreenhouseDepartment { gh_Id } }
      children { ... on GreenhouseDepartment { gh_Id } }
      childrenGreenhouseDepartment { gh_Id }
      jobs { gh_Id }
    }
  }
  allGreenhouseJob {
    nodes {
      gh_Id
      title
      updated_at(formatString: "YYYY-MM-DD")
      location { name }
      questions { required label description fields { name type } }
      metadata { id name value_type value }
      departments { gh_Id }
      offices { gh_Id }
    }
  }
}`

// Greenhouse ids of linked nodes, in order, or null for a node that links to none of a kind
const ids = nodes => nodes && nodes.map(node => node.gh_Id).sort((a, b) => a - b)

// What the site sees of each office, department and job, keyed by Greenhouse id. The children of an
// office or department are also its childrenGreenhouseOffice or childrenGreenhouseDepartment.
const linksOf = data => {
  const byId = (nodes, describe) => Object.fromEntries(nodes.map(node => [node.gh_Id, describe(node)]))
  const tree = typedChildren => ({ name, parent, children, jobs, ...node }) => {
    // a list even where there are none, so a site can query it on every board
    assert.ok(Array.isArray(node[typedChildren]), `${typedChildren} of ${name} is not a list`)
    assert.deepEqual(ids(node[typedChildren]), ids(children), `${typedChildren} of ${name}`)
    return { name, parent: parent && parent.gh_Id, children: ids(children), jobs: ids(jobs) }
  }
  return {
    offices: byId(data.allGreenhouseOffice.nodes, tree('childrenGreenhouseOffice')),
    departments: byId(data.allGreenhouseDepartment.nodes, tree('childrenGreenhouseDepartment')),
    jobs: byId(data.allGreenhouseJob.nodes, ({ title, departments, offices }) => ({
      title, departments: ids(departments), offices: ids(offices),
    })),
  }
}

const offices = [
  // listed before its parent
  { id: 11, name: 'Berlin', location: 'Berlin, Germany', parent: 10, children: [] },
  { id: 10, name: 'Europe', location: null, parent: null, children: [11] },
]

const departments = [
  // listed before its parent
  { id: 2, name: 'Frontend', parent: 1, children: [] },
  { id: 1, name: 'Engineering', parent: null, children: [2, 3] },
  { id: 3, name: 'Backend', parent: 1, children: [] },
  { id: 5, name: 'Account Management', parent: 4, children: [] },
  { id: 4, name: 'Sales', parent: null, children: [5] },
]

const jobs = [
  { id: 100, title: 'Frontend Engineer', department: 2, office: 11 },
  { id: 101, title: 'Backend Engineer', department: 3, office: 10 },
  { id: 102, title: 'Account Manager', department: 5, office: 10 },
  { id: 103, title: 'Office Manager', department: null, office: 11 },
]

// What linksOf gives for these offices, departments and jobs
const boardLinks = {
  offices: {
    10: { name: 'Europe', parent: null, children: [11], jobs: [101, 102] },
    // including the job in "No Department"
    11: { name: 'Berlin', parent: 10, children: [], jobs: [100, 103] },
  },
  departments: {
    1: { name: 'Engineering', parent: null, children: [2, 3], jobs: null },
    2: { name: 'Frontend', parent: 1, children: [], jobs: [100] },
    3: { name: 'Backend', parent: 1, children: [], jobs: [101] },
    4: { name: 'Sales', parent: null, children: [5], jobs: null },
    5: { name: 'Account Management', parent: 4, children: [], jobs: [102] },
  },
  jobs: {
    100: { title: 'Frontend Engineer', departments: [2], offices: [11] },
    101: { title: 'Backend Engineer', departments: [3], offices: [10] },
    102: { title: 'Account Manager', departments: [5], offices: [10] },
    103: { title: 'Office Manager', departments: null, offices: [11] },
  },
}

test('the package contains only the plugin', () => {
  assert.deepEqual(fs.readdirSync(pluginDir, { recursive: true }).sort(), [
    'README.md',
    'fetch.js',
    'gatsby-node.js',
    'index.js',
    'normalize.js',
    'package.json',
    'schema.js',
  ])
})

test('the package only requires Node.js modules, its own files and its dependencies', () => {
  const { dependencies = {}, peerDependencies = {} } = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  const packages = new Set([...builtinModules, ...Object.keys(dependencies), ...Object.keys(peerDependencies)])

  for (const file of fs.readdirSync(pluginDir).filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(pluginDir, file), 'utf8')
    for (const [, request] of source.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      if (request.startsWith('.')) {
        assert.doesNotThrow(() => require.resolve(path.join(pluginDir, request)), `${file} requires ${request}, which is not in the package`)
        continue
      }
      const name = request.replace(/^node:/, '').split('/').slice(0, request.startsWith('@') ? 2 : 1).join('/')
      assert.ok(packages.has(name), `${file} requires ${request}, which is not a dependency of the package`)
    }
  }
})

test('a site can query offices, departments and jobs, and how they link up', async () => {
  const { data } = await build({ board: { offices, departments, jobs }, query: linksQuery })

  assert.deepEqual(linksOf(data), boardLinks)

  const { updated_at, location, questions, metadata } = data.allGreenhouseJob.nodes.find(job => job.gh_Id === 100)
  assert.deepEqual({ updated_at, location, questions, metadata }, {
    updated_at: '2026-10-01',
    location: { name: 'Remote' },
    // no question of the board has a description
    questions: [{ required: true, label: 'First Name', description: null, fields: [{ name: 'first_name', type: 'input_text' }] }],
    // and no job has custom fields
    metadata: null,
  })
})

test('a site gets an empty list for a link to offices, departments or jobs that have no node, as 2.0 did', async () => {
  const routes = greenhouseRoutes({ offices, departments, jobs, missingJobs: [101] }, 'acme')
  // Greenhouse sends each list on its own, so the lists can disagree, such as when an office or a
  // department is removed while a build is fetching
  const { body: officeList } = routes['/v1/boards/acme/offices/']
  officeList.offices = officeList.offices.filter(office => office.id !== 11)
  const { body: departmentList } = routes['/v1/boards/acme/departments/']
  departmentList.departments = departmentList.departments.filter(department => department.id !== 2)

  const { data } = await build({ routes, query: linksQuery })

  assert.deepEqual(linksOf(data), {
    offices: {
      10: { name: 'Europe', parent: null, children: [], jobs: [102] },
    },
    departments: {
      1: { name: 'Engineering', parent: null, children: [3], jobs: null },
      // its only job closed after it was listed
      3: { name: 'Backend', parent: 1, children: [], jobs: [] },
      4: { name: 'Sales', parent: null, children: [5], jobs: null },
      5: { name: 'Account Management', parent: 4, children: [], jobs: [102] },
    },
    jobs: {
      // Berlin and Frontend have no node
      100: { title: 'Frontend Engineer', departments: [], offices: [] },
      102: { title: 'Account Manager', departments: [5], offices: [10] },
      103: { title: 'Office Manager', departments: null, offices: [] },
    },
  })
})

// The board of a rebuild, changed in every way that makes Gatsby delete cached nodes, and what the
// site sees of it
const changedBoard = {
  offices: [
    // listed before its parent, which is renamed
    offices[0],
    { ...offices[1], name: 'EMEA' },
  ],
  departments: [
    // listed before its parent, which is renamed and gets a child
    departments[0],
    { ...departments[1], name: 'Product Engineering', children: [2, 3, 5] },
    departments[2],
    // moved from Sales, which is gone
    { ...departments[3], parent: 1 },
  ],
  jobs,
  // closed after it was listed, so Backend and EMEA still list it
  missingJobs: [101],
}

const changedLinks = {
  offices: {
    10: { name: 'EMEA', parent: null, children: [11], jobs: [102] },
    11: { name: 'Berlin', parent: 10, children: [], jobs: [100, 103] },
  },
  departments: {
    1: { name: 'Product Engineering', parent: null, children: [2, 3, 5], jobs: null },
    2: { name: 'Frontend', parent: 1, children: [], jobs: [100] },
    3: { name: 'Backend', parent: 1, children: [], jobs: [] },
    5: { name: 'Account Management', parent: 1, children: [], jobs: [102] },
  },
  jobs: {
    100: { title: 'Frontend Engineer', departments: [2], offices: [11] },
    102: { title: 'Account Manager', departments: [5], offices: [10] },
    103: { title: 'Office Manager', departments: null, offices: [11] },
  },
}

test('a rebuild from the cache keeps offices and departments that changed, moved or lost a job', async () => {
  await build({ board: { offices, departments, jobs }, query: linksQuery })

  const { data, output } = await build({ board: changedBoard, query: linksQuery, clean: false })

  assert.doesNotMatch(output, /deleting your site's\s+cache/, 'Gatsby did not use the cache')
  assert.match(output, /Skipping job 101 \(Backend Engineer\), since Greenhouse no longer has its details/)
  assert.deepEqual(linksOf(data), changedLinks)
})

test('a rebuild keeps them too when Gatsby keeps the nodes but not what plugins cached, as 2.0 cached nothing', async () => {
  await build({ board: { offices, departments, jobs }, query: linksQuery })
  // where Gatsby keeps what plugins cache, apart from the nodes in .cache/data
  fs.rmSync(path.join(siteDir, '.cache', 'caches-lmdb'), { recursive: true, force: true })

  const { data, output } = await build({ board: changedBoard, query: linksQuery, clean: false })

  assert.doesNotMatch(output, /deleting your site's\s+cache/, 'Gatsby did not use the cache')
  assert.deepEqual(linksOf(data), changedLinks)
})

test('a site can source several boards, and a rebuild that changes one board keeps the others', async () => {
  const otherBoard = {
    offices: [
      { id: 20, name: 'Americas', location: null, parent: null, children: [21] },
      { id: 21, name: 'Toronto', location: 'Toronto, Canada', parent: 20, children: [] },
    ],
    departments: [
      { id: 6, name: 'Design', parent: null, children: [7] },
      { id: 7, name: 'Product Design', parent: 6, children: [] },
    ],
    jobs: [{ id: 200, title: 'Product Designer', department: 7, office: 21 }],
  }
  const otherLinks = {
    offices: {
      // an office with departments has a list of jobs, even an empty one, as 2.0 did
      20: { name: 'Americas', parent: null, children: [21], jobs: [] },
      21: { name: 'Toronto', parent: 20, children: [], jobs: [200] },
    },
    departments: {
      6: { name: 'Design', parent: null, children: [7], jobs: null },
      7: { name: 'Product Design', parent: 6, children: [], jobs: [200] },
    },
    jobs: {
      200: { title: 'Product Designer', departments: [7], offices: [21] },
    },
  }
  const boards = acmeBoard => [{ boardToken: 'acme', board: acmeBoard }, { boardToken: 'globex', board: otherBoard }]

  const { data } = await build({ boards: boards({ offices, departments, jobs }), query: linksQuery })

  assert.deepEqual(linksOf(data), {
    offices: {
      10: { name: 'Europe', parent: null, children: [11], jobs: [101, 102] },
      11: { name: 'Berlin', parent: 10, children: [], jobs: [100, 103] },
      ...otherLinks.offices,
    },
    departments: {
      1: { name: 'Engineering', parent: null, children: [2, 3], jobs: null },
      2: { name: 'Frontend', parent: 1, children: [], jobs: [100] },
      3: { name: 'Backend', parent: 1, children: [], jobs: [101] },
      4: { name: 'Sales', parent: null, children: [5], jobs: null },
      5: { name: 'Account Management', parent: 4, children: [], jobs: [102] },
      ...otherLinks.departments,
    },
    jobs: {
      100: { title: 'Frontend Engineer', departments: [2], offices: [11] },
      101: { title: 'Backend Engineer', departments: [3], offices: [10] },
      102: { title: 'Account Manager', departments: [5], offices: [10] },
      103: { title: 'Office Manager', departments: null, offices: [11] },
      ...otherLinks.jobs,
    },
  })

  const rebuilt = await build({
    boards: boards({
      offices: [offices[0], { ...offices[1], name: 'EMEA' }],
      departments: [departments[0], { ...departments[1], name: 'Product Engineering' }, ...departments.slice(2)],
      jobs,
    }),
    query: linksQuery,
    clean: false,
  })

  assert.doesNotMatch(rebuilt.output, /deleting your site's\s+cache/, 'Gatsby did not use the cache')
  const links = linksOf(rebuilt.data)
  assert.deepEqual(
    { 10: links.offices[10].name, 1: links.departments[1].name },
    { 10: 'EMEA', 1: 'Product Engineering' }
  )
  // the other board did not change, so it is still all there
  assert.deepEqual({
    offices: { 20: links.offices[20], 21: links.offices[21] },
    departments: { 6: links.departments[6], 7: links.departments[7] },
    jobs: { 200: links.jobs[200] },
  }, otherLinks)
  assert.deepEqual(Object.keys(links.departments).map(Number), [1, 2, 3, 4, 5, 6, 7])
})

test('a site can query a board that has no offices, departments or jobs', async () => {
  const { data } = await build({
    board: { offices: [], departments: [], jobs: [] },
    query: `{
      allGreenhouseOffice { nodes { name location childrenGreenhouseOffice { name } departments { name } jobs { title } } }
      allGreenhouseDepartment { nodes { name childrenGreenhouseDepartment { name } jobs { title } } }
      allGreenhouseJob {
        nodes {
          title
          absolute_url
          content
          language
          company_name
          updated_at(formatString: "YYYY-MM-DD")
          first_published(formatString: "YYYY-MM-DD")
          location { name }
          questions { required label description fields { name type } }
          metadata { id name value_type value }
          departments { name }
          offices { name }
        }
      }
    }`,
  })

  assert.deepEqual(data, {
    allGreenhouseOffice: { nodes: [] },
    allGreenhouseDepartment: { nodes: [] },
    allGreenhouseJob: { nodes: [] },
  })
})

// A board where no office or department has sub-offices or sub-departments, and what linksOf gives
// for it
const flatBoard = {
  offices: [{ id: 10, name: 'Remote', location: null, parent: null, children: [] }],
  departments: [{ id: 1, name: 'Engineering', parent: null, children: [] }],
  jobs: [{ id: 100, title: 'Engineer', department: 1, office: 10 }],
}
const flatBoardLinks = {
  offices: { 10: { name: 'Remote', parent: null, children: [], jobs: [100] } },
  departments: { 1: { name: 'Engineering', parent: null, children: [], jobs: [100] } },
  jobs: { 100: { title: 'Engineer', departments: [1], offices: [10] } },
}

test('a site can query sub-offices and sub-departments on a board where no office or department has any', async () => {
  const { data } = await build({ board: flatBoard, query: linksQuery })

  assert.deepEqual(linksOf(data), flatBoardLinks)
})

test('a site that declared sub-offices, sub-departments and metadata itself for earlier versions still gets them', async t => {
  // Earlier versions left these fields out where no office or department had any sub-offices or
  // sub-departments, or no job had any metadata, so a site could declare them like this
  const typeDefs = `
    type GreenhouseDepartment implements Node @childOf(types: ["GreenhouseDepartment"]) {
      name: String
    }
    type GreenhouseOffice implements Node {
      childrenGreenhouseOffice: [GreenhouseOffice] @link(from: "children")
    }
    type GreenhouseJob implements Node {
      metadata: [GreenhouseJobMetadata]
    }
    type GreenhouseJobMetadata {
      id: Int
      name: String
      value_type: String
      value: String
    }
  `

  await t.test('on a board with sub-offices and sub-departments', async () => {
    const { data } = await build({ board: { offices, departments, jobs }, typeDefs, query: linksQuery })

    assert.deepEqual(linksOf(data), boardLinks)
  })

  await t.test('on a board without', async () => {
    const { data } = await build({ board: flatBoard, typeDefs, query: linksQuery })

    assert.deepEqual(linksOf(data), flatBoardLinks)
  })
})

// Jobs list the values of the board's custom fields in their metadata. The type of a value depends
// on the value_type of its custom field.
const jobsWithMetadata = metadata => jobs.map((job, i) => ({ ...job, metadata: metadata[i] }))

const jobsQuery = filter => `{ allGreenhouseJob(filter: ${filter}, sort: { gh_Id: ASC }) { nodes { gh_Id } } }`

const metadataQuery = '{ allGreenhouseJob(sort: { gh_Id: ASC }) { nodes { gh_Id metadata { id name value_type value } } } }'

test('a site can query and filter job metadata where a value is an empty list, and the others are strings', async () => {
  // Greenhouse sends an empty list for a multi_select field without a value
  const featured = { id: 1, name: 'Featured on Website', value_type: 'multi_select', value: [] }
  const team = value => ({ id: 2, name: 'Careers Site Department', value_type: 'single_select', value })
  const { data } = await build({
    board: {
      offices,
      departments,
      jobs: jobsWithMetadata([[featured, team('Engineering')], [featured, team(null)], [featured, team('Sales')], null]),
    },
    // Gatsby resolves the metadata of every job to filter jobs, and keeps the result for later
    // queries. The order makes sure that one filter does not change what the next one finds.
    query: {
      withoutValue: jobsQuery('{ metadata: { elemMatch: { value: { eq: null } } } }'),
      inATeam: jobsQuery('{ metadata: { elemMatch: { name: { eq: "Careers Site Department" }, value: { ne: null } } } }'),
      // the value is a String, as in earlier versions
      inTeam: {
        query: `query ($team: String) {
          allGreenhouseJob(filter: { metadata: { elemMatch: { value: { eq: $team } } } }, sort: { gh_Id: ASC }) { nodes { gh_Id } }
        }`,
        variables: { team: 'Engineering' },
      },
      metadata: metadataQuery,
    },
  })

  assert.deepEqual({
    withoutValue: ids(data.withoutValue.allGreenhouseJob.nodes),
    inATeam: ids(data.inATeam.allGreenhouseJob.nodes),
    inTeam: ids(data.inTeam.allGreenhouseJob.nodes),
  }, {
    // as in earlier versions, an empty list is not null, and a job without metadata is
    withoutValue: [101, 103],
    inATeam: [100, 102],
    inTeam: [100],
  })
  // a String cannot be a list, so the empty lists are null
  const unset = { ...featured, value: null }
  assert.deepEqual(data.metadata.allGreenhouseJob.nodes, [
    { gh_Id: 100, metadata: [unset, team('Engineering')] },
    { gh_Id: 101, metadata: [unset, team(null)] },
    { gh_Id: 102, metadata: [unset, team('Sales')] },
    { gh_Id: 103, metadata: null },
  ])
})

test('a site can query job metadata where values have different types, and gets each value as Greenhouse sends it', async () => {
  const remote = { id: 1, name: 'Remote Eligible', value_type: 'yes_no', value: true }
  const arrangement = { id: 2, name: 'Work Arrangement', value_type: 'single_select', value: 'Remote' }
  const locations = { id: 3, name: 'Locations', value_type: 'multi_select', value: ['Remote', 'Hybrid'] }
  const salary = { id: 4, name: 'Salary', value_type: 'currency', value: { unit: 'USD', amount: '100.0' } }
  const { data } = await build({
    board: { offices, departments, jobs: jobsWithMetadata([[remote, arrangement], [locations], [salary], []]) },
    query: metadataQuery,
  })

  assert.deepEqual(data.allGreenhouseJob.nodes, [
    { gh_Id: 100, metadata: [remote, arrangement] },
    { gh_Id: 101, metadata: [locations] },
    { gh_Id: 102, metadata: [salary] },
    { gh_Id: 103, metadata: [] },
  ])
})

test('a site that declared metadata values as JSON for earlier versions still gets them as sent, and filters them as before', async () => {
  const featured = value => ({ id: 1, name: 'Featured on Website', value_type: 'multi_select', value })
  const team = value => ({ id: 2, name: 'Careers Site Department', value_type: 'single_select', value })
  const remote = { id: 3, name: 'Remote Eligible', value_type: 'yes_no', value: true }
  const salary = { id: 4, name: 'Salary', value_type: 'currency', value: { unit: 'USD', amount: '100.0' } }
  const metadata = [
    [featured([]), team('Engineering'), remote],
    [featured([]), team(null)],
    [featured(['Careers Site']), team('Sales'), salary],
    null,
  ]
  const { data } = await build({
    board: { offices, departments, jobs: jobsWithMetadata(metadata) },
    // Earlier versions failed on empty lists among strings, and left the field out where values had
    // different types, so a site could declare it like this
    typeDefs: 'type GreenhouseJobMetadata { value: JSON }',
    query: {
      withoutValue: jobsQuery('{ metadata: { elemMatch: { value: { eq: null } } } }'),
      inTeam: jobsQuery('{ metadata: { elemMatch: { value: { eq: "Engineering" } } } }'),
      featuredOnCareersSite: jobsQuery('{ metadata: { elemMatch: { value: { eq: "Careers Site" } } } }'),
      remote: jobsQuery('{ metadata: { elemMatch: { value: { eq: true } } } }'),
      metadata: metadataQuery,
    },
  })

  assert.deepEqual({
    withoutValue: ids(data.withoutValue.allGreenhouseJob.nodes),
    inTeam: ids(data.inTeam.allGreenhouseJob.nodes),
    featuredOnCareersSite: ids(data.featuredOnCareersSite.allGreenhouseJob.nodes),
    remote: ids(data.remote.allGreenhouseJob.nodes),
  }, {
    // as in earlier versions, an empty list is not null, but Gatsby's filters take an object, like
    // the salary, for null
    withoutValue: [101, 102, 103],
    inTeam: [100],
    featuredOnCareersSite: [102],
    remote: [100],
  })
  assert.deepEqual(data.metadata.allGreenhouseJob.nodes, metadata.map((metadata, i) => ({ gh_Id: jobs[i].id, metadata })))
})

test('a site can give the board token as a number, which earlier versions used as it was', async () => {
  const { data, output } = await build({
    board: { offices, departments, jobs },
    boardToken: 12345,
    query: '{ allGreenhouseJob { nodes { gh_Id } } }',
  })

  assert.doesNotMatch(output, /Invalid plugin options/)
  assert.deepEqual(ids(data.allGreenhouseJob.nodes), [100, 101, 102, 103])
})

test('a build with an unknown board token fails, and says once which request failed', async () => {
  const { code, output, results } = await gatsbyBuild({
    // what Greenhouse answers for a board that does not exist
    routes: { '/v1/boards/acme/offices/': { status: 404, body: { status: 404, error: 'Office not found' } } },
    queries: ['{ site { id } }'],
    clean: true,
  })

  assert.notEqual(code, 0)
  assert.equal(results, undefined, 'the build went on to create pages')
  // Gatsby prints the message, and then the error again with its stack trace
  const messages = output.split('\n')
    .filter(line => line.includes('Failed to fetch') && !line.trimStart().startsWith('Error:'))
  assert.deepEqual(messages, [
    'error gatsby-source-greenhouse-job-board: Failed to fetch offices from Greenhouse API: ' +
      'Request to https://boards-api.greenhouse.io/v1/boards/acme/offices/ failed with HTTP status 404',
  ], output)
})

test('a build with a blank board token, or one of 0, fails before sending any request, and says why', async () => {
  const { code, output, results } = await gatsbyBuild({
    // no responses, so any request would fail with a different error
    routes: {},
    plugins: [{ boardToken: '  ' }, { boardToken: 0 }],
    queries: ['{ site { id } }'],
    clean: true,
  })

  assert.notEqual(code, 0)
  assert.equal(results, undefined, 'the build went on to create pages')
  assert.match(output, /Invalid plugin options for "gatsby-source-greenhouse-job-board"/)
  assert.match(output, /"boardToken" is not allowed to be empty/)
  assert.match(output, /"boardToken" must be a positive number/)
  assert.doesNotMatch(output, /Failed to fetch/)
})

test('a site can set how many requests to send in any minute', async () => {
  const { data, output } = await build({
    board: { offices, departments, jobs },
    options: { requestsPerMinute: 500 },
    query: '{ allGreenhouseJob { nodes { gh_Id } } }',
  })

  assert.doesNotMatch(output, /Invalid plugin options|unknown plugin options/)
  assert.deepEqual(ids(data.allGreenhouseJob.nodes), [100, 101, 102, 103])
})

test('a build with requests per minute or a timeout below 1 fails before sending any request, and says why', async () => {
  const { code, output, results } = await gatsbyBuild({
    // no responses, so any request would fail with a different error
    routes: {},
    plugins: [{ boardToken: 'acme', requestsPerMinute: 0, timeout: 0 }],
    queries: ['{ site { id } }'],
    clean: true,
  })

  assert.notEqual(code, 0)
  assert.equal(results, undefined, 'the build went on to create pages')
  assert.match(output, /Invalid plugin options for "gatsby-source-greenhouse-job-board"/)
  assert.match(output, /"requestsPerMinute" must be greater than or equal to 1/)
  assert.match(output, /"timeout" must be greater than or equal to 1/)
  assert.doesNotMatch(output, /Failed to fetch/)
})

// The responses of the Greenhouse API for `board`, where the offices list takes `delay` milliseconds,
// like Greenhouse does for a big board that it has not sent for a while
const withSlowOffices = (board, delay) => {
  const routes = greenhouseRoutes(board, 'acme')
  routes['/v1/boards/acme/offices/'].delay = delay
  return routes
}

test('a site can set how long to wait for each request, for a board that Greenhouse is slow to send', async () => {
  const { data, output } = await build({
    routes: withSlowOffices({ offices, departments, jobs }, 1000),
    options: { timeout: 5000 },
    query: '{ allGreenhouseOffice { nodes { gh_Id } } }',
  })

  assert.doesNotMatch(output, /Invalid plugin options|unknown plugin options|timed out/)
  assert.deepEqual(ids(data.allGreenhouseOffice.nodes), [10, 11])
})

test('a build fails when Greenhouse takes longer than the timeout, and says which option to raise', async () => {
  const { code, output, results } = await gatsbyBuild({
    routes: withSlowOffices({ offices, departments, jobs }, 2000),
    plugins: [{ boardToken: 'acme', timeout: 100 }],
    queries: ['{ site { id } }'],
    clean: true,
  })

  assert.notEqual(code, 0)
  assert.equal(results, undefined, 'the build went on to create pages')
  // Gatsby prints the message, and then the error again with its stack trace
  const messages = output.split('\n')
    .filter(line => line.includes('Failed to fetch') && !line.trimStart().startsWith('Error:'))
  assert.deepEqual(messages, [
    'error gatsby-source-greenhouse-job-board: Failed to fetch offices from Greenhouse API: ' +
      'Request to https://boards-api.greenhouse.io/v1/boards/acme/offices/ timed out after 100ms. ' +
      'Set the `timeout` plugin option to wait longer.',
  ], output)
})
