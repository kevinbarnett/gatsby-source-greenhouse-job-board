const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSchema } = require('gatsby/graphql')

const { inferredFieldResolvers } = require('../schema')

// A schema like the one Gatsby infers, where GreenhouseJobMetadata also has the given fields.
// JSON and Level stand in for types that a site declares itself.
const schemaWith = metadataFields =>
  buildSchema(`
    scalar JSON
    enum Level { HIGH LOW }
    type GreenhouseJobMetadataValue { unit: String amount: String }
    type GreenhouseJobMetadata { name: String value_type: String ${metadataFields} }
    type Query { metadata: [GreenhouseJobMetadata] }
  `)

const stringValues = schemaWith('id: Float value: String')

// Calls the metadata resolver the way GraphQL does in a query, or with `path: undefined` the way
// Gatsby does while it filters and sorts jobs
const resolveMetadata = (resolvers, job, info = { path: { key: 'metadata' } }) =>
  resolvers.GreenhouseJob.metadata.resolve(job, {}, {}, { originalResolver: source => source.metadata, ...info })

const discordJob = {
  metadata: [
    { id: 1, name: 'Featured on Website', value_type: 'multi_select', value: [] },
    { id: 2, name: 'Careers Site Department', value_type: 'single_select', value: 'Engineering' },
    { id: 3, name: 'Team', value_type: 'single_select', value: null },
  ],
}

describe('inferredFieldResolvers', () => {
  test('type id and value where inference found no type, so value returns each value as it is', () => {
    const jobs = [{ metadata: [{ name: 'Remote', value_type: 'yes_no', value: true }] }, { metadata: null }]
    assert.deepEqual(inferredFieldResolvers(schemaWith(''), jobs), {
      GreenhouseJobMetadata: { id: { type: 'Float' }, value: { type: 'JSON' } },
    })
  })

  test('keep the inferred types, and resolve nothing when every value fits them', () => {
    const jobs = [
      { metadata: [{ id: 1, name: 'Team', value: 'Data' }, { id: 2, name: 'Level', value: null }, null] },
      { metadata: [] },
      { metadata: null },
      {},
    ]
    assert.deepEqual(inferredFieldResolvers(stringValues, jobs), { GreenhouseJobMetadata: {} })
  })

  test('return null in queries for a value that GraphQL cannot return as the inferred type', () => {
    const resolvers = inferredFieldResolvers(stringValues, [discordJob])
    assert.deepEqual(resolvers.GreenhouseJobMetadata, {})
    assert.deepEqual(resolveMetadata(resolvers, discordJob), [
      { id: 1, name: 'Featured on Website', value_type: 'multi_select', value: null },
      { id: 2, name: 'Careers Site Department', value_type: 'single_select', value: 'Engineering' },
      { id: 3, name: 'Team', value_type: 'single_select', value: null },
    ])
    assert.equal(resolveMetadata(resolvers, { metadata: null }), null)
  })

  test('leave the metadata as it is while Gatsby filters and sorts jobs, so filters work as before', () => {
    const resolvers = inferredFieldResolvers(stringValues, [discordJob])
    assert.equal(resolveMetadata(resolvers, discordJob, { path: undefined }), discordJob.metadata)
  })

  test('only resolve values that GraphQL cannot return as their type', () => {
    const cases = [
      ['String', [], false],
      ['String', {}, false],
      ['String', 5, true],
      ['Float', 'five', false],
      ['[String]', 'Engineering', false],
      ['[String]', [[]], false],
      ['[String]', ['Engineering', null], true],
      // GraphQL gives the fields of a list or an empty object the value null
      ['GreenhouseJobMetadataValue', [], true],
      ['GreenhouseJobMetadataValue', {}, true],
      ['GreenhouseJobMetadataValue', { unit: 'USD', amount: '100.0' }, true],
      ['GreenhouseJobMetadataValue', { unit: 'USD', amount: [] }, false],
      ['JSON', [], true],
      ['Level', 'HIGH', true],
      ['Level', 'MEDIUM', false],
    ]
    for (const [type, value, fits] of cases) {
      const resolvers = inferredFieldResolvers(schemaWith(`id: Float value: ${type}`), [{ metadata: [{ value }] }])
      assert.equal('GreenhouseJob' in resolvers, !fits, `${JSON.stringify(value)} as ${type}`)
    }
  })
})
