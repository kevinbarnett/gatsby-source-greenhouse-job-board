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

const chalk = require('chalk')

exports.sourceNodes = async ({ actions, createNodeId, reporter }, pluginOptions) => {
  const { createNode } = actions
  const { boardToken } = pluginOptions

  if (!boardToken) {
    reporter.panic(
      chalk.red.bold('gatsby-source-greenhouse-job-board: Missing required option "boardToken"')
    )
  }

  let offices, departments, jobs
  let nodes

  try {
    // Fetch data from the Greenhouse APIs
    reporter.info(chalk.blue('Fetching data from Greenhouse API...'))
    offices = await fetchOffices(boardToken)
    departments = await fetchDepartments(boardToken)
    jobs = await fetchJobs(boardToken)

  } catch (error) {
    reporter.panic(
      chalk.red.bold(`gatsby-source-greenhouse-job-board: Failed to fetch data from Greenhouse API\n${error.message}`),
      error
    )
  }

  reporter.info(
    chalk.blue('info') + ' fetched from Greenhouse API:\n' +
    `  ${chalk.bold(jobs.length)} jobs,\n` +
    `  ${chalk.bold(offices.length)} offices,\n` +
    `  ${chalk.bold(departments.length)} departments`
  )

  // Greenhouse API will return "No Office" and "No Department" entities with an ID of 0. Let's remove these.
  offices = filterResponseForIds(offices) || []
  departments = filterResponseForIds(departments) || []
  jobs = filterResponseForIds(jobs) || []

  // Construct the node objects from the API responses
  nodes = buildNodesFromResponse({ offices, departments, jobs }, createNodeId)

  // Link Offices to their parents/children
  // Link Departments to their parents/children
  nodes = linkParentChildReferences(nodes, createNodeId)

  // Link Offices to Departments and Jobs
  // Link Departments to Jobs
  // Link Jobs to Departments and Offices
  nodes = linkForeignReferences(nodes, createNodeId)

  // Create the nodes with Gatsby
  await Promise.all(
    nodes.map(async node => createNode(node))
  )

  reporter.info(chalk.green(`Created ${chalk.bold(nodes.length)} nodes from Greenhouse API`))
}