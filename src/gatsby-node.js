const {
  fetchJobs,
  fetchOffices,
  fetchDepartments
} = require('./fetch')

const {
  filterResponseForIds,
  buildNodesFromResponse,
  createLinker,
  linkParentChildReferences,
  linkForeignReferences,
  addContentDigests
} = require(`./normalize`)

const { typeDefs } = require(`./schema`)

const chalk = require('chalk')

exports.pluginOptionsSchema = ({ Joi }) => {
  return Joi.object({
    // earlier versions used the token as it was, so a number keeps working. A blank token, or a number
    // below 1 or with a fraction, never fetched a board, so it is rejected, and spaces around the token,
    // which would end up in the URL, are trimmed.
    boardToken: Joi.alternatives()
      .try(Joi.string().trim(), Joi.number().integer().positive())
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
    timeout: Joi.number()
      .integer()
      .min(1)
      // the longest timer Node.js has. It would time out after 1ms instead of waiting any longer.
      .max(2147483647)
      .description(
        `How many milliseconds to wait for each request to Greenhouse before trying it again. ` +
        `Defaults to 90000. Greenhouse can take about a minute to send the offices list of a big board.`
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
// The parents are found in the node store, which is what Gatsby cleans up, rather than in a list the
// plugin would have to keep, which a node store from 2.0 would not have. A site can source several
// boards, whose nodes share the node store, so only parents of this board's nodes are deleted.
const deleteChangedParents = (nodes, { getNode, getNodesByType, deleteNode }) => {
  const digests = new Map(nodes.map(node => [node.id, node.internal.contentDigest]))

  // whether Gatsby would delete one of this board's nodes along with the cached node, looking through
  // the cached children the way Gatsby does
  const hasChildOfThisBoard = node => {
    const queue = [...node.children]
    const seen = new Set()
    while (queue.length) {
      const id = queue.pop()
      if (seen.has(id)) continue
      seen.add(id)
      if (digests.has(id)) return true
      const child = getNode(id)
      if (child) queue.push(...child.children)
    }
    return false
  }

  const changedParents = [`GreenhouseOffice`, `GreenhouseDepartment`]
    .flatMap(type => getNodesByType(type))
    .filter(node => digests.get(node.id) !== node.internal.contentDigest && hasChildOfThisBoard(node))

  for (const { id } of changedParents) {
    // deleting a node also deletes its children, so check the node is still there
    const cachedNode = getNode(id)
    if (cachedNode) {
      deleteNode(cachedNode)
    }
  }
}

exports.sourceNodes = async ({ actions, createNodeId, createContentDigest, getNode, getNodesByType, reporter }, pluginOptions) => {
  const { createNode, deleteNode } = actions
  const { boardToken, requestsPerMinute, timeout } = pluginOptions
  // an option the site did not set is undefined, which keeps the default
  const fetchOptions = { requestsPerMinute, timeout }

  let offices, departments, jobs
  let nodes

  try {
    // Fetch data from the Greenhouse APIs
    reporter.info(chalk.blue('Fetching data from Greenhouse API...'))
    // The lists do not depend on each other, so fetch them at once. Wait for all of them, even after
    // one fails, so that nothing is still fetching once the build stops, and report the first that
    // failed in this order, whichever failed first.
    const results = await Promise.allSettled([
      fetchOffices(boardToken, fetchOptions),
      fetchDepartments(boardToken, fetchOptions),
      fetchJobs(boardToken, {
        ...fetchOptions,
        onMissingJob: job => reporter.warn(
          `gatsby-source-greenhouse-job-board: Skipping job ${job.id} (${job.title}), since Greenhouse no longer has its details`
        ),
      }),
    ])
    const failure = results.find(result => result.status === `rejected`)
    if (failure) {
      throw failure.reason
    }
    offices = results[0].value
    departments = results[1].value
    jobs = results[2].value
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
  const linkTo = createLinker(nodes, createNodeId)

  // Link Offices to their parents/children
  // Link Departments to their parents/children
  nodes = linkParentChildReferences(nodes, linkTo)

  // Link Offices to Departments and Jobs
  // Link Departments to Jobs
  // Link Jobs to Departments and Offices
  nodes = linkForeignReferences(nodes, linkTo)

  nodes = addContentDigests(nodes, createContentDigest)

  deleteChangedParents(nodes, { getNode, getNodesByType, deleteNode })

  // Create the nodes with Gatsby
  await Promise.all(
    nodes.map(async node => createNode(node))
  )

  reporter.info(chalk.green(`Created ${chalk.bold(nodes.length)} nodes from Greenhouse API`))
}
