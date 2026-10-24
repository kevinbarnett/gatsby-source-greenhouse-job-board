const { getNullableType, isListType, isObjectType } = require(`gatsby/graphql`)

// Fields that every board has, declared so that queries work even when a board has no jobs,
// or no job uses a field yet. Everything else, like the numeric ids, is still inferred from the
// data, since its type differs between boards.
exports.typeDefs = `
  type GreenhouseJob implements Node {
    title: String
    absolute_url: String
    content: String
    language: String
    company_name: String
    updated_at: Date @dateformat
    first_published: Date @dateformat
    location: GreenhouseJobLocation
    questions: [GreenhouseJobQuestions]
    metadata: [GreenhouseJobMetadata]
    departments: [GreenhouseDepartment] @link(from: "departments___NODE")
    offices: [GreenhouseOffice] @link(from: "offices___NODE")
  }

  type GreenhouseJobLocation {
    name: String
  }

  type GreenhouseJobQuestions {
    required: Boolean
    label: String
    description: String
    fields: [GreenhouseJobQuestionsFields]
  }

  type GreenhouseJobQuestionsFields {
    name: String
    type: String
  }

  # The types of id and value are inferred, see inferredFieldResolvers below
  type GreenhouseJobMetadata {
    name: String
    value_type: String
  }

  # Sub-departments and sub-offices are Gatsby children of their department or office. Declaring
  # that adds childrenGreenhouseDepartment and childGreenhouseDepartment, and the same for offices,
  # even to boards where no department or office has any.
  type GreenhouseDepartment implements Node @childOf(types: ["GreenhouseDepartment"]) {
    name: String
    jobs: [GreenhouseJob] @link(from: "jobs___NODE")
  }

  type GreenhouseOffice implements Node @childOf(types: ["GreenhouseOffice"]) {
    name: String
    location: String
    departments: [GreenhouseDepartment] @link(from: "departments___NODE")
    jobs: [GreenhouseJob] @link(from: "jobs___NODE")
  }
`

// A job metadata value is a string, a list, an object or something else, depending on its custom
// field's value_type. Its type is inferred from the board's data, as in earlier versions, since
// queries can depend on that type, like a filter with a String variable. Where inference fails,
// the fields get these types instead, and JSON returns each value as Greenhouse sends it. Inference
// fails when no job has a value, or when values have different types, like booleans and strings.
const fallbackTypes = { id: `Float`, value: `JSON` }

// Whether GraphQL can return the value as the type. Inference ignores empty lists and objects, so a
// value can still be one that it cannot, like [] where the type is String.
const fitsType = (value, type) => {
  if (value == null) {
    return true
  }
  const nullableType = getNullableType(type)
  if (isListType(nullableType)) {
    return Array.isArray(value) && value.every(item => fitsType(item, nullableType.ofType))
  }
  if (isObjectType(nullableType)) {
    return Object.values(nullableType.getFields()).every(field => fitsType(value[field.name], field.type))
  }
  // A scalar, like String, or an enum. GraphQL fails where it cannot serialize the value.
  try {
    nullableType.serialize(value)
    return true
  } catch {
    return false
  }
}

// For createResolvers, which gets the schema that Gatsby inferred from the jobs
exports.inferredFieldResolvers = (schema, jobs) => {
  const fields = schema.getType(`GreenhouseJobMetadata`).getFields()
  const resolvers = { GreenhouseJobMetadata: {} }

  for (const [name, type] of Object.entries(fallbackTypes)) {
    if (!fields[name]) {
      resolvers.GreenhouseJobMetadata[name] = { type }
    }
  }

  // Return null for a value that does not fit, as for a job without a value. This resolves the
  // metadata as a whole, and not just the value, since Gatsby then also resolves all of a filter on
  // the metadata, like one on both name and value.
  const fits = item => !item || !fields.value || fitsType(item.value, fields.value.type)
  if (jobs.some(job => !(job.metadata || []).every(fits))) {
    resolvers.GreenhouseJob = {
      metadata: {
        resolve: (source, args, context, info) => {
          const metadata = info.originalResolver(source, args, context, info)
          // Gatsby also calls this to filter and sort jobs, outside of a GraphQL query, and so
          // without info.path. Leave the metadata as it is there, so that filters work as before.
          if (!info.path || !Array.isArray(metadata)) {
            return metadata
          }
          return metadata.map(item => (fits(item) ? item : { ...item, value: null }))
        },
      },
    }
  }

  return resolvers
}
