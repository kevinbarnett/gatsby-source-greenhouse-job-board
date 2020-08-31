const {
  fetchJobs,
  fetchOffices,
  fetchDepartments
} = require('./fetch')

const {
  filterResponseForIds,
  buildNodesFromResponse,
  linkParentChildReferences,
  linkForeignReferences
} = require(`./normalize`)

const chalk = require('chalk');
const log = (message) => console.log('\n',message);

exports.sourceNodes = async (gatsby, pluginOptions) => {
  const { actions } = gatsby
  const { createNode } = actions
  const { boardToken, boardTokens = [] } = pluginOptions

  let offices, departments, jobs
  let nodes

  let boards = [];

  if (!!boardToken) {
    log(`${chalk.blue('info')} boardToken has been deprecated. Use 'boardTokens: ['boardToken]' instead.`);
    boards = [boardToken];
  } else {
    boards = [...boardTokens];
  }

  try {
    // Fetch data from the Greenhouse APIs
    offices = await fetchOffices(boards)
    departments = await fetchDepartments(boards)
    jobs = await fetchJobs(boards)
  } catch (error) {
    log(`
      ${chalk.red.bold('error')} Fetching data from Greenhouse failed
    `)
    process.exit(1)
  }

  log(`
    ${chalk.blue('info')} fetched from Greenhouse API:
    ${chalk.bold(jobs.length)} jobs,
    ${chalk.bold(offices.length)} offices,
    ${chalk.bold(departments.length)} departments
  `)

  // Greenhouse API will return "No Office" and "No Department" entities with an ID of 0. Let's remove these.
  offices = filterResponseForIds(offices)
  departments = filterResponseForIds(departments)
  jobs = filterResponseForIds(jobs)

  // Construct the node objects from the API responses
  nodes = buildNodesFromResponse({offices, departments, jobs})

  // Link Offices to their parents/children
  // Link Departments to their parents/children
  nodes = linkParentChildReferences(nodes)

  // Link Offices to Departments and Jobs
  // Link Departments to Jobs
  // Link Jobs to Departments and Offices
  nodes = linkForeignReferences(nodes)

  // Create the nodes with Gatsby
  await Promise.all(
    nodes.map(async node => createNode(node))
  )

  return

}