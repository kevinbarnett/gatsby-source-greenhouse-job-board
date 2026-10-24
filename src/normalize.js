const typePrefix = `Greenhouse`
const types = {
  job: 'Job',
  office: 'Office',
  department: 'Department'
}

// Modern Gatsby node creation without gatsby-node-helpers
// Uses Gatsby's native createNodeId and standard node structure
const createNodeFactory = (type, createNodeId) => {
  return (data) => {
    return {
      ...data,
      // Gatsby uses `id` for its own node id, so keep the Greenhouse id where v1 put it
      gh_Id: data.id,
      id: createNodeId(`${typePrefix}${type}-${data.id}`),
      parent: null,
      children: [],
      internal: {
        type: `${typePrefix}${type}`,
      },
    }
  }
}

const isNotEmpty = (arr) => {
  return Boolean(arr && Array.isArray(arr) && arr.length)
}

const greenhouseIds = (objects) => objects.map(obj => obj.id)

// Returns a function that turns Greenhouse ids into node ids, leaving out duplicates and ids
// that have no node, such as "No Department" or a job that closed while the plugin was fetching
const createLinker = (nodes, createNodeId) => {
  const nodeIds = new Set(nodes.map(node => node.id))
  return (type, ids) => {
    const linkedIds = ids.map(id => createNodeId(`${typePrefix}${type}-${id}`))
    return [...new Set(linkedIds)].filter(id => nodeIds.has(id))
  }
}

// Greenhouse API will return "No Office" and "No Department" entities with an ID of 0. Let's remove these.
// Only the top level is filtered, so an office still links to the jobs listed under its "No Department".
exports.filterResponseForIds = (response) => {
  return isNotEmpty(response) ? response.filter(obj => Boolean(obj && obj.id)) : []
}

exports.buildNodesFromResponse = (response, createNodeId) => {
  let nodes = new Array

  const JobNode = createNodeFactory(types.job, createNodeId)
  const OfficeNode = createNodeFactory(types.office, createNodeId)
  const DepartmentNode = createNodeFactory(types.department, createNodeId)

  if (isNotEmpty(response.offices)) {
    const officeNodes = response.offices.map(office => {
      return OfficeNode(office)
    })
    nodes = nodes.concat(officeNodes)
  }

  if (isNotEmpty(response.departments)) {
    const departmentNodes = response.departments.map(department => {
      return DepartmentNode(department)
    })
    nodes = nodes.concat(departmentNodes)
  }

  if (isNotEmpty(response.jobs)) {
    const jobNodes = response.jobs.map(job => {
      return JobNode(job)
    })
    nodes = nodes.concat(jobNodes)
  }

  return nodes
}

exports.linkParentChildReferences = (nodes, createNodeId) => {
  const linkTo = createLinker(nodes, createNodeId)

  return nodes.map(node => {
    const type = String(node.internal.type).replace(typePrefix, '')
    // look for nodes with child ids (set by Greenhouse)
    if (isNotEmpty(node.child_ids)) {
      node.children = linkTo(type, node.child_ids)
    }
    // look for nodes with a parent id (set by Greenhouse)
    if (node.parent_id) {
      node.parent = linkTo(type, [node.parent_id])[0] || null
    }

    return node
  })
}

// https://www.gatsbyjs.com/docs/reference/graphql-data-layer/schema-customization/#foreign-key-fields
exports.linkForeignReferences = (nodes, createNodeId) => {
  const linkTo = createLinker(nodes, createNodeId)

  return nodes.map(node => {

    // look for office nodes
    if (node.internal.type === `${typePrefix}${types.office}`) {
      const { departments } = node
      // remove the element as it will be rebuilt by Gatsby
      delete node.departments
      // look for departments nested in the office nodes
      if (isNotEmpty(departments)) {
        // capture the jobs of every department, including "No Department"
        const jobs = departments.flatMap(department => department.jobs || [])
        // link the office to its departments
        node.departments___NODE = linkTo(types.department, greenhouseIds(departments))
        // link the offices to its jobs
        node.jobs___NODE = linkTo(types.job, greenhouseIds(jobs))
      }
    }

    // look for department nodes
    if (node.internal.type === `${typePrefix}${types.department}`) {
      const { jobs } = node
      // remove the element as it will be rebuilt by Gatsby
      delete node.jobs
      // look for jobs nested in the department nodes
      if (isNotEmpty(jobs)) {
        // link the department to its jobs
        node.jobs___NODE = linkTo(types.job, greenhouseIds(jobs))
      }
    }

    // look for job nodes
    if (node.internal.type === `${typePrefix}${types.job}`) {
      const { departments, offices } = node
      // remove the elements as they will be rebuilt by Gatsby
      delete node.departments
      delete node.offices
      // look for departments nested in the job nodes
      if (isNotEmpty(departments)) {
        // link the job to its department(s)
        node.departments___NODE = linkTo(types.department, greenhouseIds(departments))
      }
      // look for offices nested in the job nodes
      if (isNotEmpty(offices)) {
        // link the job to its office(s)
        node.offices___NODE = linkTo(types.office, greenhouseIds(offices))
      }
    }

    return node
  })
}

// Gatsby keeps a cached node as it is unless its digest changes, so the digest has to cover
// everything on the node, including the links added above
exports.addContentDigests = (nodes, createContentDigest) => {
  return nodes.map(node => {
    const { internal, ...content } = node
    return {
      ...node,
      internal: {
        ...internal,
        contentDigest: createContentDigest(content),
      },
    }
  })
}
