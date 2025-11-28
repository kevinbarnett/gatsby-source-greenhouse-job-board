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
    const nodeId = createNodeId(`${typePrefix}${type}-${data.id}`)
    return {
      ...data,
      id: nodeId,
      parent: null,
      children: [],
      internal: {
        type: `${typePrefix}${type}`,
        contentDigest: require('crypto')
          .createHash('md5')
          .update(JSON.stringify(data))
          .digest('hex'),
      },
    }
  }
}

const isNotEmpty = (arr) => {
  return Boolean(arr && Array.isArray(arr) && arr.length)
}

const filterResponseForIds = (response) => {
  if (isNotEmpty(response)) {
    return response.filter(obj => {
      if (obj.departments) {
        // recurse over nested department lists
        obj.departments = filterResponseForIds(obj.departments)
      }
      return Boolean(obj && obj.id)
    })
  }
}

exports.filterResponseForIds = filterResponseForIds

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
  return nodes.map(node => {
    const type = String(node.internal.type).replace(typePrefix, '')
    // look for nodes with child ids (set by Greenhouse)
    if (isNotEmpty(node.child_ids)) {
      node.children = node.child_ids.map(id => {
        return createNodeId(`${typePrefix}${type}-${id}`)
      })
    }
    // look for nodes with a parent id (set by Greenhouse)
    if (node.parent_id) {
      node.parent = createNodeId(`${typePrefix}${type}-${node.parent_id}`)
    }

    return node
  })
}

// https://www.gatsbyjs.org/docs/schema-gql-type/#foreign-key-reference-___node
exports.linkForeignReferences = (nodes, createNodeId) => {
  return nodes.map(node => {

    // look for office nodes
    if (node.internal.type === 'GreenhouseOffice') {
      // look for departments nested in the office nodes
      if (isNotEmpty(node.departments)) {
        let officeJobNodeIds = new Array
        // iterate on the list of departments and capture their node ids
        const officeDepartmentNodeIds = node.departments.map(department => {
          // look for jobs nested in the department node
          if (isNotEmpty(department.jobs)) {
            // iterate on the list of jobs and capture their node ids
            const jobNodeIds = department.jobs.map(job => {
              return createNodeId(`${typePrefix}Job-${job.id}`)
            })
            officeJobNodeIds = officeJobNodeIds.concat(jobNodeIds)
            // remove the element as it will be rebuilt by Gatsby
            delete department.jobs
          }
          return createNodeId(`${typePrefix}Department-${department.id}`)
        })
        // remove the element as it will be rebuilt by Gatsby
        delete node.departments
        // link the office to its departments
        node.departments___NODE = officeDepartmentNodeIds
        // link the offices to its jobs
        node.jobs___NODE = officeJobNodeIds
      }
    }

    // look for department nodes
    if (node.internal.type === 'GreenhouseDepartment') {
      // look for jobs nested in the department nodes
      if (isNotEmpty(node.jobs)) {
        // iterate on the list of jobs and capture their node ids
        const departmentJobNodeIds = node.jobs.map(job => {
          return createNodeId(`${typePrefix}Job-${job.id}`)
        })
        // remove the element as it will be rebuilt by Gatsby
        delete node.jobs
        // link the department to its jobs
        node.jobs___NODE = departmentJobNodeIds
      }
    }

    // look for job nodes
    if (node.internal.type === 'GreenhouseJob') {
      // look for departments nested in the job nodes
      if (isNotEmpty(node.departments)) {
        // iterate on the list of the departments and capture their node ids
        const jobDepartmentNodeIds = node.departments.map(department => {
          return createNodeId(`${typePrefix}Department-${department.id}`)
        })
        // remove the element as it will be rebuilt by Gatsby
        delete node.departments
        // link the job to its department(s)
        node.departments___NODE = jobDepartmentNodeIds
      }
      // look for offices nested in the job nodes
      if (isNotEmpty(node.offices)) {
        // iterate on the list of offices and capture their node ids
        const jobOfficeNodeIds = node.offices.map(office => {
          return createNodeId(`${typePrefix}Office-${office.id}`)
        })
        // remove the element as it will be rebuilt by Gatsby
        delete node.offices
        // link the job to its office(s)
        node.offices___NODE = jobOfficeNodeIds
      }
    }

    return node
  })
}