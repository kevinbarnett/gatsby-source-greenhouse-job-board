const {
  fetchJobs,
  fetchOffices,
  fetchDepartments
} = require('./fetch')

const {
  filterResponseForIds,
  buildNodesFromResponse,
  linkParentChildReferences,
  linkForeignReferences,
  addContentDigests
} = require(`./normalize`)

const { typeDefs } = require(`./schema`)

const chalk = require('chalk')

exports.pluginOptionsSchema = ({ Joi }) => {
  return Joi.object({
    // earlier versions used the token as it was, so a number keeps working
    boardToken: Joi.alternatives()
      .try(Joi.string(), Joi.number())
      .required()
      .description(`Your Greenhouse job board token, listed under Configure > Dev Center > Configure Job Board`),
    // optional, since fetch.js has the default
    requestsPerMinute: Joi.number()
      .integer()
      .min(1)
      .description(
        `The most requests to send to Greenhouse in any minute, counting every board in the build. ` +
        `Defaults to 2000. Greenhouse blocks an IP address for about a minute once it sends a few thousand.`
      ),
  })
}

exports.createSchemaCustomization = ({ actions }) => {
  actions.createTypes(typeDefs)
}

// Offices and departments store their Greenhouse sub-offices and sub-departments as Gatsby children.
// Gatsby deletes the children of a cached node when the node changes or goes away, which would delete
// children created before their parent, or moved to another parent. Deleting those parents before
// creating anything means Gatsby has no cached version of them left to clean up.
const deleteChangedParents = (nodes, { getNode, getNodesByType, deleteNode }) => {
  const digests = new Map(nodes.map(node => [node.id, node.internal.contentDigest]))

  for (const type of [`GreenhouseOffice`, `GreenhouseDepartment`]) {
    for (const cachedNode of getNodesByType(type)) {
      const changed = digests.get(cachedNode.id) !== cachedNode.internal.contentDigest
      // deleting a node also deletes its children, so check the node is still there
      const node = changed && cachedNode.children.length > 0 && getNode(cachedNode.id)
      if (node) {
        deleteNode(node)
      }
    }
  }
}

exports.sourceNodes = async ({ actions, createNodeId, createContentDigest, getNode, getNodesByType, reporter }, pluginOptions) => {
  const { createNode, deleteNode } = actions
  const { boardToken, requestsPerMinute } = pluginOptions
  // an option the site did not set is undefined, which keeps the default
  const fetchOptions = { requestsPerMinute }

  let offices, departments, jobs
  let nodes

  try {
    // Fetch data from the Greenhouse APIs
    reporter.info(chalk.blue('Fetching data from Greenhouse API...'))
    offices = await fetchOffices(boardToken, fetchOptions)
    departments = await fetchDepartments(boardToken, fetchOptions)
    jobs = await fetchJobs(boardToken, {
      ...fetchOptions,
      onMissingJob: job => reporter.warn(
        `gatsby-source-greenhouse-job-board: Skipping job ${job.id} (${job.title}), since Greenhouse no longer has its details`
      ),
    })

  } catch (error) {
    // Gatsby adds the error's message, which already says what failed to fetch
    reporter.panic(chalk.red.bold(`gatsby-source-greenhouse-job-board:`), error)
    return
  }

  // Greenhouse API will return "No Office" and "No Department" entities with an ID of 0. Let's remove these.
  offices = filterResponseForIds(offices)
  departments = filterResponseForIds(departments)
  jobs = filterResponseForIds(jobs)

  reporter.info(
    'Fetched from Greenhouse API:\n' +
    `  ${chalk.bold(jobs.length)} jobs,\n` +
    `  ${chalk.bold(offices.length)} offices,\n` +
    `  ${chalk.bold(departments.length)} departments`
  )

  // Construct the node objects from the API responses
  nodes = buildNodesFromResponse({ offices, departments, jobs }, createNodeId)

  // Link Offices to their parents/children
  // Link Departments to their parents/children
  nodes = linkParentChildReferences(nodes, createNodeId)

  // Link Offices to Departments and Jobs
  // Link Departments to Jobs
  // Link Jobs to Departments and Offices
  nodes = linkForeignReferences(nodes, createNodeId)

  nodes = addContentDigests(nodes, createContentDigest)

  deleteChangedParents(nodes, { getNode, getNodesByType, deleteNode })

  // Create the nodes with Gatsby
  await Promise.all(
    nodes.map(async node => createNode(node))
  )

  reporter.info(chalk.green(`Created ${chalk.bold(nodes.length)} nodes from Greenhouse API`))
}
