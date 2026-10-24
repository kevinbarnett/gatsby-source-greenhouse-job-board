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
  const listing = ({ id, title }) => ({
    id,
    internal_job_id: id + 1000,
    title,
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    updated_at: '2026-10-01T09:30:00-04:00',
    first_published: '2026-09-01T09:30:00-04:00',
    requisition_id: `R-${id}`,
    company_name: 'Acme',
    language: 'en',
    location: { name: 'Remote' },
    metadata: null,
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

// Runs `gatsby build` for the site, with `boardToken` in its config and `routes` as the responses of
// the Greenhouse API, and returns Gatsby's exit code, what it printed, and the result of running
// `query` while the site creates its pages, if the build got that far
const gatsbyBuild = async ({ routes, boardToken = 'acme', query, clean }) => {
  if (clean) {
    for (const dir of ['.cache', 'public']) {
      fs.rmSync(path.join(siteDir, dir), { recursive: true, force: true })
    }
  }
  const mockFile = path.join(tmpDir, 'greenhouse.json')
  const resultFile = path.join(tmpDir, 'result.json')
  fs.writeFileSync(mockFile, JSON.stringify(routes))
  fs.rmSync(resultFile, { force: true })

  const gatsby = spawn(process.execPath, [gatsbyCli, 'build'], {
    cwd: siteDir,
    env: {
      ...process.env,
      CI: '1',
      GATSBY_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(path.join(__dirname, 'mock-greenhouse.js'))}`]
        .filter(Boolean)
        .join(' '),
      E2E_BOARD_TOKEN: JSON.stringify(boardToken),
      GREENHOUSE_MOCK: mockFile,
      E2E_QUERY: query,
      E2E_RESULT: resultFile,
    },
    timeout: 120_000,
  })
  let output = ''
  gatsby.stdout.on('data', data => { output += data })
  gatsby.stderr.on('data', data => { output += data })
  const [code] = await once(gatsby, 'close')
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : undefined
  return { code, output: stripVTControlCharacters(output), result }
}

// Builds the site, serving `board` as the Greenhouse API, and returns the result of running `query`
// while the site creates its pages, along with what Gatsby printed
const build = async ({ board, boardToken = 'acme', query, clean = true }) => {
  const { code, output, result } = await gatsbyBuild({ routes: greenhouseRoutes(board, boardToken), boardToken, query, clean })
  assert.equal(code, 0, `gatsby build failed:\n${output}`)
  const { data, errors } = result
  assert.equal(errors, undefined, `the query failed:\n${JSON.stringify(errors, null, 2)}`)
  return { data, output }
}

const linksQuery = `{
  allGreenhouseOffice {
    nodes {
      gh_Id
      name
      parent { ... on GreenhouseOffice { gh_Id } }
      children { ... on GreenhouseOffice { gh_Id } }
      jobs { gh_Id }
    }
  }
  allGreenhouseDepartment {
    nodes {
      gh_Id
      name
      parent { ... on GreenhouseDepartment { gh_Id } }
      children { ... on GreenhouseDepartment { gh_Id } }
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
      departments { gh_Id }
      offices { gh_Id }
    }
  }
}`

// Greenhouse ids of linked nodes, in order. A node without links of a kind has null instead of a list.
const ids = nodes => (nodes || []).map(node => node.gh_Id).sort((a, b) => a - b)

// What the site sees of each office, department and job, keyed by Greenhouse id
const linksOf = data => {
  const byId = (nodes, describe) => Object.fromEntries(nodes.map(node => [node.gh_Id, describe(node)]))
  const tree = ({ name, parent, children, jobs }) => ({
    name, parent: parent && parent.gh_Id, children: ids(children), jobs: ids(jobs),
  })
  return {
    offices: byId(data.allGreenhouseOffice.nodes, tree),
    departments: byId(data.allGreenhouseDepartment.nodes, tree),
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

  assert.deepEqual(linksOf(data), {
    offices: {
      10: { name: 'Europe', parent: null, children: [11], jobs: [101, 102] },
      // including the job in "No Department"
      11: { name: 'Berlin', parent: 10, children: [], jobs: [100, 103] },
    },
    departments: {
      1: { name: 'Engineering', parent: null, children: [2, 3], jobs: [] },
      2: { name: 'Frontend', parent: 1, children: [], jobs: [100] },
      3: { name: 'Backend', parent: 1, children: [], jobs: [101] },
      4: { name: 'Sales', parent: null, children: [5], jobs: [] },
      5: { name: 'Account Management', parent: 4, children: [], jobs: [102] },
    },
    jobs: {
      100: { title: 'Frontend Engineer', departments: [2], offices: [11] },
      101: { title: 'Backend Engineer', departments: [3], offices: [10] },
      102: { title: 'Account Manager', departments: [5], offices: [10] },
      103: { title: 'Office Manager', departments: [], offices: [11] },
    },
  })

  const { updated_at, location, questions } = data.allGreenhouseJob.nodes.find(job => job.gh_Id === 100)
  assert.deepEqual({ updated_at, location, questions }, {
    updated_at: '2026-10-01',
    location: { name: 'Remote' },
    // no question of the board has a description
    questions: [{ required: true, label: 'First Name', description: null, fields: [{ name: 'first_name', type: 'input_text' }] }],
  })
})

test('a rebuild from the cache keeps offices and departments that changed, moved or lost a job', async () => {
  await build({ board: { offices, departments, jobs }, query: linksQuery })

  const { data, output } = await build({
    board: {
      offices: [
        offices[0],
        { ...offices[1], name: 'EMEA' },
      ],
      departments: [
        departments[0],
        { ...departments[1], name: 'Product Engineering', children: [2, 3, 5] },
        departments[2],
        // moved from Sales, which is gone
        { ...departments[3], parent: 1 },
      ],
      jobs,
      // closed after it was listed, so Backend and EMEA still list it
      missingJobs: [101],
    },
    query: linksQuery,
    clean: false,
  })

  assert.doesNotMatch(output, /deleting your site's\s+cache/, 'Gatsby did not use the cache')
  assert.match(output, /Skipping job 101 \(Backend Engineer\), since Greenhouse no longer has its details/)
  assert.deepEqual(linksOf(data), {
    offices: {
      10: { name: 'EMEA', parent: null, children: [11], jobs: [102] },
      11: { name: 'Berlin', parent: 10, children: [], jobs: [100, 103] },
    },
    departments: {
      1: { name: 'Product Engineering', parent: null, children: [2, 3, 5], jobs: [] },
      2: { name: 'Frontend', parent: 1, children: [], jobs: [100] },
      3: { name: 'Backend', parent: 1, children: [], jobs: [] },
      5: { name: 'Account Management', parent: 1, children: [], jobs: [102] },
    },
    jobs: {
      100: { title: 'Frontend Engineer', departments: [2], offices: [11] },
      102: { title: 'Account Manager', departments: [5], offices: [10] },
      103: { title: 'Office Manager', departments: [], offices: [11] },
    },
  })
})

test('a site can query a board that has no offices, departments or jobs', async () => {
  const { data } = await build({
    board: { offices: [], departments: [], jobs: [] },
    query: `{
      allGreenhouseOffice { nodes { name location departments { name } jobs { title } } }
      allGreenhouseDepartment { nodes { name jobs { title } } }
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
  const { code, output, result } = await gatsbyBuild({
    // what Greenhouse answers for a board that does not exist
    routes: { '/v1/boards/acme/offices/': { status: 404, body: { status: 404, error: 'Office not found' } } },
    query: '{ site { id } }',
    clean: true,
  })

  assert.notEqual(code, 0)
  assert.equal(result, undefined, 'the build went on to create pages')
  // Gatsby prints the message, and then the error again with its stack trace
  const messages = output.split('\n')
    .filter(line => line.includes('Failed to fetch') && !line.trimStart().startsWith('Error:'))
  assert.deepEqual(messages, [
    'error gatsby-source-greenhouse-job-board: Failed to fetch offices from Greenhouse API: ' +
      'Request to https://boards-api.greenhouse.io/v1/boards/acme/offices/ failed with HTTP status 404',
  ], output)
})
