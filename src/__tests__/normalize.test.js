const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const {
  filterResponseForIds,
  buildNodesFromResponse,
  createLinker,
  linkParentChildReferences,
  linkForeignReferences,
  addContentDigests,
} = require('../normalize')

const createNodeId = key => `id:${key}`
const createContentDigest = content => JSON.stringify(content)

const buildNodes = response => {
  let nodes = buildNodesFromResponse(response, createNodeId)
  const linkTo = createLinker(nodes, createNodeId)
  nodes = linkParentChildReferences(nodes, linkTo)
  nodes = linkForeignReferences(nodes, linkTo)
  return addContentDigests(nodes, createContentDigest)
}

const byId = (nodes, key) => nodes.find(node => node.id === createNodeId(key))

describe('filterResponseForIds', () => {
  test('leave out "No Office" and "No Department", which have an id of 0', () => {
    assert.deepEqual(filterResponseForIds([{ id: 0 }, { id: 1 }]), [{ id: 1 }])
  })

  test('keep the lists nested in an office as they are', () => {
    const offices = [{ id: 1, departments: [{ id: 0, jobs: [{ id: 5 }] }] }]
    const copy = structuredClone(offices)
    assert.deepEqual(filterResponseForIds(offices), copy)
    assert.deepEqual(offices, copy)
  })

  test('return an empty list for an empty or missing response', () => {
    assert.deepEqual(filterResponseForIds([]), [])
    assert.deepEqual(filterResponseForIds(undefined), [])
  })
})

describe('buildNodesFromResponse', () => {
  test('keep the Greenhouse id as gh_Id, as v1 did', () => {
    const [office, department, job] = buildNodesFromResponse({
      offices: [{ id: 1, name: 'Berlin' }],
      departments: [{ id: 2, name: 'Engineering' }],
      jobs: [{ id: 3, title: 'Engineer' }],
    }, createNodeId)
    assert.deepEqual(
      [office, department, job].map(node => [node.id, node.gh_Id, node.internal.type]),
      [
        ['id:GreenhouseOffice-1', 1, 'GreenhouseOffice'],
        ['id:GreenhouseDepartment-2', 2, 'GreenhouseDepartment'],
        ['id:GreenhouseJob-3', 3, 'GreenhouseJob'],
      ]
    )
  })
})

describe('linkParentChildReferences', () => {
  test('link parents and children that exist, and leave out the rest', () => {
    const nodes = buildNodes({
      departments: [
        { id: 1, parent_id: null, child_ids: [2, 99] },
        { id: 2, parent_id: 1, child_ids: [] },
        { id: 3, parent_id: 98, child_ids: [] },
      ],
    })
    const engineering = byId(nodes, 'GreenhouseDepartment-1')
    assert.deepEqual(engineering.children, [createNodeId('GreenhouseDepartment-2')])
    assert.equal(engineering.parent, null)
    assert.equal(byId(nodes, 'GreenhouseDepartment-2').parent, createNodeId('GreenhouseDepartment-1'))
    assert.equal(byId(nodes, 'GreenhouseDepartment-3').parent, null)
  })
})

