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

// Greenhouse ids, leaving out "No Office" and "No Department", which have an id of 0
const greenhouseIds = (objects) => (objects || []).filter(obj => Boolean(obj && obj.id)).map(obj => obj.id)

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

// Returns a function that turns Greenhouse ids into node ids, leaving out duplicates and ids
// that have no node, such as a job that closed while the plugin was fetching
exports.createLinker = (nodes, createNodeId) => {
  const nodeIds = new Set(nodes.map(node => node.id))
  return (type, ids) => {
    const linkedIds = ids.map(id => createNodeId(`${typePrefix}${type}-${id}`))
    return [...new Set(linkedIds)].filter(id => nodeIds.has(id))
  }
}

exports.linkParentChildReferences = (nodes, linkTo) => {
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
exports.linkForeignReferences = (nodes, linkTo) => {
  // Links a node to what Greenhouse listed for it, leaving out what has no node. A node that Greenhouse
  // listed nothing for gets no link, so a site gets null, while one whose listed things all have no node
  // gets an empty list, as 2.0 did
  const setLinks = (node, field, type, ids) => {
    if (ids.length) {
      node[`${field}___NODE`] = linkTo(type, ids)
    }
  }

  return nodes.map(node => {

    // look for office nodes
    if (node.internal.type === `${typePrefix}${types.office}`) {
      const { departments } = node
      // remove the element as it will be rebuilt by Gatsby
      delete node.departments
      // capture the jobs of every department nested in the office, including "No Department"
      const jobs = (departments || []).flatMap(department => department.jobs || [])
      const departmentIds = greenhouseIds(departments)
      const jobIds = greenhouseIds(jobs)
      // link the office to its departments
      setLinks(node, 'departments', types.department, departmentIds)
      // link the office to its jobs, as a list even when it is empty for an office with departments,
      // as 2.0 did
      if (departmentIds.length || jobIds.length) {
        node.jobs___NODE = linkTo(types.job, jobIds)
      }
    }

    // look for department nodes
    if (node.internal.type === `${typePrefix}${types.department}`) {
      const { jobs } = node
      // remove the element as it will be rebuilt by Gatsby
      delete node.jobs
      // link the department to the jobs nested in it
      setLinks(node, 'jobs', types.job, greenhouseIds(jobs))
    }

    // look for job nodes
    if (node.internal.type === `${typePrefix}${types.job}`) {
      const { departments, offices } = node
      // remove the elements as they will be rebuilt by Gatsby
      delete node.departments
      delete node.offices
      // link the job to the department(s) and office(s) nested in it
      setLinks(node, 'departments', types.department, greenhouseIds(departments))
      setLinks(node, 'offices', types.office, greenhouseIds(offices))
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