describe('linkForeignReferences', () => {
  const response = () => ({
    offices: filterResponseForIds([
      {
        id: 10,
        departments: [
          { id: 1, jobs: [{ id: 100 }, { id: 101 }] },
          { id: 2, jobs: [{ id: 101 }] },
          { id: 0, name: 'No Department', jobs: [{ id: 102 }] },
        ],
      },
      { id: 11, departments: [] },
      { id: 12, departments: [{ id: 2, jobs: [] }, { id: 0, name: 'No Department', jobs: [] }] },
      { id: 13, departments: [{ id: 0, name: 'No Department', jobs: [{ id: 102 }] }] },
    ]),
    departments: filterResponseForIds([
      { id: 1, jobs: [{ id: 100 }, { id: 101 }, { id: 404 }] },
      { id: 2, jobs: [] },
      { id: 3, jobs: [{ id: 404 }] },
      { id: 0, name: 'No Department', jobs: [{ id: 102 }] },
    ]),
    jobs: [
      { id: 100, departments: [{ id: 1 }], offices: [{ id: 10 }, { id: 404 }] },
      { id: 101, departments: [{ id: 1 }, { id: 2 }], offices: [{ id: 10 }] },
      { id: 102, departments: [], offices: [{ id: 10 }, { id: 13 }] },
      { id: 103, departments: [{ id: 404 }], offices: [{ id: 404 }] },
    ],
  })

  test('link an office to the jobs of all its departments, including "No Department", once each', () => {
    const office = byId(buildNodes(response()), 'GreenhouseOffice-10')
    assert.deepEqual(office.departments___NODE, ['GreenhouseDepartment-1', 'GreenhouseDepartment-2'].map(createNodeId))
    assert.deepEqual(office.jobs___NODE, ['GreenhouseJob-100', 'GreenhouseJob-101', 'GreenhouseJob-102'].map(createNodeId))
  })

  test('link only to nodes that exist', () => {
    const nodes = buildNodes(response())
    assert.deepEqual(byId(nodes, 'GreenhouseDepartment-1').jobs___NODE, ['GreenhouseJob-100', 'GreenhouseJob-101'].map(createNodeId))
    assert.deepEqual(byId(nodes, 'GreenhouseJob-100').offices___NODE, [createNodeId('GreenhouseOffice-10')])
  })

  test('replace the nested lists with links, and leave out links for empty lists', () => {
    const nodes = buildNodes(response())
    for (const node of nodes) {
      assert.equal('jobs' in node || 'departments' in node || 'offices' in node, false, node.id)
    }
    assert.equal('departments___NODE' in byId(nodes, 'GreenhouseOffice-11'), false)
    assert.equal('jobs___NODE' in byId(nodes, 'GreenhouseOffice-11'), false)
    assert.equal('jobs___NODE' in byId(nodes, 'GreenhouseDepartment-2'), false)
    assert.equal('departments___NODE' in byId(nodes, 'GreenhouseJob-102'), false)
  })

  test('leave out links that only list nodes that do not exist, the same as links to empty lists', () => {
    const nodes = buildNodes(response())
    assert.equal('jobs___NODE' in byId(nodes, 'GreenhouseDepartment-3'), false)
    assert.equal('departments___NODE' in byId(nodes, 'GreenhouseJob-103'), false)
    assert.equal('offices___NODE' in byId(nodes, 'GreenhouseJob-103'), false)
  })

  test('link an office with departments to a list of jobs, even an empty one, as 2.0 did', () => {
    const office = byId(buildNodes(response()), 'GreenhouseOffice-12')
    assert.deepEqual(office.departments___NODE, [createNodeId('GreenhouseDepartment-2')])
    assert.deepEqual(office.jobs___NODE, [])
  })

  test('link an office to the jobs in its "No Department", even when it has no other department', () => {
    const office = byId(buildNodes(response()), 'GreenhouseOffice-13')
    assert.equal('departments___NODE' in office, false)
    assert.deepEqual(office.jobs___NODE, [createNodeId('GreenhouseJob-102')])
  })

  test('leave the API response as it is', () => {
    const input = response()
    const copy = structuredClone(input)
    buildNodes(input)
    assert.deepEqual(input, copy)
  })
})

describe('addContentDigests', () => {
  test('cover the links, so a cached node changes when only its links do', () => {
    // the department lists job 100 either way, but only links to it while the job exists
    const department = jobs => byId(buildNodes({ departments: [{ id: 1, jobs: [{ id: 100 }] }], jobs }), 'GreenhouseDepartment-1')
    assert.notEqual(department([{ id: 100 }]).internal.contentDigest, department([]).internal.contentDigest)
  })

  test('leave out the internal fields', () => {
    const [node] = buildNodes({ departments: [{ id: 1, name: 'Engineering' }] })
    const { internal, ...content } = node
    assert.equal(internal.contentDigest, createContentDigest(content))
  })
})
